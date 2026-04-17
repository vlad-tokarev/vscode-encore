package agents

import (
	"context"
	"testing"
)

func TestCreateAgent(t *testing.T) {
	testCases := []struct {
		name  string
		model string
	}{
		{name: "Researcher", model: "claude-opus-4-7"},
		{name: "Coder", model: "claude-sonnet-4-6"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			agent, err := service.CreateAgent(context.Background(), &CreateAgentParams{
				Name:  testCase.name,
				Model: testCase.model,
			})
			if err != nil {
				t.Fatalf("CreateAgent returned error: %v", err)
			}
			if agent.Name != testCase.name {
				t.Fatalf("CreateAgent returned unexpected name %q", agent.Name)
			}
		})
	}
}

func BenchmarkCreateAgent(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_, err := service.CreateAgent(context.Background(), &CreateAgentParams{
			Name:  "Benchmark Agent",
			Model: "claude-haiku-4-5",
		})
		if err != nil {
			b.Fatalf("CreateAgent returned error: %v", err)
		}
	}
}

func FuzzCreateAgent(f *testing.F) {
	f.Add("Researcher", "claude-opus-4-7")

	f.Fuzz(func(t *testing.T, name string, model string) {
		if name == "" {
			t.Skip()
		}

		agent, err := service.CreateAgent(context.Background(), &CreateAgentParams{
			Name:  name,
			Model: model,
		})
		if err != nil {
			t.Fatalf("CreateAgent returned error: %v", err)
		}
		if agent.Name == "" {
			t.Fatal("CreateAgent returned an empty name")
		}
	})
}
