package exe

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"time"

	"golang.org/x/crypto/ssh"
)

// AdminClient is exe.dev's account-authenticated SSH surface — see the
// package doc for why this exists alongside the bearer-token Client.
type AdminClient interface {
	// Exec runs command against the exe.dev control host over real SSH
	// (the same REPL as Client.Exec, unrestricted by --cmds scope) and
	// returns its plain-text stdout. Also used for the nested
	// `ssh <vm> <command>` passthrough (readiness checks, repo clone),
	// since a real SSH session can run that verb with no permission error.
	Exec(ctx context.Context, command string) (string, error)
}

// SSHAdminClient is the real AdminClient.
type SSHAdminClient struct {
	// Host is the exe.dev control host, normally "exe.dev".
	Host string
	// Port is the SSH port. Zero means 22 (tests override this to target a
	// local fake server).
	Port int
	// Signer authenticates the account SSH keypair.
	Signer ssh.Signer
	// Timeout bounds connection + command execution. Zero means 30s.
	Timeout time.Duration
}

// NewSSHAdminClient parses an unencrypted SSH private key (PEM) — the
// account keypair registered with exe.dev — and returns a client targeting
// host (normally "exe.dev").
func NewSSHAdminClient(host string, privateKeyPEM []byte) (*SSHAdminClient, error) {
	signer, err := ssh.ParsePrivateKey(privateKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("exe: parse SSH private key: %w", err)
	}
	return &SSHAdminClient{Host: host, Signer: signer}, nil
}

// Exec implements AdminClient.
func (c *SSHAdminClient) Exec(ctx context.Context, command string) (string, error) {
	timeout := c.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}

	config := &ssh.ClientConfig{
		// exe.dev authenticates purely by SSH key identity; the username
		// value itself does not appear to be checked (unconfirmed — the
		// SSH protocol requires some value, so this is a placeholder).
		User: "exe",
		Auth: []ssh.AuthMethod{ssh.PublicKeys(c.Signer)},
		// ponytail: exe.dev's host key isn't pinned. Each VM (and the
		// control host) presents its own key, so a static pin isn't
		// straightforward; upgrade to a real HostKeyCallback (fetched/cached
		// known_hosts) if this needs to defend against active MITM, not just
		// opportunistic encryption.
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec
		Timeout:         timeout,
	}

	dialCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	port := c.Port
	if port == 0 {
		port = 22
	}

	var d net.Dialer
	conn, err := d.DialContext(dialCtx, "tcp", net.JoinHostPort(c.Host, fmt.Sprint(port)))
	if err != nil {
		return "", fmt.Errorf("exe: dial %s: %w", c.Host, err)
	}
	sshConn, chans, reqs, err := ssh.NewClientConn(conn, c.Host, config)
	if err != nil {
		return "", fmt.Errorf("exe: ssh handshake with %s: %w", c.Host, err)
	}
	client := ssh.NewClient(sshConn, chans, reqs)
	defer func() { _ = client.Close() }()

	session, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("exe: ssh new session: %w", err)
	}
	defer func() { _ = session.Close() }()

	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr

	if err := session.Run(command); err != nil {
		return "", fmt.Errorf("exe: ssh exec %q: %w (stderr: %s)", command, err, stderr.String())
	}
	return stdout.String(), nil
}
