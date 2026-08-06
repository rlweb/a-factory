package shelley

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
)

func TestNewConversation(t *testing.T) {
	ft := &FakeTransport{Handler: func(method, path string, body []byte) ([]byte, error) {
		var req newConversationRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("unmarshal request body: %v", err)
		}
		if method != http.MethodPost || path != "/api/conversations/new" {
			t.Errorf("Do(method=%q, path=%q), want POST /api/conversations/new", method, path)
		}
		if req.Model != "deepseek-v4-flash" || req.Message != "seed prompt" {
			t.Errorf("request = %+v, want model=deepseek-v4-flash message=%q", req, "seed prompt")
		}
		return json.Marshal(newConversationResponse{ConversationID: "c_8f21", Status: "accepted"})
	}}

	c := New(ft)
	id, err := c.NewConversation(context.Background(), "deepseek-v4-flash", "seed prompt")
	if err != nil {
		t.Fatalf("NewConversation() error = %v", err)
	}
	if id != "c_8f21" {
		t.Errorf("NewConversation() = %q, want c_8f21", id)
	}
}

func TestNewConversationMissingID(t *testing.T) {
	ft := &FakeTransport{Handler: func(string, string, []byte) ([]byte, error) {
		return json.Marshal(newConversationResponse{})
	}}
	c := New(ft)
	if _, err := c.NewConversation(context.Background(), "m", "msg"); err == nil {
		t.Fatal("NewConversation() error = nil, want an error when the response has no id")
	}
}

func TestNewConversationTransportError(t *testing.T) {
	ft := &FakeTransport{Handler: func(string, string, []byte) ([]byte, error) {
		return nil, errors.New("boom")
	}}
	c := New(ft)
	if _, err := c.NewConversation(context.Background(), "m", "msg"); err == nil {
		t.Fatal("NewConversation() error = nil, want the transport error to propagate")
	}
}

func TestChat(t *testing.T) {
	ft := &FakeTransport{}
	c := New(ft)
	if err := c.Chat(context.Background(), "c_8f21", "please also handle X"); err != nil {
		t.Fatalf("Chat() error = %v", err)
	}
	if len(ft.Calls) != 1 {
		t.Fatalf("len(Calls) = %d, want 1", len(ft.Calls))
	}
	call := ft.Calls[0]
	if call.Method != http.MethodPost || call.Path != "/api/conversation/c_8f21/chat" {
		t.Errorf("call = %+v, want POST /api/conversation/c_8f21/chat", call)
	}
	var req chatRequest
	if err := json.Unmarshal(call.Body, &req); err != nil {
		t.Fatalf("unmarshal request body: %v", err)
	}
	if req.Message != "please also handle X" {
		t.Errorf("Message = %q, want %q", req.Message, "please also handle X")
	}
}

func TestCancel(t *testing.T) {
	ft := &FakeTransport{}
	c := New(ft)
	if err := c.Cancel(context.Background(), "c_8f21"); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	if len(ft.Calls) != 1 || ft.Calls[0].Path != "/api/conversation/c_8f21/cancel" {
		t.Errorf("Calls = %+v, want a single POST to /api/conversation/c_8f21/cancel", ft.Calls)
	}
}

func TestGetConversation(t *testing.T) {
	ft := &FakeTransport{Handler: func(string, string, []byte) ([]byte, error) {
		return []byte(`{"messages":[]}`), nil
	}}
	c := New(ft)
	got, err := c.GetConversation(context.Background(), "c_8f21")
	if err != nil {
		t.Fatalf("GetConversation() error = %v", err)
	}
	if string(got) != `{"messages":[]}` {
		t.Errorf("GetConversation() = %s, want %s", got, `{"messages":[]}`)
	}
	if ft.Calls[0].Method != http.MethodGet || ft.Calls[0].Path != "/api/conversation/c_8f21" {
		t.Errorf("Calls = %+v, want a single GET to /api/conversation/c_8f21", ft.Calls)
	}
}

func TestUpsertCustomModel(t *testing.T) {
	// Confirmed against a real account: Shelley assigns a model_id distinct
	// from the submitted model_name (appends a provider suffix).
	ft := &FakeTransport{Handler: func(string, string, []byte) ([]byte, error) {
		return json.Marshal(customModelResponse{ModelID: "deepseek-v4-flash-opencode-ai"})
	}}
	c := New(ft)
	model := CustomModel{
		DisplayName:  "DeepSeek V4 Flash",
		ProviderType: "openai",
		Endpoint:     "https://opencode.ai/zen/go/v1",
		APIKey:       "test-key",
		ModelName:    "deepseek-v4-flash",
		MaxTokens:    8192,
	}
	modelID, err := c.UpsertCustomModel(context.Background(), model)
	if err != nil {
		t.Fatalf("UpsertCustomModel() error = %v", err)
	}
	if modelID != "deepseek-v4-flash-opencode-ai" {
		t.Errorf("UpsertCustomModel() = %q, want the assigned model_id, not the submitted model_name", modelID)
	}
	if len(ft.Calls) != 1 || ft.Calls[0].Path != "/api/custom-models" {
		t.Fatalf("Calls = %+v, want a single POST to /api/custom-models", ft.Calls)
	}
	var got CustomModel
	if err := json.Unmarshal(ft.Calls[0].Body, &got); err != nil {
		t.Fatalf("unmarshal request body: %v", err)
	}
	if got != model {
		t.Errorf("request body = %+v, want %+v", got, model)
	}
}

func TestUpsertCustomModelMissingID(t *testing.T) {
	ft := &FakeTransport{Handler: func(string, string, []byte) ([]byte, error) {
		return json.Marshal(customModelResponse{})
	}}
	c := New(ft)
	if _, err := c.UpsertCustomModel(context.Background(), CustomModel{}); err == nil {
		t.Fatal("UpsertCustomModel() error = nil, want an error when the response has no model_id")
	}
}
