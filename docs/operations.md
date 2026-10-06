# Operations and recovery

The [example workflow](../examples/review-workflow.yml) handles PR updates, review replies, mentioned PR conversation comments, and manual dispatch. It checks out the default branch and passes its exact commit as the trusted configuration revision. Sift fetches the PR head independently.

Use the same concurrency group in every workflow that runs Sift for a given repository and PR. The example sets `cancel-in-progress: false`. Each run fetches current revisions and unprocessed discussion, so it can catch up when GitHub replaces a pending run.

## Runner and credentials

Use a Unix runner with Node 24, Git, tar, and Docker. The Action installs Node and builds Sift; the runner must already provide Docker. The default investigation image is pinned by digest. Each investigation container is limited to 2 CPUs, 4 GiB of memory, and 256 processes, so choose concurrency to fit the runner.

Sift supports trusted internal branch PRs on GitHub.com. External fork PRs are skipped. Investigation containers have network access and are unsuitable for executing hostile repositories. Use an ephemeral runner and avoid exposing privileged services through its network. Private dependency credentials are not passed into containers; use a trusted image or cache containing the required dependencies, or expect a reported coverage gap.

Supply credentials through the runner environment:

| Credential | Use |
| --- | --- |
| `SIFT_GITHUB_READ_TOKEN` | Required read-only token for source fetch and model-facing GitHub tools |
| `SIFT_GITHUB_WRITE_TOKEN` | Host-only review publication and reconciliation; `GITHUB_TOKEN` is a CLI fallback |
| `SIFT_BOT_LOGIN` | Owner of Sift's reviews and comments; defaults to `github-actions[bot]` |
| Provider environment variables | Model access for the configured provider |
| Google Application Default Credentials | Required when `persistence.mode` is `gcs` |

Read and write tokens must differ. A GitHub App provides a stable publication identity; the example creates its installation token with Contents, Actions, Checks, and Issues read permissions and Pull requests write permission. Install the App on the reviewed repository. No webhook server is required. A private shared-profile repository also needs access through the read token; a workflow token generally cannot read another private repository.

The example uses `SIFT_APP_ID`, `SIFT_APP_PRIVATE_KEY`, `SIFT_WIF_PROVIDER`, `SIFT_GCS_SERVICE_ACCOUNT`, and `ANTHROPIC_API_KEY` as repository variables or secrets. Protect the workflow, default branch, configuration, and profiles according to your repository's trust policy.

## Persistence setup

Local mode stores snapshots under `--state/objects` and is useful for local runs. State in an ephemeral Actions runner disappears after the job. For reviews that resume across jobs, configure GCS as shown in [configuration](configuration.md), create the bucket and authentication outside Sift, and grant object get/create/delete permissions on that bucket. Replacement uploads need both create and delete permission.

The workflow example authenticates through Workload Identity Federation. Scope federation trust to the intended repository and trusted workflow/ref. The Google Storage SDK uses Application Default Credentials. Keep service account keys and other secret values out of configuration and state files.

Keep Sift's timeout below the job and credential lifetimes so shutdown has time to save state. The example allows 50 minutes for the job; Sift defaults to 30 minutes. Cancellation through SIGTERM or SIGINT requests an orderly abort and save. A forced kill, runner loss, or job timeout can lose progress since the last completed upload.

## Failure handling

The CLI exits nonzero for operational failures. `REQUEST_CHANGES` is a review verdict and can be a successful run. Publication and persistence are separate: GitHub may accept a review even if a later state upload fails.

| Symptom | Next step |
| --- | --- |
| Specialist failed or omitted structured findings | Retry or adjust its model, tools, or image. The coverage gap prevents approval. |
| Model or reasoning unavailable | Choose a model and level supported by the configured provider and Pi catalogue. |
| Stale review | Rerun. Sift detects head/base changes around publication; a late race may fail after GitHub accepted the review. |
| Approval not confirmed | Check publication identity, App permissions, and repository review settings. Sift fails rather than changing the verdict silently. |
| Inline anchor rejected | Read the finding in the review summary; it stays active with a code link. |
| Generation conflict | Stop duplicate writers, preserve diagnostics, and rerun from the latest snapshot. Do not overwrite newer state unconditionally. |
| Upload failed | Repair bucket access, authentication, or networking, then rerun. GitHub markers reconcile prior publication. |
| Required investigation artifact missing or invalid | Sift starts a fresh workspace and requires renewed investigation. |
| SQLite corrupt or incompatible runtime | Preserve the snapshot and follow recovery below. Sift does not treat unreadable state as an empty session. |

Action outputs and job summaries include the reviewed revision, verdict, specialist outcomes, active finding counts, coverage gaps, publication/persistence status, and cumulative Pi usage. A dry-run reports publication as `planned` and still saves state. It makes no GitHub mutations. Without a publication credential, private pending reviews cannot be reconciled and appear as a coverage gap.

## Recovery

Stop concurrent runs before manual recovery. Preserve the suspect database and companion artifacts. If available, restore a known-good `session.sqlite` object generation with your storage tools, then rerun. Enable object versioning and lifecycle policies outside Sift if you need rollback history. A live WAL-backed SQLite main file alone is not a complete backup.

If no valid database exists, archive the bad object before removing its active key. The next run starts a new Pi session and imports Sift's published findings from GitHub markers. Recovered findings require investigation before approval. This loses unpublished conversation history and reproduction files, so preserve them first where possible. Sift never deletes corrupt state automatically.

Saved databases with incompatible Pi or GitHub MCP versions require explicit migration or inspection with the matching version. Preserve them before upgrading dependencies.

Local saves use a `.lock` directory beside each object. After confirming that no Sift process is running, remove an abandoned lock left by a forced kill. Run directories under `--state` contain reviewed source and evidence; retain them for diagnosis and then clean them up according to the repository's data policy. Sift does not upload them as generic workflow artifacts.

## Investigation artifacts and limits

Sift stops containers before capturing changed investigation files and saves those artifacts before the database that references them. Dependencies, caches, credential paths, and unchanged files are excluded. Known credential values and private-key patterns in changed evidence fail capture. These exclusions are not a general secret scanner; treat stored source, evidence, and model conversations as repository data.

Artifacts are gzip-compressed JSON with a 50 MiB limit on changed file payload and on the uncompressed manifest, including base64 contents. Git export command output is limited to 512 MiB. Submodules and Git LFS content are not automatically fetched; missing content is reported as a coverage gap. Background processes and open MCP connections do not survive restoration.

For validation commands and the boundaries covered by the test suite, see [testing](testing.md).
