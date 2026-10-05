# Sift v1 design and implementation brief

Build Sift, a configurable multi-agent GitHub code reviewer powered by Pi Durable. Deliver a working TypeScript implementation, a reusable GitHub Action, meaningful automated tests, and setup documentation. Implement the project rather than stopping at an architecture proposal or scaffolding.

Use GitButler’s but CLI to organise implementation into small, dependent branches. Sift is the working project name; keep naming easy to change. This brief is the implementation goal and captures the agreed v1 scope.

## Product outcome

A repository owner installs a workflow, supplies model credentials and a GCS bucket, and chooses available reviewer profiles. On a pull request or relevant human reply, Sift restores that PR’s state, reads the current code and existing review discussion, and runs a lead coding agent.

The lead selects relevant specialist agents from their descriptions, collects and challenges their findings, removes duplicate or unsupported feedback and nits, and publishes useful inline comments with priorities. It can ask specialists for further investigation. It submits a real GitHub review: APPROVE, REQUEST_CHANGES, or COMMENT according to configured policy and the actual review outcome.

On later runs it rechecks its earlier feedback, responds to human discussion, and resolves its own threads when the findings are fixed or otherwise no longer valid. It chooses whether a full or targeted review is appropriate. It must not silently forget outstanding feedback.

## Agreed scope

* Execution happens in GitHub Actions for v1. Use a GitHub App installation token for a consistent bot identity where configured; no continuously running App server or webhook service is required.
* Support trusted repositories and internal branch PRs first. External fork support is not required for v1.
* Use Pi Durable for conversations, task orchestration, recovery, configuration, and persistent application documents.
* Use local SQLite as the live state store. Download the PR database from GCS before execution and upload a consistent database afterwards.
* Do not implement a custom direct GCS Pi backend, Postgres backend, remote SQLite service, distributed queue, or elaborate event log in v1.
* Specialists are full coding agents: they may read, search, edit isolated local working files, install dependencies, execute commands, and create/run reproductions.
* Sift may publish GitHub suggested changes but must never commit or push fixes to the reviewed repository, merge a PR, or apply infrastructure changes.
* Support per-agent models and reasoning settings. Do not impose an arbitrary monetary budget; retain operational timeouts, cancellation, and configurable concurrency.
* Drop thumbs-up/down feedback collection and reaction-triggered behaviour from v1. Ordinary human replies remain in scope. Reactions are not necessary for acceptance.
* Support shared reviewer profiles with repository overrides.
* Preserve a path to additional persistence providers through a small interface, without implementing unused backends.

## Start with upstream and the repository

Inspect the repository, its AGENTS.md instructions, existing package conventions, current Git state, and the installed but version before changing anything. Preserve unrelated work.

Read the current Pi Durable README, exported APIs, and relevant examples. Especially inspect foreground/background subagents, child tasks, recovery, per-agent reviewers, tool overrides, and reload/restart. Verify APIs against the version actually installed; do not invent SDK methods from this brief.

Pin Pi and the GitHub MCP server to known versions because their interfaces can change. Use existing project conventions; for a new repository, prefer TypeScript, a supported Node LTS compatible with the selected Pi version, a lockfile, and a straightforward test runner. Keep packaging small. A CLI plus a thin composite or JavaScript Action is sufficient; document the choice.

Treat upstream examples as reference implementations. Reuse Pi’s mechanisms instead of constructing a second scheduler or conversation system.

## Let Pi Durable own the agent lifecycle

Represent a PR as one durable session with a lead conversation and specialist conversations/tasks. Keep actual agent selection and review judgment agent-driven, inside a deterministic host that enforces lifecycle, allowed capabilities, input validation, and publication rules.

Use Pi’s facilities for:

* Owned specialist tasks, parallel execution, completion tracking, follow-up messages, cancellation, and failure propagation.
* Persistent submissions and request IDs for deduplicating imported GitHub messages.
* Per-conversation model, reasoning level, instructions, tools, extensions, and working directory.
* Runtime tool/extension registration and per-conversation configuration changes.
* Typed application documents for review state, findings, thread mappings, publication intent/results, reviewed revisions, imported-message cursors, and selected/skipped specialists.
* Context compaction, handoffs, task progress, and usage reporting.

A specialist failure is a coverage gap, not a clean result. The lead may retry or choose another applicable investigator, but unresolved gaps must remain visible and must prevent an unqualified approval.

Do not assume the SQLite file stores executable extensions, open MCP connections, shell processes, credentials, or workspace files. Reload implementations and reconnect required services before resuming. Record enough version/configuration identity to detect incompatible resumptions.

## Reviewer definitions and instructions

Honour root and nested AGENTS.md files for repository guidance, with directory scoping. AGENTS.md is repository instruction text, not a standard model/MCP configuration schema.

Support GitHub-style .agents/sift/*.agent.md profiles: Markdown instructions with YAML frontmatter for name, description, model, tools, and MCP server definitions. Support reasoning settings through a documented Sift override if the upstream format lacks an appropriate field. Clearly document supported fields and any compatibility differences.

Provide an explicit Sift configuration file that selects available profiles, configures the lead, defines shared MCP connections, sets review policy, and controls persistence/execution. Profiles can come from local paths and an explicitly configured shared repository at a pinned ref. Repository-local profiles override shared profiles by stable name. Do not implicitly activate every unrelated agent profile found in a repository.

Initially give the lead a catalogue of names and descriptions. It selects agents based on the PR and outstanding findings. A Terraform-only agent should normally be skipped when there is no relevant Terraform change or question. Descriptions may express semantic applicability; do not require file globs. Optional globs may assist selection. Record selection/skip reasons and permit later selection when new evidence makes a specialist relevant.

Supply a useful starter set covering correctness, security, tests, and Terraform/infrastructure, plus a lead profile. These are replaceable examples, not a hard-coded fixed panel.

Load execution configuration and secret-bearing MCP definitions from a trusted ref or explicit runner configuration. Capture their revision. Do not let a proposed configuration change in the PR silently expand runtime permissions during its own review.

## Coding tools and runtime capabilities

Give selected specialists real coding tools through Pi’s execution environment. Use separate working copies or equivalent isolation per specialist so temporary edits and tests do not affect other agents. Full coding capability is for investigation and evidence; the original PR remains unchanged.

Implement an adapter that connects approved local stdio and remote MCP servers, exposes selected tools to Pi, and tears connections down cleanly. Resolve credentials from runner secrets/environment references; never store secret values in SQLite, review output, or uploaded workspace artifacts.

Use Pi’s runtime configuration features to offer tools only when useful. If implementing a capability-loading tool, it may activate only declared/approved capabilities; the host still controls permissions. A model-facing tool-set change must follow Pi’s actual next-request semantics. Reconstruct the selected capabilities after restoration.

The lead owns review publication. Specialists return findings rather than independently posting to GitHub. Keep write credentials out of specialist shells and MCP connections that only need reads. Use tooling/credential boundaries rather than relying on prompts alone to prohibit pushes.

## GitHub MCP integration

Use the official GitHub MCP server, with explicit tool and method allowlists appropriate to the installed version. Avoid enabling every GitHub tool, but do not force the design into an arbitrary four-tool limit.

The desired capability groups are:

* PR metadata, changed files/diff, reviews, inline threads, conversation comments, commits, and checks.
* File contents, code search, and relevant history when local Git is insufficient.
* Linked issues or requirements when the PR refers to them.
* Actions runs, jobs, and logs for investigating relevant failures.
* Pending reviews, inline comments, review submission, replies, and resolution of Sift-owned threads.
* A concise progress or summary comment if useful.

Verify current names and schemas. Likely tools include pull_request_read, get_file_contents, search_code, get_commit, list_commits, issue_read, actions_list, actions_get, get_job_logs, pull_request_review_write, add_comment_to_pending_review, add_reply_to_pull_request_comment, add_issue_comment, and update_issue_comment. These are starting points, not permission to assume unavailable methods.

Scope calls to the intended repository/PR and permitted methods. If the pinned server lacks a required operation, use a narrow, documented GitHub API adapter for that operation rather than silently omitting the feature. Keep operational authentication and GCS SDK calls in the host.

## Review reasoning and finding contract

Capture the actual PR base/head revisions and comparison context. Respect PRs targeting non-default branches, including stacked PRs: never assume every diff is against main.

The lead must inspect existing feedback before deciding its review scope. Give specialists the PR intent, relevant diff/context, applicable instructions, and a clear task. They may inspect surrounding code and call sites and run tests. Their findings must describe problems introduced or materially exposed by the PR; pre-existing unrelated problems and generic improvement suggestions do not belong in inline review.

Require structured findings with a stable ID, specialist provenance, category, title, explanation, repository path, exact revision and line/range/side, concrete evidence or reproduction, impact, proposed priority, confidence/evidence assessment, and an optional complete suggestion.

Use P0 urgent, P1 high, P2 normal, and P3 low as explicit priorities. Document their meaning and configure publication/blocking thresholds separately. Do not equate priority with confidence or turn a speculative severe claim into a blocking finding.

The lead validates important claims, asks follow-ups when needed, merges duplicates by underlying issue rather than line number alone, and drops nits, unsupported claims, irrelevant findings, and redundant tool diagnostics. Conditional bugs, races, and permission failures are valid when supported by a concrete scenario.

Retain accepted/rejected decisions and short reasons in state. Do not publish raw agent transcripts or hidden reasoning. Report evidence and concise conclusions. Any comment limit must disclose deferred findings and must not silently hide blocking issues.

Only publish committable suggestions when the suggested replacement is complete and valid for that location. Otherwise explain the required change.

## Existing threads and human replies

Every run reads Sift’s previous comments/reviews and relevant human responses, regardless of whether its database was restored successfully.

Track findings across pushes and line movement. Distinguish still valid, fixed, disproven, superseded, and needs investigation. Recheck code before resolving a thread; GitHub’s outdated marker alone does not mean fixed. Resolve only Sift-owned threads by default, preserving human threads and discussion.

Respond to relevant human replies, challenge or withdraw earlier feedback when evidence warrants it, and ask a focused question if ambiguity genuinely prevents a conclusion. Do not blindly accept every reply as a command. Respect authorised maintainers’ explicit dismissals and preserve the reason so the same finding is not immediately reposted.

Import GitHub replies using stable source IDs/version information so a replayed Action does not repeatedly answer them. Ignore Sift’s own messages to avoid event loops. Do not let a user comment change credentials or tool permissions.

The lead chooses targeted or full re-review based on revision changes, earlier coverage, and remaining questions. Approval/request-changes state is separate from thread resolution: refresh the verdict after issues are resolved. An empty set of newly found issues is insufficient for approval when earlier blockers or incomplete coverage remain.

## Publication and verdicts

Use GitHub’s native review actions: APPROVE, REQUEST_CHANGES, and COMMENT. Configure the threshold for blocking findings and allow repositories to choose advisory behaviour. Default to requesting changes for validated P0/P1 issues, COMMENT for non-blocking findings or incomplete coverage, and APPROVE only when relevant coverage is complete and no configured blockers remain.

Validate path, side, range, and commit before posting inline comments. If a finding cannot be anchored correctly, report it transparently in the review summary with a precise code link rather than dropping it or fabricating a location.

Maintain stable markers and GitHub IDs for findings/publication batches. Record publication intent, publish, record returned IDs, and read back to reconcile ambiguous outcomes. A GitHub write may succeed before a local checkpoint is uploaded; the next run must detect it rather than post a duplicate. Do not mark non-idempotent MCP writes replay-safe without this reconciliation.

Recheck the current head/base before publication and again as needed for multi-step operations. Suppress a stale approval and refresh or explicitly mark an outdated investigation. Verify publication results: successful tool completion does not necessarily prove all expected inline comments appeared.

An unauthorised or unsupported approval must be reported as a publication limitation, not silently downgraded and described as an approval.

## Simple SQLite persistence in GCS

Implement a small persistence adapter with a local-only mode for development and a GCS mode for Actions. Use stable repository identity plus PR number for the state key. One session persists across multiple head revisions.

The default lifecycle is download database, open Pi, run, close safely, upload database. Missing state means a new session; an unreadable/corrupt database is a visible error with a recovery path, not silent overwrite. Preserve the prior object when replacement fails.

Serialize Actions runs per repository/PR across all supported entry points. Use GCS object-generation preconditions, including a create-only precondition for first save, to reject stale overwrites. A conflict must fail clearly and must not trigger an unconditional upload. Treat GitHub events as wake-ups: reconcile current head and all unprocessed relevant replies because Actions concurrency does not guarantee an execution for every queued event.

Before uploading, produce a standalone consistent SQLite file using the appropriate close/checkpoint or backup process. Do not upload only the main file while committed state remains in a WAL. Use bounded retries for transport failures without weakening concurrency guards.

Try to save usable state after ordinary agent/tool failures and graceful cancellation. Document the accepted limitation: abrupt runner loss or forced termination can lose progress since the last completed upload. Periodic checkpointing is optional, not a prerequisite for v1.

Use existing Google application default credentials in the runner. Provide an example workflow using GitHub OIDC and Google Workload Identity Federation. Require configuration of the bucket and access; do not create cloud resources or invent project IDs. An upload failure makes persistence unsuccessful and must appear in the Action outcome.

This is snapshot persistence, not a continuously remote database. Do not introduce a custom Pi storage engine to solve it.

## Workspace restoration

Recreate the repository locally at the recorded revision. Do not run SQLite or Git from a bucket mount. Dependencies and build caches can be regenerated.

Persist a small companion artifact only for investigation files that must survive: local patches, untracked reproduction files, and useful evidence. Include base commit, specialist/workspace identity, and artifact version/reference in Pi state. Upload artifacts before publishing a database that references them, and never mix a database with an unrelated workspace snapshot.

Capture relevant changes from shell commands as well as Pi edit/write tools. Exclude credentials, dependency trees, caches, and unrelated runner files. Preserve relevant file modes and deletions if needed for faithful reconstruction.

If a required artifact cannot be restored, mark that investigation incomplete and restart it deliberately. Do not resume pending commands in a different checkout as though their prerequisites still exist. Running processes are not recoverable from SQLite and must be handled as interrupted operations.

## Action and CLI delivery

Deliver an executable CLI used by the Action, with clear options for repository, PR/event context, configuration, state location, and dry-run mode. Dry-run must compute a review plan without GitHub mutations. Names of commands and options may be chosen to fit the repository.

Provide reusable Action metadata and an example consumer workflow. Support PR opened/synchronize/reopened/ready-for-review events, relevant review-thread replies, relevant PR conversation messages, and manual dispatch/rerun. Normalise event payloads carefully: issue-comment events also include non-PR issues and their workflow SHA is not necessarily the PR head. Use exact fetched revisions.

Skip closed PRs and define draft handling. Avoid Sift-generated event loops. React only to relevant human discussion or an explicit Sift mention/command in general PR comments, not every unrelated message.

Request only the permissions needed for code/PR/check reads, review writes, and OIDC authentication. Document GitHub App installation setup, model credentials, GCS authentication, per-PR concurrency, and the trusted-repository assumption.

Expose useful Action outputs/job summaries: reviewed revision, selected/skipped/failed agents, accepted findings by priority, verdict, publication status, persistence status, and measured usage. Clearly distinguish a code-review verdict from an operational failure.

## Implementation stack with but

Use the installed GitButler CLI for branch creation, assigning changes, commits, and stack management. Read but --help and command help; syntax varies by version. Inspect but status before starting and after each slice. Use observed change/branch IDs and target branches explicitly. Do not use raw Git checkout/rebase/reset operations to bypass an active GitButler workspace. Read-only Git commands are fine.

Build this suggested bottom-to-top stack, adjusting boundaries only to keep each change coherent:

1. Foundation and contracts — package/CLI skeleton, configuration schema, finding/state contracts, test fixtures, pinned upstream dependencies.
2. Profiles and Pi runtime — AGENTS.md handling, shared/local profiles, lead/specialists, per-agent models, dynamic capabilities, isolated environments.
3. GitHub context and reconciliation — MCP adapter, event normalisation, exact revisions, old reviews/threads/replies, read-only dry-run plan.
4. Review reasoning and publication — structured findings, validation, deduplication, priorities, suggestions, thread lifecycle, native review verdicts, publication recovery.
5. GCS session persistence — SQLite download/upload, generation guards, standalone snapshot validation, failure recovery, companion artifacts.
6. Action integration and delivery — consumer workflow, auth examples, outputs, complete scenario tests, setup and operational documentation.

Add tests and documentation with the slices they explain; the final slice completes end-to-end coverage. Keep each branch buildable/testable on top of its dependencies. Keep unrelated user changes out of commits. Preserve stack order and provide a concise stack report.

Create the local stack and commits. Publish branches or draft PRs only if the execution session authorises publication; do not merge or release as part of this brief. If but is unavailable, report that limitation and continue useful implementation without inventing commands or destructively converting the repository.

## Acceptance scenarios

Use deterministic scripted/fake model responses and fake MCP/GitHub/GCS boundaries for repeatable CI. Exercise real Pi Durable with real SQLite for orchestration and restart tests; do not replace the central runtime with a mock and call that an integration test. Make live model/GitHub smoke tests optional and opt-in.

Demonstrate at least:

* A PR selects applicable specialists and skips a Terraform-only reviewer with an explicit reason when irrelevant.
* Specialists use different configured models and can investigate via local coding tools without affecting each other.
* A newly enabled tool becomes available through Pi runtime configuration, and selected capabilities are reconstructed after restart.
* Overlapping findings become one inline comment; nits and unsupported claims are suppressed with recorded reasons.
* A concrete conditional bug is retained; priority and confidence are handled separately.
* Correct GitHub APPROVE, REQUEST_CHANGES, and COMMENT actions occur under configured policy.
* A changed PR fixes an earlier issue; Sift rechecks it, resolves its thread, and updates its verdict.
* A human reply is imported once, investigated, and answered without a bot loop.
* A stale head blocks approval; stacked PRs are compared to the correct target.
* Failed specialists produce incomplete coverage and never a false clean approval.
* GitHub accepts a comment, then the run loses local state; the next run recovers it without duplication.
* A partially published pending review is reconciled, including missing/invalid inline anchors.
* A completed SQLite database uploads, downloads, and reopens with conversations, findings, and pending work intact.
* WAL-backed writes survive the standalone snapshot process.
* A GCS generation conflict refuses to overwrite newer state.
* An ordinary failure attempts persistence, and upload failure is visible.
* A required workspace artifact is restored or the investigation is explicitly restarted.
* Dry-run makes no GitHub mutations, and Sift has no path that pushes code changes.
* The packaged Action invokes the same tested engine as the CLI.

Do not require real secrets to run the default test suite. If live validation cannot run, state exactly what was simulated and what remains unverified.

## Definition of done

Deliver working source, lockfile, reusable Action, CLI, starter profiles, configuration examples, test fixtures, passing type/build/tests, and a README covering installation, configuration, permissions, state layout, recovery, and troubleshooting.

Include an architecture note explaining what Pi owns, the SQLite/GCS lifecycle, how tools are scoped dynamically, and how GitHub publication is reconciled. Document exact compatibility with the chosen agent-profile format and any gaps in the pinned MCP server.

Provide the final GitButler stack, changes in each slice, validation results, and concrete remaining setup steps. Do not claim an App installation, cloud deployment, live approval, or live model review happened unless it actually did.

Work autonomously through the complete implementation. Make ordinary engineering choices and document them. Ask only when credentials, access, a genuinely destructive action, or a material unresolved product decision blocks progress. A polished skeleton with TODOs in review publication, thread resolution, or persistence does not satisfy the goal.

## Reference material

Use these as technical starting points and verify against installed versions:

* Pi Durable README
* Pi Durable examples
* AGENTS.md
* GitHub custom agent configuration
* Official GitHub MCP server
* Claude code review workflow
* Claude PR review toolkit
* GCS request preconditions
* GitButler stacked branches

Borrow independent review, validation, and noise filtering from existing reviewers. The product requirements above determine Sift’s behaviour; upstream prompts are not instructions to copy blindly.
