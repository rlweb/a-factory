package exe

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// startFakeSSHServer starts an in-process SSH server on 127.0.0.1 that
// accepts any public key and runs handler for every "exec" request,
// returning (stdout, exitCode). It gives SSHAdminClient a real, local,
// self-contained SSH endpoint to test against — no real network access.
func startFakeSSHServer(t *testing.T, handler func(command string) (stdout string, exitCode int)) (host string, port int, hostKeyCallback ssh.HostKeyCallback) {
	t.Helper()

	hostKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostKey)
	if err != nil {
		t.Fatalf("signer from host key: %v", err)
	}

	config := &ssh.ServerConfig{
		PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) {
			return &ssh.Permissions{}, nil // fake accepts any key
		},
	}
	config.AddHostKey(hostSigner)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	go func() {
		for {
			nConn, err := listener.Accept()
			if err != nil {
				return
			}
			go serveFakeSSHConn(nConn, config, handler)
		}
	}()

	addr := listener.Addr().(*net.TCPAddr)
	return addr.IP.String(), addr.Port, ssh.FixedHostKey(hostSigner.PublicKey())
}

func serveFakeSSHConn(nConn net.Conn, config *ssh.ServerConfig, handler func(string) (string, int)) {
	sshConn, chans, reqs, err := ssh.NewServerConn(nConn, config)
	if err != nil {
		return
	}
	defer func() { _ = sshConn.Close() }()
	go ssh.DiscardRequests(reqs)

	for newChannel := range chans {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		channel, requests, err := newChannel.Accept()
		if err != nil {
			return
		}
		go serveFakeSSHSession(channel, requests, handler)
	}
}

func serveFakeSSHSession(channel ssh.Channel, requests <-chan *ssh.Request, handler func(string) (string, int)) {
	defer func() { _ = channel.Close() }()
	for req := range requests {
		if req.Type != "exec" {
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
			continue
		}
		var payload struct{ Command string }
		_ = ssh.Unmarshal(req.Payload, &payload)

		stdout, exitCode := handler(payload.Command)
		_, _ = channel.Write([]byte(stdout))
		_ = req.Reply(true, nil)
		_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(&struct{ Status uint32 }{uint32(exitCode)}))
		return
	}
}

func testSigner(t *testing.T) ssh.Signer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate client key: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatalf("signer from client key: %v", err)
	}
	return signer
}

func TestSSHAdminClientExec(t *testing.T) {
	var gotCommand string
	host, port, hostKeyCallback := startFakeSSHServer(t, func(command string) (string, int) {
		gotCommand = command
		return "Email Address: test@example.com\n", 0
	})

	c := &SSHAdminClient{Host: host, Port: port, Signer: testSigner(t), hostKeyCallback: hostKeyCallback}
	out, err := c.Exec(context.Background(), "whoami")
	if err != nil {
		t.Fatalf("Exec() error = %v", err)
	}
	if gotCommand != "whoami" {
		t.Errorf("server received command = %q, want %q", gotCommand, "whoami")
	}
	if out != "Email Address: test@example.com\n" {
		t.Errorf("Exec() = %q, want the server's stdout", out)
	}
}

func TestSSHAdminClientExecNonZeroExit(t *testing.T) {
	host, port, hostKeyCallback := startFakeSSHServer(t, func(command string) (string, int) {
		return "command not allowed by token permissions\n", 1
	})

	c := &SSHAdminClient{Host: host, Port: port, Signer: testSigner(t), hostKeyCallback: hostKeyCallback}
	_, err := c.Exec(context.Background(), "ssh-key generate-api-key --vm=x")
	if err == nil {
		t.Fatal("Exec() error = nil, want an error on non-zero remote exit")
	}
}

func TestSSHAdminClientConnectionRefused(t *testing.T) {
	// Nothing listening on this port.
	c := &SSHAdminClient{Host: "127.0.0.1", Port: 1, Signer: testSigner(t), Timeout: 2 * time.Second}
	_, err := c.Exec(context.Background(), "whoami")
	if err == nil {
		t.Fatal("Exec() error = nil, want an error when the connection is refused")
	}
}

func TestValidatedHostKeyRejectsUnexpectedKey(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatalf("signer from key: %v", err)
	}
	if err := validatedHostKey("exe.dev", nil, signer.PublicKey()); err == nil {
		t.Fatal("validatedHostKey() error = nil, want mismatch error")
	}
}

func TestNewSSHAdminClientInvalidKey(t *testing.T) {
	_, err := NewSSHAdminClient("exe.dev", []byte("not a valid private key"))
	if err == nil {
		t.Fatal("NewSSHAdminClient() error = nil, want an error for a malformed key")
	}
}

func TestNewSSHAdminClientValidKey(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
	c, err := NewSSHAdminClient("exe.dev", pemBytes)
	if err != nil {
		t.Fatalf("NewSSHAdminClient() error = %v", err)
	}
	if c.Host != "exe.dev" {
		t.Errorf("Host = %q, want exe.dev", c.Host)
	}
}
