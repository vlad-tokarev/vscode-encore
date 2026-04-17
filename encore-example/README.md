# Encore Example Workspaces

`encore-example/` contains two small Encore Go applications for manual and
automated extension testing:

- `agenthub` — AI agents platform (services: `agents`, `tools`, `platform`)
- `promptlab` — prompt operations platform (services: `prompts`, `evals`, `infra`)

Each application includes:

- Encore services and API directives
- a hand-written `encore.gen.go` file for navigation and references testing
- SQL database declarations with migrations
- a cache cluster and keyspace
- a Pub/Sub topic and subscription
- an object storage bucket
- a cron job
- a `var secrets struct { ... }` block
- `*_test.go` files with tests, benchmarks, fuzz tests, and subtests

The repository root is useful for file-based discovery checks because the
extension scans nested Encore apps under the workspace.

Open `encore-example/agenthub` or `encore-example/promptlab` directly when
checking command flows that execute Encore from the workspace root, such as
`encore test`, `encore run`, `encore secret list`, or `encore db conn-uri`.
