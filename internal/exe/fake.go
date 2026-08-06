package exe

import "context"

// Fake is an in-memory Client for tests in this and other packages
// (internal/orchestrate) — avoids hitting real exe.dev and lets tests
// assert on exactly what commands were issued.
type Fake struct {
	Calls []string
	// Handler, if set, is invoked for every Exec call to produce its
	// response. If nil, Exec returns (nil, nil).
	Handler func(command string) ([]byte, error)
}

// Exec implements Client.
func (f *Fake) Exec(_ context.Context, command string) ([]byte, error) {
	f.Calls = append(f.Calls, command)
	if f.Handler != nil {
		return f.Handler(command)
	}
	return nil, nil
}

// FakeAdmin is an in-memory AdminClient for tests.
type FakeAdmin struct {
	Calls []string
	// Handler, if set, is invoked for every Exec call to produce its
	// response. If nil, Exec returns ("", nil).
	Handler func(command string) (string, error)
}

// Exec implements AdminClient.
func (f *FakeAdmin) Exec(_ context.Context, command string) (string, error) {
	f.Calls = append(f.Calls, command)
	if f.Handler != nil {
		return f.Handler(command)
	}
	return "", nil
}
