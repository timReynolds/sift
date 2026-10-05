# Operations and recovery

Use the [consumer workflow](../examples/review-workflow.yml) as one entry point for PR updates, review replies, mentioned conversation comments and manual dispatch. Actions concurrency is required across every Sift workflow for the same repository/PR. GitHub may replace pending queued runs; events are wake-ups, so each executed run fetches current code and all relevant unprocessed replies instead of trusting a single payload.

## Authentication and setup

The GitHub App needs repository Contents/Actions/Checks/Issues read and Pull requests write, and must be installed on the reviewed repository. Metadata read accompanies installation tokens. No webhook subscription, server, merge permission, contents write permission or infrastructure credential belongs to Sift. The workflow token is read-only and feeds model-facing MCP/source fetch; the App token feeds the operational host. For a shared private profile repository, supply a read token installed on both repositories; the default workflow token can only read its own private repository.

The example uses [actions/create-github-app-token](https://github.com/actions/create-github-app-token/blob/fee1f7d63c2ff003460e3d139729b119787bc349/README.md) and [Google authentication through WIF](https://github.com/google-github-actions/auth/blob/7c6bc770dae815cd3e89ee6cdf493a5fab2cc093/README.md), pinned to commits. Create the bucket, service account and federation outside Sift. Grant object get/create/delete on that bucket; object replacement requires create and delete. Scope WIF trust to the intended repository and trusted workflow/ref. Google auth provides ADC to the GCS SDK. Never put service account key material in Sift YAML or SQLite.

Protect the default branch and workflow/configuration changes according to your repository's trust policy. v1 supports trusted internal branch PRs. Containers have network access and are not a hardened hostile-code service. Use an ephemeral runner; do not expose other privileged services or credentials through container networking. Private dependency credentials are deliberately absent from coding containers; provide a trusted dependency image/cache if required, or report that coverage gap.

The example gives the job 50 minutes, with a 30-minute default Sift timeout, leaving time to save state. Keep operational timeout below credential/runner lifetimes. There is no monetary budget. To review other languages, supply a digest-pinned container with Node 24 (for the Pi worker), Bash and relevant toolchains, or let investigators install public dependencies. No provisioning command is run by the host.

## Failure behavior

| Symptom | Meaning and next step |
| --- | --- |
| Specialist failed / no structured findings | Coverage is incomplete. Retry the run or adjust the model, tools or investigation image. Approval is blocked. |
| Model/reasoning unavailable | The pinned Pi catalogue or provider does not support that configuration. Choose a listed model/reasoning level; configure its environment credential. |
| Stale review | Head or base changed during collection/publication. Rerun against fresh state. A detected late race is an operational failure even if GitHub accepted a review. |
| APPROVE not confirmed | Check App installation permissions, repository approval settings and bot identity. Sift does not silently replace an unsupported approval with COMMENT. |
| Inline comment rejected | The finding stays active and is reported in the review summary with a precise code link. |
| Generation conflict | Another writer saved newer state. Preserve local diagnostics, fix duplicate concurrency entry points, then rerun from the latest snapshot. Never force an unconditional upload. |
| Upload failed | Review publication may have succeeded, but persistence failed and the Action fails. Fix bucket/auth/network access, then rerun; GitHub markers reconcile already-published work. |
| Required artifact missing | Sift discards the partially restored workspace and deliberately starts fresh investigation. It does not resume commands on assumed files. |
| SQLite corrupt/unreadable | The object is preserved and no replacement is attempted. Follow the explicit recovery procedure below. |
| Incompatible runtime version | Preserve the snapshot and migrate/inspect it with the pinned version before changing runtime versions. Do not reinterpret it as an empty session. |

Cancellation via SIGTERM/SIGINT requests orderly abort and attempts a consistent save. A forced kill, abrupt runner loss or expired job can lose work since the last completed upload. Running shell processes and open MCP connections cannot be recovered from SQLite. Before artifact capture, containers are stopped to prevent a background process changing files during capture.

## Restoring state

Enable object versioning/retention on the bucket if your team wants rollback history; configure lifecycle/retention outside Sift. Stop concurrent runs before manual recovery. Preserve the suspect database and companion object generations for diagnosis. Restore a known-good `session.sqlite` generation using your normal storage tooling, then rerun. Do not copy a live WAL-backed main file by itself.

If no valid database exists, explicitly archive the bad object and remove the active key only after preserving it. A later run sees a missing state object and starts a new Pi session, while recovering all Sift feedback from GitHub markers and public finding metadata. Recovered findings require investigation and prevent a false clean approval. This loses unpublished conversations and reproductions; the bot's public feedback remains outstanding. Never remove the object automatically on parse/integrity errors.

Local mode mirrors the GCS key layout beneath `--state/objects`. Each run uses a fresh `run-*` directory. A local `.lock` beside a state object denotes a save in progress. After confirming no Sift process is active, an abandoned lock from a forced kill can be removed manually. Preserve failed run directories until diagnosis; successful/failed local workspaces may contain reviewed source and should be managed as private repository data. These scratch directories are not uploaded as generic workflow artifacts.

Artifacts are gzip JSON manifests bounded to 50 MiB of changed payload. Credentials (`.env*`, key files, credential directories), dependency trees and caches are excluded, and known credential values/private-key patterns in changed evidence cause capture to fail. Large unchanged repositories do not consume the changed-payload budget. Source exports read exact Git blobs and are bounded to 512 MiB per command. Submodules and Git LFS content are not automatically fetched; their absence creates a visible coverage gap. Raise these limits through a reviewed implementation change if the repository requires it; Sift reports limits rather than saving partial evidence.

## Operational output

The CLI emits JSON and a nonzero exit on operational failure. REQUEST_CHANGES is a code-review verdict, not a process failure. Action outputs and job summaries expose review revision, specialist outcomes, active findings, verdict, publication/persistence status and cumulative Pi usage. Dry-run outputs `publication-status: planned`; it never claims a review was submitted. GCS or artifact upload failure cannot be reported as successful persistence.

Live validation is optional: run the CLI first with `--dry-run` on a disposable trusted PR, inspect the plan, then invoke it without that flag only when you intend to publish. Use your own credentials and existing bucket. No live review, App installation or cloud resource provisioning is part of the default test suite.
