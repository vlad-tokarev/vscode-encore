package agents

import (
	"time"

	"encore.app/platform"
	"encore.dev/pubsub"
	"encore.dev/storage/cache"
)

type cachedAgent struct {
	Name  string
	Model string
}

var AgentProfiles = cache.NewStructKeyspace[string, cachedAgent](
	platform.CacheCluster,
	cache.KeyspaceConfig{
		KeyPattern:    "agents/:key/profile",
		DefaultExpiry: cache.ExpireIn(30 * time.Minute),
	},
)

type AgentCreatedEvent struct {
	AgentID string
	Model   string
}

var AgentCreatedTopic = pubsub.NewTopic[AgentCreatedEvent](
	"agenthub-agent-created",
	pubsub.TopicConfig{
		DeliveryGuarantee: pubsub.AtLeastOnce,
	},
)
