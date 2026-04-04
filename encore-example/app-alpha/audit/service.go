package audit

import (
	"context"

	"encore.app/users"
	"encore.dev/pubsub"
)

//encore:service
type Service struct{}

var service = &Service{}

//encore:api private method=GET path=/audit/events tag:audit-read
func (s *Service) ListAuditEvents(ctx context.Context) error {
	_, err := users.GetUser(ctx, &users.GetUserParams{
		UserID: "alpha-user-1",
	})
	return err
}

var _ = pubsub.NewSubscription(
	users.UserCreatedTopic,
	"alpha-audit-user-created",
	pubsub.SubscriptionConfig[users.UserCreatedEvent]{
		Handler: handleUserCreated,
	},
)

func handleUserCreated(ctx context.Context, event users.UserCreatedEvent) error {
	_ = ctx
	_ = event
	return nil
}
