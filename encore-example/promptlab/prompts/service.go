package prompts

import (
	"context"
	"fmt"
)

//encore:service
type Service struct{}

var service = &Service{}

var secrets struct {
	PromptLabSigningKey    string
	PromptLabWebhookSecret string
}

type CreatePromptParams struct {
	Name     string `json:"name"`
	Template string `json:"template"`
}

type PublishPromptParams struct {
	Version string `json:"version"`
}

type Prompt struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Template string `json:"template"`
	Status   string `json:"status"`
}

//encore:api public method=POST path=/prompts tag:promptlab-prompts
func (s *Service) CreatePrompt(ctx context.Context, params *CreatePromptParams) (*Prompt, error) {
	if params == nil || params.Name == "" {
		return nil, fmt.Errorf("name is required")
	}

	_ = ctx

	return &Prompt{
		ID:       "prompt-1",
		Name:     params.Name,
		Template: params.Template,
		Status:   "draft",
	}, nil
}

//encore:api private method=GET path=/prompts/:promptID tag:promptlab-prompts
func (s *Service) GetPrompt(ctx context.Context, promptID string) (*Prompt, error) {
	if promptID == "" {
		return nil, fmt.Errorf("promptID is required")
	}

	_ = ctx

	return &Prompt{
		ID:       promptID,
		Name:     "Summarisation",
		Template: "Summarise the following text: {{input}}",
		Status:   "published",
	}, nil
}

//encore:api public method=POST path=/prompts/:promptID/publish tag:promptlab-prompts
func (s *Service) PublishPrompt(ctx context.Context, promptID string, params *PublishPromptParams) error {
	if promptID == "" {
		return fmt.Errorf("promptID is required")
	}

	_ = ctx
	_ = params
	return nil
}
