package tools

import (
	"context"
	"fmt"

	"encore.app/agents"
	"encore.dev/pubsub"
)

//encore:service
type Service struct{}

var service = &Service{}

type RegisterToolParams struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Schema      string `json:"schema"`
}

type InvokeToolParams struct {
	AgentID   string `json:"agentID"`
	Arguments string `json:"arguments"`
}

type Tool struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type ToolInvocation struct {
	InvocationID string `json:"invocationID"`
	ToolID       string `json:"toolID"`
	Result       string `json:"result"`
}

//encore:api public method=POST path=/tools tag:agenthub-tools
func (s *Service) RegisterTool(ctx context.Context, params *RegisterToolParams) (*Tool, error) {
	if params == nil || params.Name == "" {
		return nil, fmt.Errorf("name is required")
	}

	_ = ctx

	return &Tool{
		ID:          "tool-1",
		Name:        params.Name,
		Description: params.Description,
	}, nil
}

//encore:api private method=POST path=/tools/:toolID/invoke tag:agenthub-tools
func (s *Service) InvokeTool(ctx context.Context, toolID string, params *InvokeToolParams) (*ToolInvocation, error) {
	if toolID == "" {
		return nil, fmt.Errorf("toolID is required")
	}
	if params == nil || params.AgentID == "" {
		return nil, fmt.Errorf("agentID is required")
	}

	if _, err := agents.GetAgent(ctx, params.AgentID); err != nil {
		return nil, err
	}

	return &ToolInvocation{
		InvocationID: "invocation-1",
		ToolID:       toolID,
		Result:       "mock tool result",
	}, nil
}

var _ = pubsub.NewSubscription(
	agents.AgentCreatedTopic,
	"agenthub-tools-provision-defaults",
	pubsub.SubscriptionConfig[agents.AgentCreatedEvent]{
		Handler: provisionDefaultTools,
	},
)

func provisionDefaultTools(ctx context.Context, event agents.AgentCreatedEvent) error {
	_ = ctx
	_ = event
	return nil
}
