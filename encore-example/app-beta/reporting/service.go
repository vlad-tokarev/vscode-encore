package reporting

import (
	"context"

	"encore.app/accounts"
	"encore.dev/pubsub"
)

//encore:service
type Service struct{}

var service = &Service{}

//encore:api private method=GET path=/reports/daily tag:beta-reports
func (s *Service) GenerateDailyReport(ctx context.Context) error {
	_, err := accounts.GetAccount(ctx, &accounts.GetAccountParams{
		AccountID: "beta-account-1",
	})
	return err
}

var _ = pubsub.NewSubscription(
	accounts.AccountArchivedTopic,
	"beta-reporting-archived-account",
	pubsub.SubscriptionConfig[accounts.AccountArchivedEvent]{
		Handler: handleAccountArchived,
	},
)

func handleAccountArchived(ctx context.Context, event accounts.AccountArchivedEvent) error {
	_ = ctx
	_ = event
	return nil
}
