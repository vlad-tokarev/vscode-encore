package infra

import (
	"context"

	"encore.dev/cron"
	"encore.dev/storage/cache"
	"encore.dev/storage/objects"
	"encore.dev/storage/sqldb"
)

var (
	PromptDB = sqldb.NewDatabase("promptlab_prompts", sqldb.DatabaseConfig{
		Migrations: "./migrations",
	})
	ReadOnlyPromptDB = sqldb.Named("promptlab_prompts")
)

var CacheCluster = cache.NewCluster("promptlab-cache-cluster", cache.ClusterConfig{
	EvictionPolicy: cache.AllKeysLRU,
})

var EvalArtifactsBucket = objects.NewBucket("promptlab-eval-artifacts", objects.BucketConfig{
	Versioned: true,
})

var _ = cron.NewJob("promptlab-nightly-eval", cron.JobConfig{
	Title:    "PromptLab nightly regression eval",
	Schedule: "0 6 * * *",
	Endpoint: RunNightlyEval,
})

//encore:api private
func RunNightlyEval(ctx context.Context) error {
	_ = ctx
	return nil
}
