# Configuration

Sift reads a YAML file with `version: 1`. Start with [examples/sift.yml](../examples/sift.yml) and save it as `.sift.yml` in the repository being reviewed.

The CLI and Action load configuration and profiles from the exact commit supplied through `--trusted-ref` or the Action's `trusted-ref` input. Use a reviewed commit on a protected branch. Configuration from the PR head must not authorize its own review. The CLI also supports `--runner-config` for an explicitly trusted configuration file on the runner; profiles still come from the trusted revision.

After building Sift, validate the YAML without credentials or network access:

```sh
node dist/src/cli.js --config examples/sift.yml --validate-config
```

This checks the configuration schema. Profile loading, model availability, credentials, and MCP tool compatibility are checked when a review starts. Unknown keys, duplicate YAML keys, invalid repository-relative paths, and mutable shared-profile references are rejected.

## Models and profiles

| Setting | Default | Purpose |
| --- | --- | --- |
| `version` | Required: `1` | Configuration format |
| `model` | Required | Pi model ID in `provider/model-id` form |
| `reasoning` | `high` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `name` | `Sift` | Configuration label; does not change bot identity or published review text |
| `mention` | `sift` | PR conversation trigger, such as `@sift` |
| `lead` | `lead` | Stable name of the lead profile |
| `profiles` | Required, nonempty | Available specialist profile names |
| `sources.local` | `[.agents/sift]` | Profile directories in the trusted checkout |
| `sources.shared` | Unset | Optional pinned shared profile repository |
| `agents.<name>` | `{}` | Per-agent `model`, `reasoning`, and `tools` overrides |

Supported providers are `anthropic`, `openai`, `google`, and `openrouter`. The runner refreshes Pi's model catalogue and rejects unknown models or unsupported reasoning levels. Supply the selected provider's credentials in the runner environment.

The lead cannot appear in `profiles`, specialist names must be unique, and overrides must name the lead or an available specialist. The lead chooses which specialists to run; a profile on disk is not automatically enabled. See [profiles and runtime](profiles-and-runtime.md) for frontmatter, tools, and precedence.

Shared profiles require `repository: owner/repo` and a full 40-character commit SHA in `ref`. `path` defaults to `.agents/sift`. Local profiles override shared profiles by stable name. The read token must be able to fetch both repositories.

## Review policy

| Priority | Meaning |
| --- | --- |
| P0 | Urgent: critical breakage requiring immediate attention |
| P1 | High: an issue that should block merging |
| P2 | Normal: an actionable defect that usually does not block |
| P3 | Low: a low-impact defect; style nits are excluded |

Priority describes impact. Confidence is recorded separately as `unsupported`, `plausible`, or `verified`; unsupported findings are rejected.

| Setting | Default | Behavior |
| --- | --- | --- |
| `policy.mode` | `enforcing` | `advisory` prevents `REQUEST_CHANGES` |
| `policy.publishThrough` | `P2` | Highest numeric priority included in inline findings |
| `policy.blockThrough` | `P1` | Threshold for verified findings to request changes |
| `policy.maxInlineComments` | `30` | Positive limit on inline findings in a review plan |
| `policy.drafts` | `skip` | Set to `review` to include draft PRs |

Thresholds include all more urgent priorities: `P2` includes P0, P1, and P2. Publication and blocking thresholds are independent. Active findings or incomplete coverage produce `COMMENT` unless verified blockers require `REQUEST_CHANGES`. `APPROVE` requires complete coverage and no active findings. Findings deferred by the inline limit remain visible in the summary.

## Execution and persistence

| Setting | Default | Accepted values |
| --- | --- | --- |
| `execution.concurrency` | `4` | 1–32 specialists per investigation batch |
| `execution.timeoutSeconds` | `1800` | 1–21600 seconds for a review run |
| `execution.commandTimeoutSeconds` | `300` | 1–1800 seconds per investigation command |
| `execution.modelTimeoutSeconds` | `180` | 1–1800 seconds for Pi's model stream timeout |
| `execution.containerImage` | Pinned Node 24 image | Image reference ending in `@sha256:` and a 64-character digest |
| `persistence.mode` | `local` | `local` or `gcs` |
| `persistence.bucket` | Required for `gcs` | Existing GCS bucket name |
| `persistence.prefix` | `sift` for `gcs` | Repository-relative object prefix |

Timeouts do not impose a spending cap. Custom investigation images need Node 24, Bash, and the toolchains required by the reviewed repository. See [operations](operations.md) for runner requirements and recovery.

Local snapshots are stored beneath `--state/objects`; ephemeral runners need GCS to retain state between jobs:

```yaml
persistence:
  mode: gcs
  bucket: your-sift-state-bucket
  prefix: sift
```

State is keyed by numeric repository ID and PR number, so pushes and repository renames retain the same session. The host also records the trusted revision and configuration hash.

## MCP servers

`mcp` declares additional model-facing servers. Every server needs explicit `tools`; wildcard names are rejected. A tool with a `method` parameter also needs a `methods` allowlist. Tools must advertise `readOnlyHint: true` to be exposed to models.

```yaml
mcp:
  knowledge:
    type: http
    url: https://mcp.example.com/mcp
    headers:
      Authorization: KNOWLEDGE_AUTH_HEADER
    tools: [lookup]
  localdocs:
    type: stdio
    command: /opt/bin/docs-mcp
    args: [--stdio]
    env:
      DOCS_TOKEN: DOCS_READ_TOKEN
    tools: [lookup]
```

`env` and `headers` values are runner environment-variable **names**, not secret values. In this example, `KNOWLEDGE_AUTH_HEADER` contains the complete header value, including any `Bearer ` prefix. Missing variables fail connection. HTTP URLs require HTTPS and cannot contain embedded credentials, query strings, or fragments.

Profile MCP definitions override configuration definitions with the same name for that profile. The built-in `github` capability cannot be replaced. Keep additional server credentials read-only; the runner rejects the operational GitHub write token on model-facing connections. Servers run on or connect from the host, and their approved tools become available when an agent enables the capability.
