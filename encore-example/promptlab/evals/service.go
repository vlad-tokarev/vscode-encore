package evals

import (
	"context"
	"fmt"

	"encore.app/prompts"
	"encore.dev/pubsub"
)

//encore:service
type Service struct{}

var service = &Service{}

type RunEvalParams struct {
	PromptID string `json:"promptID"`
	Dataset  string `json:"dataset"`
}

type EvalRun struct {
	RunID    string  `json:"runID"`
	PromptID string  `json:"promptID"`
	Score    float64 `json:"score"`
}

//encore:api private method=POST path=/evals tag:promptlab-evals
func (s *Service) RunEval(ctx context.Context, params *RunEvalParams) (*EvalRun, error) {
	if params == nil || params.PromptID == "" {
		return nil, fmt.Errorf("promptID is required")
	}

	if _, err := prompts.GetPrompt(ctx, params.PromptID); err != nil {
		return nil, err
	}

	return &EvalRun{
		RunID:    "eval-run-1",
		PromptID: params.PromptID,
		Score:    0.87,
	}, nil
}

//encore:api private method=GET path=/evals/latest tag:promptlab-evals
func (s *Service) LatestEval(ctx context.Context) (*EvalRun, error) {
	_ = ctx
	return &EvalRun{
		RunID:    "eval-run-latest",
		PromptID: "prompt-1",
		Score:    0.91,
	}, nil
}

var _ = pubsub.NewSubscription(
	prompts.PromptPublishedTopic,
	"promptlab-evals-trigger-regression",
	pubsub.SubscriptionConfig[prompts.PromptPublishedEvent]{
		Handler: handlePromptPublished,
	},
)

func handlePromptPublished(ctx context.Context, event prompts.PromptPublishedEvent) error {
	_ = ctx
	_ = event
	return nil
}
