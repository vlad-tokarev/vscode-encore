package infra

import (
	"context"

	"encore.dev/cron"
	"encore.dev/storage/cache"
	"encore.dev/storage/objects"
	"encore.dev/storage/sqldb"
)

var (
	AccountDB = sqldb.NewDatabase("beta-accounts", sqldb.DatabaseConfig{
		Migrations: "./migrations",
	})
	ReadOnlyAccountDB = sqldb.Named("beta-accounts")
)

var CacheCluster = cache.NewCluster("beta-cache-cluster", cache.ClusterConfig{
	EvictionPolicy: cache.AllKeysLRU,
})

var ReportsBucket = objects.NewBucket("beta-reports", objects.BucketConfig{
	Versioned: true,
})

var _ = cron.NewJob("beta-daily-report", cron.JobConfig{
	Title:    "Beta daily report",
	Schedule: "0 6 * * *",
	Endpoint: RunDailyReport,
})

//encore:api private
func RunDailyReport(ctx context.Context) error {
	_ = ctx
	return nil
}
