package accounts

import (
	"context"
	"testing"
)

func TestCreateAccount(t *testing.T) {
	testCases := []string{"Northwind", "Contoso"}

	for _, testCase := range testCases {
		t.Run(testCase, func(t *testing.T) {
			account, err := service.CreateAccount(context.Background(), &CreateAccountParams{
				Name: testCase,
			})
			if err != nil {
				t.Fatalf("CreateAccount returned error: %v", err)
			}
			if account.Name != testCase {
				t.Fatalf("CreateAccount returned unexpected name %q", account.Name)
			}
		})
	}
}

func BenchmarkCreateAccount(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_, err := service.CreateAccount(context.Background(), &CreateAccountParams{
			Name: "Benchmark Account",
		})
		if err != nil {
			b.Fatalf("CreateAccount returned error: %v", err)
		}
	}
}

func FuzzArchiveAccount(f *testing.F) {
	f.Add("beta-account-1")

	f.Fuzz(func(t *testing.T, accountID string) {
		if accountID == "" {
			t.Skip()
		}

		err := service.ArchiveAccount(context.Background(), &ArchiveAccountParams{
			AccountID: accountID,
		})
		if err != nil {
			t.Fatalf("ArchiveAccount returned error: %v", err)
		}
	})
}
