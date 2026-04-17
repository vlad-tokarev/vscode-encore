package prompts

import (
	"time"

	"encore.app/infra"
	"encore.dev/pubsub"
	"encore.dev/storage/cache"
)

type cachedPrompt struct {
	Name     string
	Template string
}

var PromptVersions = cache.NewStructKeyspace[string, cachedPrompt](
	infra.CacheCluster,
	cache.KeyspaceConfig{
		KeyPattern:    "prompts/:key/latest",
		DefaultExpiry: cache.ExpireIn(45 * time.Minute),
	},
)

type PromptPublishedEvent struct {
	PromptID string
	Version  string
}

var PromptPublishedTopic = pubsub.NewTopic[PromptPublishedEvent](
	"promptlab-prompt-published",
	pubsub.TopicConfig{
		DeliveryGuarantee: pubsub.ExactlyOnce,
	},
)
