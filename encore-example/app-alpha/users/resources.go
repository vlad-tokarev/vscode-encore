package users

import (
	"time"

	"encore.app/platform"
	"encore.dev/pubsub"
	"encore.dev/storage/cache"
)

type cachedUser struct {
	Name  string
	Email string
}

var UserProfiles = cache.NewStructKeyspace[string, cachedUser](
	platform.CacheCluster,
	cache.KeyspaceConfig{
		KeyPattern:    "users/:key/profile",
		DefaultExpiry: cache.ExpireIn(30 * time.Minute),
	},
)

type UserCreatedEvent struct {
	UserID string
	Email  string
}

var UserCreatedTopic = pubsub.NewTopic[UserCreatedEvent](
	"alpha-user-created",
	pubsub.TopicConfig{
		DeliveryGuarantee: pubsub.AtLeastOnce,
	},
)
