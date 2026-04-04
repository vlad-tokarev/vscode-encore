package accounts

import "context"

func CreateAccount(ctx context.Context, params *CreateAccountParams) (*Account, error) {
	return service.CreateAccount(ctx, params)
}

func GetAccount(ctx context.Context, params *GetAccountParams) (*Account, error) {
	return service.GetAccount(ctx, params)
}

func ArchiveAccount(ctx context.Context, params *ArchiveAccountParams) error {
	return service.ArchiveAccount(ctx, params)
}

type Interface interface {
	CreateAccount(ctx context.Context, params *CreateAccountParams) (*Account, error)
	GetAccount(ctx context.Context, params *GetAccountParams) (*Account, error)
	ArchiveAccount(ctx context.Context, params *ArchiveAccountParams) error
}
