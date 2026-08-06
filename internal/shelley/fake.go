package shelley

import "context"

// FakeCall records one Do invocation against a FakeTransport.
type FakeCall struct {
	Method string
	Path   string
	Body   []byte
}

// FakeTransport is an in-memory Transport for tests in this and other
// packages (internal/orchestrate) — avoids hitting a real Shelley instance.
type FakeTransport struct {
	Calls []FakeCall
	// Handler, if set, is invoked for every Do call to produce its response.
	// If nil, Do returns (nil, nil).
	Handler func(method, path string, body []byte) ([]byte, error)
}

// Do implements Transport.
func (f *FakeTransport) Do(_ context.Context, method, path string, body []byte) ([]byte, error) {
	f.Calls = append(f.Calls, FakeCall{Method: method, Path: path, Body: body})
	if f.Handler != nil {
		return f.Handler(method, path, body)
	}
	return nil, nil
}
