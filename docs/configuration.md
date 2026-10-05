# Sift configuration

Sift reads YAML with `version: 1`. Unknown keys, duplicate YAML keys, invalid paths, and unpinned shared profile references are errors. Start with [examples/sift.yml](../examples/sift.yml). The configuration is execution authority: load it from a trusted commit or an explicitly supplied runner file, never from the proposed PR head. The host records the trusted revision and a canonical configuration hash in Pi state.

`model` uses `provider/model-id` from Pi's model catalogue. `reasoning` accepts `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. The selected provider/model must support the requested level. `agents.<name>` can override `model`, `reasoning`, and `tools` per agent. The lead is named separately; `profiles` explicitly lists the available specialists. An unrelated profile on disk is never implicitly activated. `name` and `mention` control the display name and general PR comment trigger; internal state markers remain stable across display-name changes.

`sources.local` lists directories relative to the trusted checkout. An optional `sources.shared` specifies `repository: owner/repo`, a full 40-character commit SHA in `ref`, and a relative `path`. Local profiles override shared profiles by stable name. Only the configured lead and available specialists are loaded for execution.

## Policy

| Priority | Meaning |
| --- | --- |
| P0 | Urgent: demonstrated critical breakage requiring immediate attention |
| P1 | High: a demonstrated issue that should block merging |
| P2 | Normal: a concrete actionable defect that usually does not block |
| P3 | Low: a real low-impact defect; style nits remain excluded |

Priority is impact, not certainty. Findings separately record `unsupported`, `plausible`, or `verified` confidence and concrete evidence. Publication and blocking thresholds are independent. `publishThrough` defaults to P2; `blockThrough` defaults to P1. `mode: advisory` prevents REQUEST_CHANGES. Incomplete coverage prevents APPROVE. Comment limits must leave deferred issues visible in the review summary. `drafts` is `skip` by default or `review`.

## Runtime and persistence

`execution.concurrency` limits active specialists. Overall, command, and model timeouts are expressed in seconds. These are operational limits; no monetary cap is imposed. An optional `containerImage` must include an immutable `@sha256:` digest.

`persistence.mode` is `local` or `gcs`. GCS additionally requires a `bucket`; its `prefix` defaults to `sift`. State uses the stable numeric repository ID and PR number, independent of branch revisions and repository renames. Secrets are not configuration values.

## MCP definitions

Each entry of `mcp` explicitly declares a server and tool names. Wildcards are rejected at this host permission boundary. Optional `methods` restricts method-based tools further.

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

The `env` and `headers` values above are runner environment-variable **names**. The host resolves them immediately before connecting; the resolved values must never be written into Pi state. HTTP endpoints require HTTPS without embedded credentials, query strings, or fragments. Keep write credentials out of investigator containers and read-only MCP connections. Arbitrary PR messages cannot add tools or change these settings.
