package accounts

import (
	"context"
	"fmt"
)

//encore:service
type Service struct{}

var service = &Service{}

var secrets struct {
	BetaSigningKey    string
	BetaWebhookSecret string
}

type CreateAccountParams struct {
	Name string `json:"name"`
}

type GetAccountParams struct {
	AccountID string `json:"accountID"`
}

type ArchiveAccountParams struct {
	AccountID string `json:"accountID"`
}

type Account struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

//encore:api public method=POST path=/accounts tag:beta-accounts
func (s *Service) CreateAccount(ctx context.Context, params *CreateAccountParams) (*Account, error) {
	if params == nil || params.Name == "" {
		return nil, fmt.Errorf("name is required")
	}

	_ = ctx

	return &Account{
		ID:     "beta-account-1",
		Name:   params.Name,
		Status: "active",
	}, nil
}

//encore:api private method=GET path=/accounts/:accountID tag:beta-accounts
func (s *Service) GetAccount(ctx context.Context, params *GetAccountParams) (*Account, error) {
	if params == nil || params.AccountID == "" {
		return nil, fmt.Errorf("accountID is required")
	}

	_ = ctx

	return &Account{
		ID:     params.AccountID,
		Name:   "Beta Account",
		Status: "active",
	}, nil
}

//encore:api auth method=POST path=/accounts/:accountID/archive tag:beta-maintenance
func (s *Service) ArchiveAccount(ctx context.Context, params *ArchiveAccountParams) error {
	if params == nil || params.AccountID == "" {
		return fmt.Errorf("accountID is required")
	}

	_ = ctx
	return nil
}
