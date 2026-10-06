# Profiles and runtime

Profiles describe the lead and specialists. Sift's [starter profiles](../.agents/sift) live in `.agents/sift`, the default directory for local and shared definitions. Configuration explicitly names the lead and available specialists. The lead selects or skips each specialist using its description and optional glob hints, recording a reason with `plan_review`.

## Writing a profile

Create a `*.agent.md` file with YAML frontmatter and Markdown instructions:

```markdown
---
name: correctness
description: Find behavioral regressions introduced by the PR.
tools: [read, search, execute]
sift:
  reasoning: high
  globs: ["src/**"]
---
Trace changed behavior and its callers. Report concrete defects with code or test evidence.
```

`description` is required. Instructions must contain 1–30000 characters after trimming. `name` defaults to the filename without `.agent.md`; names use lowercase letters, digits, underscores, and hyphens, start with a letter, and are at most 64 characters.

| Field | Behavior |
| --- | --- |
| `name` | Stable identity used by configuration and state |
| `description` | Applicability guidance for the lead |
| `model` | Optional Pi `provider/model-id` |
| `tools` | Optional array or comma-separated string of coding tool names |
| `sift.reasoning` | Optional reasoning level |
| `sift.globs` | Optional applicability hints |
| `mcp-servers` | Optional read-only MCP definitions |

Model and reasoning resolve in this order: repository `agents.<name>` override, profile setting, then repository default. Tools use the per-agent override, then the profile setting, then the fixed default `[read, edit, search, execute]`. Duplicate names at one source level fail; local profiles override shared profiles by stable name. Unselected files are not activated. See [configuration](configuration.md) for source selection and overrides.

For compatibility with agent profile files, Sift also accepts `target` (`vscode` or `github-copilot`), `metadata`, `disable-model-invocation`, `user-invocable`, and `infer`. These fields do not change Sift's configured specialist selection. Other frontmatter fields are rejected.

## Coding tools

| Profile names | Pi tools granted |
| --- | --- |
| `read`, `notebookread` | `read` |
| `edit`, `multiedit`, `notebookedit` | `edit`, `write` |
| `write` | `write` |
| `search`, `grep`, `glob`, `execute`, `shell`, `bash`, `powershell` | `bash` |
| `*` | All four coding tools above |

Names are case-insensitive. Search grants shell execution in the investigation container. An empty tool list disables coding tools; unknown names grant nothing. Structured review protocol tools remain available. `*` does not authorize extra MCP tools or expand host permissions.

Root and nested `AGENTS.md` files supply directory-scoped repository instructions. They do not configure models or MCP servers. Deeper guidance applies only within its directory, and guidance symlinks cannot point outside the checkout.

## Profile MCP servers

Profile `mcp-servers` use the same explicit tools and optional method allowlists as repository MCP settings. `type: local` is accepted as an alias for `stdio`; `http` requires an HTTPS URL. Model-facing tools must advertise `readOnlyHint: true`.

Credentials in profile `env` and `headers` must be references such as `$ENV_NAME`, `${ENV_NAME}`, `${{ secrets.ENV_NAME }}`, or `${{ vars.ENV_NAME }}`. Literal credentials and interpolation defaults are rejected. These references are resolved from the runner environment; they do not fetch GitHub secrets automatically. Profile definitions override repository definitions of the same name for that profile. The reserved `github` capability cannot be replaced.

An agent activates an approved MCP capability with `enable_capability`; its tools enter the next model request. Selected capability names are persisted and reconstructed when a session resumes.

## Conversations and recovery

Pi Durable owns conversations, tool tasks, cancellation, submissions, compaction, and usage. `investigate` runs a bounded batch of selected specialists concurrently. Follow-ups fork the previous specialist conversation into a new task-owned conversation with its history. Stable submission request IDs support recovery.

Sift keeps review scope, specialist selections, findings, imported-message IDs, publication receipts, coverage, and workspace references in Pi documents. Implementations, execution environments, and MCP connections are rebuilt before resuming a saved session. A changed head, base, or trusted configuration requires fresh coverage while retaining findings and discussion.

A failed specialist or missing structured report creates incomplete coverage. That failure remains visible across pushes and cannot be cleared simply by skipping the specialist. A successful retry or recorded replacement coverage from another completed specialist can clear it.

## Investigation containers

Each investigator, including a lead using coding tools, gets a separate copy of the exact PR head and a Docker container. The checkout has no `.git` administration directory. All Pi filesystem and shell operations run through the container, including absolute paths and symlink targets.

Only the investigator's workspace is mounted writable. The compiled [sandbox worker](../runtime/sandbox-worker.mts) and Sift dependencies are mounted read-only. Containers use the runner's Unix UID/GID, `HOME=/tmp`, and a digest-pinned Node 24 image. The runner home, Docker socket, model credentials, GitHub tokens, and Google credentials are not mounted or passed into the container.

Containers retain network access for investigation and public dependency installation. Sift supports trusted repositories and internal PRs; this setup is not a hardened service for hostile code. Commands have a configured timeout, and cancellation stops the container. Temporary edits and reproductions can be restored from companion artifacts; running processes and excluded dependency caches must be recreated.

See [operations](operations.md) for runner requirements and artifact limits, and [testing](testing.md) for the optional Docker check.
