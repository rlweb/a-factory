// Package shelley is a client for exe.dev's first-party coding agent's HTTP
// API (github.com/boldsoftware/shelley/blob/main/API.md), reached over the
// public HTTPS route via DirectTransport — confirmed end-to-end against a
// real exe.dev account, including a real custom-model registration and a
// genuine agent response. See docs/spike-findings.md for the full evidence.
package shelley

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

// Client is a typed wrapper over Shelley's HTTP API.
type Client struct {
	T Transport
}

// New constructs a Client over the given Transport.
func New(t Transport) *Client {
	return &Client{T: t}
}

type newConversationRequest struct {
	Message string `json:"message"`
	Model   string `json:"model,omitempty"` // optional; Shelley defaults to a built-in model (e.g. gpt-5.6-sol) if omitted
}

type newConversationResponse struct {
	ConversationID string `json:"conversation_id"`
	Status         string `json:"status"`
}

// NewConversation seeds a fresh conversation with the given model and
// initial message (the rendered ticket/bug/epic prompt), returning its
// conversation ID. Confirmed fire-and-forget: the HTTP response returns
// immediately (201 accepted) — the agent's actual work happens
// asynchronously server-side inside Shelley, never blocking this call.
func (c *Client) NewConversation(ctx context.Context, model, message string) (string, error) {
	body, err := json.Marshal(newConversationRequest{Model: model, Message: message})
	if err != nil {
		return "", fmt.Errorf("shelley: marshal NewConversation request: %w", err)
	}
	resp, err := c.T.Do(ctx, http.MethodPost, "/api/conversations/new", body)
	if err != nil {
		return "", fmt.Errorf("shelley: NewConversation: %w", err)
	}
	var out newConversationResponse
	if err := json.Unmarshal(resp, &out); err != nil {
		return "", fmt.Errorf("shelley: decode NewConversation response: %w", err)
	}
	if out.ConversationID == "" {
		return "", fmt.Errorf("shelley: NewConversation response had no conversation_id")
	}
	return out.ConversationID, nil
}

type chatRequest struct {
	Message string `json:"message"`
}

// Chat relays a follow-up message (a relayed PR/issue comment or review)
// into an existing conversation. Also confirmed fire-and-forget (202
// accepted, immediate).
func (c *Client) Chat(ctx context.Context, conversationID, message string) error {
	body, err := json.Marshal(chatRequest{Message: message})
	if err != nil {
		return fmt.Errorf("shelley: marshal Chat request: %w", err)
	}
	_, err = c.T.Do(ctx, http.MethodPost, "/api/conversation/"+conversationID+"/chat", body)
	if err != nil {
		return fmt.Errorf("shelley: Chat: %w", err)
	}
	return nil
}

// Cancel interrupts a conversation's running agent loop.
func (c *Client) Cancel(ctx context.Context, conversationID string) error {
	if _, err := c.T.Do(ctx, http.MethodPost, "/api/conversation/"+conversationID+"/cancel", nil); err != nil {
		return fmt.Errorf("shelley: Cancel: %w", err)
	}
	return nil
}

// GetConversation returns the raw JSON message history for a conversation
// (used only by the manual smoke test to confirm a seed took effect — the
// CLI's normal orchestration flow never needs to read this back).
func (c *Client) GetConversation(ctx context.Context, conversationID string) ([]byte, error) {
	resp, err := c.T.Do(ctx, http.MethodGet, "/api/conversation/"+conversationID, nil)
	if err != nil {
		return nil, fmt.Errorf("shelley: GetConversation: %w", err)
	}
	return resp, nil
}

// CustomModel is a Shelley custom-model registration. DisplayName,
// ProviderType, Endpoint, APIKey, and ModelName are required by Shelley;
// MaxTokens is optional.
type CustomModel struct {
	DisplayName  string `json:"display_name"`
	ProviderType string `json:"provider_type"` // "openai" | "anthropic" | "openai-responses"
	Endpoint     string `json:"endpoint"`
	APIKey       string `json:"api_key"`
	ModelName    string `json:"model_name"`
	MaxTokens    int    `json:"max_tokens,omitempty"`
}

type customModelResponse struct {
	ModelID string `json:"model_id"`
}

// UpsertCustomModel registers a custom model and returns the model_id
// Shelley assigns — confirmed to differ from the submitted ModelName
// (Shelley appends a provider suffix, e.g. submitting model_name
// "deepseek-v4-flash" gets back model_id "deepseek-v4-flash-opencode-ai").
// Callers MUST use this returned ID, not m.ModelName, when starting a
// conversation against this model.
func (c *Client) UpsertCustomModel(ctx context.Context, m CustomModel) (string, error) {
	body, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("shelley: marshal CustomModel: %w", err)
	}
	resp, err := c.T.Do(ctx, http.MethodPost, "/api/custom-models", body)
	if err != nil {
		return "", fmt.Errorf("shelley: UpsertCustomModel: %w", err)
	}
	var out customModelResponse
	if err := json.Unmarshal(resp, &out); err != nil {
		return "", fmt.Errorf("shelley: decode UpsertCustomModel response: %w", err)
	}
	if out.ModelID == "" {
		return "", fmt.Errorf("shelley: UpsertCustomModel response had no model_id")
	}
	return out.ModelID, nil
}
