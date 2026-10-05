# Profiles and the Pi runtime

Sift's starter profiles live in `.agents/sift`, the default directory for local and shared definitions. They are examples selected explicitly through configuration, not a mandatory panel. The lead receives the available specialists' names, descriptions, and optional globs. The model makes applicability decisions and records reasons through `plan_review`; no path classifier silently chooses the reviewers.

## Agent profile compatibility

Profiles use Markdown with YAML frontmatter. Sift supports `name`, required `description`, `model`, `tools`, and `mcp-servers`. Instructions must contain 1–30000 characters. `model` is a Pi `provider/model-id`, rather than a Copilot display name. A missing name uses the filename without `.agent.md`; an explicit name is a stable lower-case identifier. Unlike GitHub's filename-based precedence, Sift overrides by that stable name. Duplicate names at the same precedence level fail. Local profiles override the pinned shared source.

`tools` accepts an array or comma-separated string. `read`, `edit`, `search`, and `execute` map to Pi's real coding tools, including common GitHub aliases. Search uses the shell, so selecting search also grants command execution in the isolated investigator container. Omitted tools grant coding tools. `*` in a profile selects host-approved tools only; it cannot approve an MCP server or bypass host policy. Empty tools disable coding tools; Sift's structured review protocol tools remain available. Unrecognized names do not grant capabilities.

`sift.reasoning` and `sift.globs` are Sift additions. Globs are applicability hints, never mandatory routing rules. Repository `agents.<name>` overrides the profile's model, reasoning, and tools. `target`, `metadata`, `disable-model-invocation`, `user-invocable`, and legacy `infer` are accepted for file compatibility but do not alter Sift's explicit configured catalogue. Other frontmatter fields fail validation.

Profile MCP `local` maps to `stdio`; HTTPS `http` is also supported. Credentials must use `$ENV_NAME`, `${ENV_NAME}`, `${{ secrets.ENV_NAME }}`, or `${{ vars.ENV_NAME }}` references. Literal values and default-value interpolation are rejected. Each server requires explicit tool names. Root and nested AGENTS.md files provide directory-scoped instructions, never executable MCP or model configuration. Symlinks cannot import guidance from outside the checkout.

## Ownership and recovery

`investigate` is a sequential Pi tool round containing a bounded batch of concurrent specialist conversations. Pi owns each specialist under the tool task, propagates cancellation, tracks completion, and recovers submissions with stable request IDs. Sift does not maintain a second conversation scheduler. Follow-ups fork the specialist's history into a newly task-owned conversation, preserving context while giving cancellation a current owner. Failed or unstructured specialist output is explicitly incomplete coverage, retained across pushes. It can be cleared by successfully retrying that investigator or by recording concrete replacement coverage from another completed specialist.

Pi documents hold review scope, selections, findings, publication state, imported-message IDs, investigation reports, workspace identity, and selected capabilities. Pi's own documents retain model settings, instructions, tasks, provider session identity, usage, and compaction. The host reconstructs implementations and execution environments before resuming. A capability activation can select only a declared capability approved for that profile. Its tools enter the next prepared model request; the selected names survive SQLite restart.

## Investigation isolation

All Pi filesystem and shell operations run in an investigator container, including absolute paths and symlink targets. Each workspace gets a separate checkout and container. Only that workspace is mounted writable. Sift's worker and dependency directory are mounted read-only. No Docker socket, runner home, model credentials, GitHub token, GCS credentials, or cloud deployment credentials are mounted or passed into the container. The default Node 24 image is pinned by digest; trusted configuration can supply another image with Node 24, Bash, and the investigation dependencies needed by the repository.

The readable worker source is `runtime/sandbox-worker.mts`. `npm run build` compiles it to `dist/runtime/sandbox-worker.mjs`, which the host mounts into the container. Containers run with the Unix runner's UID and GID so investigators can edit runner-owned files and the host can remove their output. Their fixed `HOME=/tmp` supports tool caches without exposing the runner's home directory. GitHub-hosted Ubuntu runners provide the Docker engine needed by this path.

Containers retain normal network access for dependency installation and investigation. They are not a security boundary for hostile repositories; v1 supports trusted internal PRs. Commands have a host-enforced timeout. Cancellation stops the container, since terminating the Docker client alone would not reliably terminate its child commands. Background processes do not survive restoration. Investigation files are preserved separately from Pi's database by the snapshot persistence layer.

The default tests use real Pi/SQLite and explicitly injected temporary local test environments. Run `npm run build` before the additional real Docker boundary test, then `SIFT_DOCKER_TEST=1 SIFT_TEST_SECRET=must-not-leak npm test`. No live model or cloud credentials are required.
