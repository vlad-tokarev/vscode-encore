package agents

import (
	"context"
	"fmt"
)

//encore:service
type Service struct{}

var service = &Service{}

var secrets struct {
	OpenAIAPIKey    string
	AnthropicAPIKey string
}

type CreateAgentParams struct {
	Name         string `json:"name"`
	Model        string `json:"model"`
	SystemPrompt string `json:"systemPrompt"`
}

type RunAgentParams struct {
	Input string `json:"input"`
}

type Agent struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Model        string `json:"model"`
	SystemPrompt string `json:"systemPrompt"`
}

type AgentRun struct {
	RunID   string `json:"runID"`
	AgentID string `json:"agentID"`
	Output  string `json:"output"`
}

//encore:api public method=POST path=/agents tag:agenthub-agents
func (s *Service) CreateAgent(ctx context.Context, params *CreateAgentParams) (*Agent, error) {
	if params == nil || params.Name == "" {
		return nil, fmt.Errorf("name is required")
	}

	_ = ctx

	return &Agent{
		ID:           "agent-1",
		Name:         params.Name,
		Model:        params.Model,
		SystemPrompt: params.SystemPrompt,
	}, nil
}

//encore:api public method=GET path=/agents/:agentID tag:agenthub-agents
func (s *Service) GetAgent(ctx context.Context, agentID string) (*Agent, error) {
	if agentID == "" {
		return nil, fmt.Errorf("agentID is required")
	}

	_ = ctx

	return &Agent{
		ID:           agentID,
		Name:         "Research Assistant",
		Model:        "claude-opus-4-7",
		SystemPrompt: "You are a helpful research assistant.",
	}, nil
}

//encore:api private method=POST path=/agents/:agentID/run tag:agenthub-agents
func (s *Service) RunAgent(ctx context.Context, agentID string, params *RunAgentParams) (*AgentRun, error) {
	if agentID == "" {
		return nil, fmt.Errorf("agentID is required")
	}

	_ = ctx
	_ = params

	return &AgentRun{
		RunID:   "run-1",
		AgentID: agentID,
		Output:  "mock response",
	}, nil
}
