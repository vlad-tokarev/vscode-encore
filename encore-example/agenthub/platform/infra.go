package platform

import (
	"context"

	"encore.dev/cron"
	"encore.dev/storage/cache"
	"encore.dev/storage/objects"
	"encore.dev/storage/sqldb"
)

var PrimaryDB = sqldb.NewDatabase("agenthub_platform", sqldb.DatabaseConfig{
	Migrations: "./migrations",
})

var ReadDB = sqldb.Named("agenthub_platform")

var CacheCluster = cache.NewCluster("agenthub-cache-cluster", cache.ClusterConfig{
	EvictionPolicy: cache.AllKeysLRU,
})

var TranscriptsBucket = objects.NewBucket("agenthub-transcripts", objects.BucketConfig{
	Public: true,
})

var _ = cron.NewJob("agenthub-nightly-agent-reindex", cron.JobConfig{
	Title:    "AgentHub nightly agent reindex",
	Every:    12 * cron.Hour,
	Endpoint: RunNightlyReindex,
})

//encore:api private
func RunNightlyReindex(ctx context.Context) error {
	_ = ctx
	return nil
}
