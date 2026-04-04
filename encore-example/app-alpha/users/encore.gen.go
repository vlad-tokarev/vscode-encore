package users

import "context"

func CreateUser(ctx context.Context, params *CreateUserParams) (*User, error) {
	return service.CreateUser(ctx, params)
}

func GetUser(ctx context.Context, params *GetUserParams) (*User, error) {
	return service.GetUser(ctx, params)
}

func SyncUsers(ctx context.Context) error {
	return service.SyncUsers(ctx)
}

type Interface interface {
	CreateUser(ctx context.Context, params *CreateUserParams) (*User, error)
	GetUser(ctx context.Context, params *GetUserParams) (*User, error)
	SyncUsers(ctx context.Context) error
}
