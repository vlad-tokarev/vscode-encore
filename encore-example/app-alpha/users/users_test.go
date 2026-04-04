package users

import (
	"context"
	"testing"
)

func TestCreateUser(t *testing.T) {
	testCases := []struct {
		name  string
		email string
	}{
		{name: "Ada", email: "ada@example.com"},
		{name: "Grace", email: "grace@example.com"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			user, err := service.CreateUser(context.Background(), &CreateUserParams{
				Name:  testCase.name,
				Email: testCase.email,
			})
			if err != nil {
				t.Fatalf("CreateUser returned error: %v", err)
			}
			if user.Name != testCase.name {
				t.Fatalf("CreateUser returned unexpected name %q", user.Name)
			}
		})
	}
}

func BenchmarkCreateUser(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_, err := service.CreateUser(context.Background(), &CreateUserParams{
			Name:  "Benchmark User",
			Email: "bench@example.com",
		})
		if err != nil {
			b.Fatalf("CreateUser returned error: %v", err)
		}
	}
}

func FuzzCreateUser(f *testing.F) {
	f.Add("Ada", "ada@example.com")

	f.Fuzz(func(t *testing.T, name string, email string) {
		if name == "" {
			t.Skip()
		}

		user, err := service.CreateUser(context.Background(), &CreateUserParams{
			Name:  name,
			Email: email,
		})
		if err != nil {
			t.Fatalf("CreateUser returned error: %v", err)
		}
		if user.Name == "" {
			t.Fatal("CreateUser returned an empty name")
		}
	})
}
