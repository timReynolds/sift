# Sift

Review the implementation in [stack order](docs/review-stack.md), with each PR's scope, size and validation recorded.

Sift reviews trusted, internal GitHub pull requests with a lead coding agent and configurable specialists. Pi Durable owns their conversations, tasks, recovery, compaction and usage. Each investigator gets an isolated coding workspace. The host validates and publishes findings as native GitHub reviews, imports human replies, and rechecks earlier feedback across pushes.

The implementation runs in GitHub Actions or through the same local CLI. It uses local SQLite during a run and guarded GCS snapshots between runs. It never commits or pushes investigated code, merges PRs, or provisions infrastructure.

## Install in a repository

1. Copy [examples/sift.yml](examples/sift.yml) to `.sift.yml`, and copy the selected [starter profiles](.github/agents) to `.github/agents`. Change the model and available specialist names as needed. Set `persistence.mode: gcs` and your existing bucket name.
2. Install a GitHub App with repository **Contents, Actions, Checks and Issues: read**, and **Pull requests: write**. Add its ID as `SIFT_APP_ID` and private key as `SIFT_APP_PRIVATE_KEY`. No App server or webhook receiver is needed. The token action creates a short-lived installation token.
3. Configure Google Workload Identity Federation and an existing bucket. Set `SIFT_WIF_PROVIDER` and `SIFT_GCS_SERVICE_ACCOUNT` repository variables. The service account needs bucket object read/create/delete permissions to read snapshots and replace them with generation guards. Restrict the federation trust to this repository and approved workflow/ref. Sift does not create these resources.
4. Add the chosen provider's credential, for example `ANTHROPIC_API_KEY`, as a repository secret.
5. Copy [examples/review-workflow.yml](examples/review-workflow.yml) to `.github/workflows/sift.yml`. Replace `REPLACE_WITH_REVIEWED_COMMIT_SHA` with a reviewed Sift commit. Keep the same per-PR concurrency group across every entry point and `cancel-in-progress: false`.

The workflow checks out the protected default branch only to identify trusted configuration. Sift fetches the PR's exact head, base and merge base independently. This also handles stacked PRs targeting a non-default branch. Proposed configuration/profile changes cannot expand permissions during their own review. External forks are skipped; drafts are skipped unless configured otherwise.

Use a Linux runner with Docker, Git, tar and Node 24 LTS. The composite Action installs its own locked dependencies and builds its own source, then calls the CLI engine. It does not run the reviewed repository's install scripts on the credential-bearing host. Investigator containers can install dependencies and run reproductions with no runner credentials or Docker socket.

## Local CLI

```sh
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --help
node dist/src/cli.js --validate-config --config examples/sift.yml
```

For a real review, configure `SIFT_GITHUB_READ_TOKEN`, a separate `SIFT_GITHUB_WRITE_TOKEN`, `SIFT_BOT_LOGIN`, and provider credentials in your runner environment. Use ADC for GCS mode. The read token must have only read permissions. The write token remains in the operational host; model-facing MCP uses the separate read token. `GITHUB_TOKEN` is a fallback for the write token. Without an App, configure workflow/PAT credentials and identity consistently; GitHub may disallow a workflow token from approving a PR under repository policy.

```sh
node dist/src/cli.js \
  --repository OWNER/REPO --pr 123 \
  --trusted-ref FULL_TRUSTED_COMMIT_SHA \
  --config .sift.yml --state .sift/state --dry-run
```

By default `--config` is a path in the fetched trusted commit. `--runner-config` explicitly opts into a configuration file supplied by the runner; profiles still come from the trusted checkout. `--github-mcp PATH` uses a preinstalled server whose handshake must report 1.14.0. Otherwise Sift downloads the pinned official release and checks its hard-coded SHA-256 checksum. The CLI supports `--event PATH --event-name NAME` or the corresponding Actions environment. Event SHAs are never used as the investigated head.

Dry-run still runs investigators and saves state, but performs no GitHub mutations. It can omit the publication credential; in that case private pending reviews cannot be inspected and the plan reports incomplete coverage. With the publication credential, dry-run can fully reconcile pending reviews through host-only reads.

## Findings and outcomes

The lead selects relevant specialists from descriptions, records reasons for skipped profiles, challenges findings, merges underlying duplicates and removes unsupported claims and nits. Priorities and confidence are separate. Defaults request changes for verified P0/P1 findings, comment on non-blocking findings or incomplete coverage, and approve only with complete relevant coverage and no active findings. Advisory mode never requests changes. See [configuration](docs/configuration.md) for thresholds.

Earlier comments remain tracked until rechecked. The host checks current-code evidence before accepting fixed/disproven/dismissed status, resolves only Sift-owned threads, and publishes the refreshed verdict separately. Maintainer dismissals retain their source and reason. Human discussion is imported by stable source/version IDs and responses have stable markers to prevent duplicate answers. Ordinary PR conversation comments need `@sift` or `/sift`; replies in Sift-owned review threads are relevant without a mention. Bot messages and reactions do not trigger discussion work.

Action outputs include the reviewed revision, selected/skipped/failed specialists, active findings by priority, verdict, publication and persistence status, coverage gaps, and measured cumulative session usage. A REQUEST_CHANGES review is a successful operation. An unsupported approval, missing publication receipt, or failed upload is an operational failure and exits nonzero.

## State and recovery

GCS objects use `PREFIX/repositories/REPOSITORY_ID/pulls/PR/session.sqlite`. Companion artifacts use content-addressed objects below that PR's `artifacts/` directory. Local mode uses the same layout under `--state/objects`. No SQLite or Git process runs against a bucket mount.

Each run downloads the last snapshot into a fresh runner directory, reconstructs tools and workspaces, opens real Pi SQLite, reviews, stops processes, uploads required investigation artifacts, closes Pi and creates a standalone SQLite backup before replacing the database object. First saves use a create-only guard; later saves require the exact downloaded generation. Stale writers fail rather than overwriting newer state. Ordinary failures and graceful cancellation attempt a save. Abrupt runner termination can lose progress since the last successful upload.

See [architecture](docs/architecture.md), [operations and recovery](docs/operations.md), [profile compatibility](docs/profiles-and-runtime.md), and [pinned upstream compatibility](docs/compatibility.md). The complete [v1 brief](docs/sift-v1-design.md) remains the implementation contract.

## Validation

```sh
npm run check
SIFT_DOCKER_TEST=1 SIFT_TEST_SECRET=must-not-leak npm test
```

Default tests need no secrets. They use deterministic Pi faux models, real Pi Durable and SQLite, and fake MCP/GitHub/GCS boundaries. They cover the actual engine across pushes, publication recovery, native verdicts, human replies, WAL snapshots, generation conflicts, workspace artifacts and the Action-to-CLI entry point. The optional Docker test executes real Pi filesystem and shell operations in the pinned container.

Live model calls, live GitHub review writes, and authenticated GCS transfers are opt-in operations through the CLI. They are not part of the default suite and have not been claimed as validated. The [acceptance map](docs/testing.md) identifies which boundaries are simulated.
