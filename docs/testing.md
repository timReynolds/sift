# Testing

Use the Node version selected by [`.node-version`](../.node-version) (Node 24). From the repository root:

```sh
npm ci --ignore-scripts
npm run lint:fix
npm run check
```

`check` runs Biome, strict TypeScript checking, the production build and the Node test runner. The default suite needs no real credentials. It uses deterministic model responses and fake external-service boundaries while exercising real Pi Durable tasks, documents and SQLite storage.

To run one test file after building:

```sh
npm run build
node --experimental-strip-types --test test/engine.test.ts
```

Follow the [contributor guidance](../AGENTS.md) when adding tests: make Arrange, Act and Assert phases clear, name scenario inputs and results, and keep cleanup in `finally`.

## Coverage

| Behavior | Test files |
| --- | --- |
| Finding contracts, configuration, CLI validation and profile loading | [contracts](../test/contracts.test.ts), [config](../test/config.test.ts), [profiles](../test/profiles.test.ts) |
| Specialist selection, per-agent models, isolated workspaces, follow-ups and restart | [runtime](../test/runtime.test.ts), [pi-sqlite](../test/pi-sqlite.test.ts) |
| Capability activation, MCP schemas, scope and secret redaction | [runtime](../test/runtime.test.ts), [mcp](../test/mcp.test.ts) |
| Event normalization, complete PR discussion and exact stacked comparisons | [events](../test/events.test.ts), [GitHub context](../test/github-context.test.ts) |
| Deduplication, rejection reasons, priority/confidence and verdict policy | [review](../test/review.test.ts) |
| Native GitHub reviews, ambiguous writes, partial publication and stale revisions | [publication](../test/publication.test.ts), [GitHub publication](../test/github-publication.test.ts) |
| Fixed findings, thread resolution/reopening and human replies without duplication | [publication](../test/publication.test.ts), [engine](../test/engine.test.ts) |
| SQLite restart, committed WAL backup, guarded GCS generations and persistence failure | [persistence](../test/persistence.test.ts), [pi-sqlite](../test/pi-sqlite.test.ts) |
| Exact source export, changed investigation files and artifact restoration guards | [workspaces](../test/workspaces.test.ts), [artifacts](../test/artifacts.test.ts) |
| Full review lifecycle, failed coverage, missing artifacts and graceful cancellation | [engine](../test/engine.test.ts) |
| Container configuration and Action forwarding/output status | [sandbox](../test/sandbox.test.ts), [Action](../test/action.test.ts) |

MCP tests use real SDK client/server transports with scripted responses. GitHub tests simulate HTTP and MCP pagination, including threads with more than 100 replies. GCS tests simulate the storage SDK boundary while preserving exact string generations, metadata and precondition behavior. Engine tests use real Pi and SQLite across review, restart, reply and recheck stages; coding environments and network services are injected.

## Docker check

The default suite skips the real-container test. After building, opt in with a running Docker daemon on Linux or macOS:

```sh
SIFT_DOCKER_TEST=1 node --experimental-strip-types --test test/sandbox.test.ts
```

This checks Pi shell and filesystem operations in the pinned container, edits to runner-owned files, nested evidence, a writable temporary home, absence of a runner secret and Docker socket, and cleanup. The [CI workflow](../.github/workflows/test.yml) runs both `npm run check` and this Docker check. Pulling the configured image requires network access.

## External-service validation

These tests do not establish live model-provider behavior, GitHub App installation permissions or organization approval policy, authenticated GCS transfers, or successful execution of a consumer workflow in GitHub Actions. Action tests verify packaged metadata, input forwarding and outputs; they do not run a hosted workflow.

Validate those boundaries with the [documented CLI setup](../README.md) against a disposable trusted PR and an existing bucket. Start with dry-run, which still uses configured model providers and persistence, then enable publication only when a live review is intended. A local test pass or dry-run result does not establish a live GitHub review write or deployment.
