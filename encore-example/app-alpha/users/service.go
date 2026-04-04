package users

import (
	"context"
	"fmt"
)

//encore:service
type Service struct{}

var service = &Service{}

var secrets struct {
	AlphaAPIKey         string
	AlphaWebhookSecret  string
}

type CreateUserParams struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type GetUserParams struct {
	UserID string `json:"userID"`
}

type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

//encore:api public method=POST path=/users tag:alpha-users
func (s *Service) CreateUser(ctx context.Context, params *CreateUserParams) (*User, error) {
	if params == nil || params.Name == "" {
		return nil, fmt.Errorf("name is required")
	}

	_ = ctx

	return &User{
		ID:    "alpha-user-1",
		Name:  params.Name,
		Email: params.Email,
	}, nil
}

//encore:api auth method=GET path=/users/:userID tag:alpha-users
func (s *Service) GetUser(ctx context.Context, params *GetUserParams) (*User, error) {
	if params == nil || params.UserID == "" {
		return nil, fmt.Errorf("userID is required")
	}

	_ = ctx

	return &User{
		ID:    params.UserID,
		Name:  "Ada Lovelace",
		Email: "ada@example.com",
	}, nil
}

//encore:api private method=POST path=/users/sync tag:background-sync
func (s *Service) SyncUsers(ctx context.Context) error {
	_ = ctx
	return nil
}
