package accounts

import (
	"time"

	"encore.app/infra"
	"encore.dev/pubsub"
	"encore.dev/storage/cache"
)

type cachedAccount struct {
	Name string
}

var AccountSummaries = cache.NewStructKeyspace[string, cachedAccount](
	infra.CacheCluster,
	cache.KeyspaceConfig{
		KeyPattern:    "accounts/:key/summary",
		DefaultExpiry: cache.ExpireIn(45 * time.Minute),
	},
)

type AccountArchivedEvent struct {
	AccountID string
}

var AccountArchivedTopic = pubsub.NewTopic[AccountArchivedEvent](
	"beta-account-archived",
	pubsub.TopicConfig{
		DeliveryGuarantee: pubsub.ExactlyOnce,
	},
)
