# Upstream compatibility

The lockfile pins the installed dependency graph. Direct dependencies use exact versions. Runtime compatibility is recorded in application state so an incompatible resume can fail visibly.

| Component | Pin | Verified source |
| --- | --- | --- |
| Pi Durable, Pi AI, Chord | 1.0.2 | npm package exports and declarations; upstream commit `cd32f7725fdbddbaecdff5b1e68491563394e0ca` |
| Official GitHub MCP server | 1.14.0 | release source at `v1.14.0` |
| MCP TypeScript SDK | 1.32.0 | installed package |
| Google Cloud Storage SDK | 8.2.0 | installed package |
| Node | 24 LTS | Pi requires at least 22.19; Sift uses Node's built-in SQLite |

Pi is experimental; this implementation does not assume that a later release has the same API. The installed 1.0.2 exports include `Harness`, `configure`, `createRegistry`, `defineExtension`, `defineTool`, `defineTask`, `defineDoc`, `CodingTools`, and `openNodeSqliteStorage`. No custom conversation scheduler or Pi storage engine is needed.

The [pinned Pi README](https://github.com/earendil-works/pi/blob/cd32f7725fdbddbaecdff5b1e68491563394e0ca/packages/durable/README.md) and examples 22–24 and 28–31 document the mechanisms used here:

* A foreground subagent conversation belongs to its tool task. Pi propagates cancellation and uses the ownership index to recover it after restart.
* Background agents use durable anchor and reporter tasks; child tasks can wait with `allSettled` or `failFast`.
* A submission's `requestId` deduplicates replayed input.
* Conversation configuration stores names and model choices; implementations and MCP connections must be rebuilt in each process.
* Changes to the offered tools apply to the next prepared model request. A call already running retains its implementation.
* SQLite uses WAL. Close/checkpoint or backup must produce a standalone file before uploading.

The [pinned GitHub MCP README](https://github.com/github/github-mcp-server/blob/v1.14.0/README.md) documents `pull_request_read` methods for PR metadata, diff, files, commits, review threads, reviews, conversation comments, statuses, and check runs. Review thread pagination uses `after`; list methods use `page` and `perPage`. `pull_request_review_write` includes `create`, `submit_pending`, `delete_pending`, `resolve_thread`, and `unresolve_thread`. Inline pending comments use `pullNumber`, `subjectType`, `line`, `side`, and optional `startLine`/`startSide`. Resolution takes the GraphQL thread node ID; replies take a numeric review comment ID. Sift must retain that distinction.

The [GitHub profile format](https://docs.github.com/en/copilot/reference/custom-agents-configuration) is the source format for `.github/agents/*.agent.md`. Sift documents its supported subset and permission differences with the profile loader; AGENTS.md remains scoped repository guidance rather than a model or MCP configuration file.

The operational adapter uses native MCP writes for pending reviews, inline comments, replies, submission and owned-thread resolution. Its allowlist is explicit (14 tools). `get_job_logs` is forced to return content, not a signed download URL. The model-facing connection is read-only; the publication connection is host-only. Unsupported method/tool schemas fail during connection, and server version must equal the pin.

The pinned server omits numeric IDs in review-thread comments and limits each thread to its first 100 comments. Narrow GitHub REST reads supplement all inline comment pages, pending review comment pages, exact repository/head/base metadata, merge-base comparison and collaborator permissions. They do not form a second general GitHub tool surface. Other writes use the official server; no thread-resolution feature is omitted. Public GitHub.com is supported in v1; enterprise host configuration is not yet exposed.

No live model review, GitHub review write, or authenticated GCS upload has been validated by the default tests. They exercise the real Pi harness and SQLite with deterministic provider responses; the optional Docker test uses real containers. See [the acceptance map](testing.md).
