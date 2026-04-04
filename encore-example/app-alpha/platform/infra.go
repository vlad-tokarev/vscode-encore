package platform

import (
	"context"

	"encore.dev/cron"
	"encore.dev/storage/cache"
	"encore.dev/storage/objects"
	"encore.dev/storage/sqldb"
)

var PrimaryDB = sqldb.NewDatabase("alpha-platform", sqldb.DatabaseConfig{
	Migrations: "./migrations",
})

var ReadDB = sqldb.Named("alpha-platform")

var CacheCluster = cache.NewCluster("alpha-cache-cluster", cache.ClusterConfig{
	EvictionPolicy: cache.AllKeysLRU,
})

var Assets = objects.NewBucket("alpha-assets", objects.BucketConfig{
	Public: true,
})

var _ = cron.NewJob("alpha-nightly-sync", cron.JobConfig{
	Title:    "Alpha nightly sync",
	Every:    12 * cron.Hour,
	Endpoint: RunNightlySync,
})

//encore:api private
func RunNightlySync(ctx context.Context) error {
	_ = ctx
	return nil
}
