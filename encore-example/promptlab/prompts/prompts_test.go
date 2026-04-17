package prompts

import (
	"context"
	"testing"
)

func TestCreatePrompt(t *testing.T) {
	testCases := []string{"Summarisation", "Classification"}

	for _, testCase := range testCases {
		t.Run(testCase, func(t *testing.T) {
			prompt, err := service.CreatePrompt(context.Background(), &CreatePromptParams{
				Name:     testCase,
				Template: "{{input}}",
			})
			if err != nil {
				t.Fatalf("CreatePrompt returned error: %v", err)
			}
			if prompt.Name != testCase {
				t.Fatalf("CreatePrompt returned unexpected name %q", prompt.Name)
			}
		})
	}
}

func BenchmarkCreatePrompt(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_, err := service.CreatePrompt(context.Background(), &CreatePromptParams{
			Name:     "Benchmark Prompt",
			Template: "{{input}}",
		})
		if err != nil {
			b.Fatalf("CreatePrompt returned error: %v", err)
		}
	}
}

func FuzzPublishPrompt(f *testing.F) {
	f.Add("prompt-1", "v1")

	f.Fuzz(func(t *testing.T, promptID string, version string) {
		if promptID == "" {
			t.Skip()
		}

		err := service.PublishPrompt(context.Background(), promptID, &PublishPromptParams{
			Version: version,
		})
		if err != nil {
			t.Fatalf("PublishPrompt returned error: %v", err)
		}
	})
}
