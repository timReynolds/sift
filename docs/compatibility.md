# Compatibility

Sift uses exact direct dependency versions and a committed [lockfile](../package-lock.json). Install with `npm ci --ignore-scripts` and run the checks before updating dependencies. The supported development Node major is recorded in [.node-version](../.node-version).

| Component | Current pin | Source of truth |
| --- | --- | --- |
| Node | 24 | [.node-version](../.node-version) and [package.json](../package.json) |
| Pi Durable, Pi AI, Chord | 1.0.2 | [package.json](../package.json) |
| Official GitHub MCP server | 1.14.0 | [runtime compatibility](../src/contracts.ts) and [release installer](../src/mcp-binary.ts) |
| MCP TypeScript SDK | 1.32.0 | [package.json](../package.json) |
| Octokit REST | 22.0.1 | [package.json](../package.json) |
| Google Cloud Storage SDK | 8.2.0 | [package.json](../package.json) |

After building, print the runtime and state format versions with:

```sh
node dist/src/cli.js --version
```

## Runner support

The GitHub MCP installer supports Linux and macOS on x64 and arm64. It downloads the pinned release and checks its archive SHA-256. `--github-mcp PATH` accepts a preinstalled server; the server must still report the pinned version.

Investigation containers require a Unix runner with Docker, Node 24 on the host, and a custom image with Node 24 and Bash if replacing the default. Windows investigation runners are unsupported. The [example Action workflow](../examples/review-workflow.yml) targets Ubuntu.

GitHub.com is supported. GitHub Enterprise host configuration is not exposed. Open internal branch PRs are supported; external forks are skipped. Submodules and Git LFS objects are not automatically restored.

## Runtime upgrades

Pi Durable owns the SQLite storage, conversations, tasks, and recovery. Sift stores Pi and GitHub MCP versions with the session and refuses to resume incompatible snapshots. Preserve saved state before upgrading; migration is explicit, and no automatic migration command is provided.

The host reconstructs tool implementations and connections before recovery. Persisted capability selections cannot activate tools absent from the new trusted configuration. Configuration identity includes the trusted revision, so a changed configuration or profile revision requires renewed coverage.

## GitHub adapter

The [MCP adapter](../src/mcp.ts) uses explicit tool and method allowlists, checks advertised schemas, and scopes calls to the reviewed repository and PR. Model-facing tools use a separate read-only connection. Native MCP operations publish reviews, inline comments, replies, and thread resolution; write credentials stay on the host.

The [read adapter](../src/github.ts) supplements MCP with narrow REST reads for exact revisions, merge-base comparison, collaborator permissions, and full comment pagination. It distinguishes numeric review-comment IDs from GraphQL thread IDs. Bounded pagination rejects incomplete reads; transient HTTP 5xx reads retry at most twice, while redirects are rejected.

Profile files use a supported subset of Markdown agent frontmatter. See [profiles and runtime](profiles-and-runtime.md) for accepted fields, coding aliases, and permission differences.

## Validation boundaries

The default tests exercise real Pi Durable and SQLite with deterministic model responses and simulated GitHub/cloud boundaries. A separate opt-in Docker test checks the real container boundary. Live provider calls, GitHub publication, and authenticated GCS transfers require separate validation. See [testing](testing.md).
