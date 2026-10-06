# Sift

Durable, multi-agent code review for GitHub pull requests.

Sift pairs a lead reviewer with specialists for correctness, security, tests, and infrastructure. Each reviewer can inspect code and run reproductions in an isolated Docker workspace. The lead challenges the evidence, merges duplicate findings, and publishes a native GitHub review.

Reviews continue across pushes and human replies. Sift remembers outstanding findings, rechecks them against the latest code, and resolves its own threads when the evidence supports it. [Pi Durable](https://github.com/earendil-works/pi) manages agent conversations, tasks, and recovery; SQLite snapshots preserve each PR's state between runs.

Sift runs as a GitHub Action or local CLI. It currently supports trusted repositories and PRs from branches in the same repository. External fork PRs are skipped. Investigators can make temporary local edits, but Sift does not commit or push changes, merge PRs, or apply infrastructure.

## Set up GitHub Actions

Use a Linux runner with Docker, Git, tar, and Node 24. The example workflow uses `ubuntu-latest`; the composite Action installs Node and builds Sift from its lockfile.

1. Copy [examples/sift.yml](examples/sift.yml) to `.sift.yml` in the repository you want reviewed. Copy the [starter profiles](.agents/sift) to `.agents/sift`, and choose the model and specialists you want to use.
2. Create and install a GitHub App with repository **Contents, Actions, Checks, and Issues: read**, and **Pull requests: write**. Set the repository variable `SIFT_APP_ID` and secret `SIFT_APP_PRIVATE_KEY`. The workflow creates a short-lived installation token; no App server is needed.
3. Create a GCS bucket, service account, and Workload Identity Federation configuration. Set the repository variables `SIFT_WIF_PROVIDER` and `SIFT_GCS_SERVICE_ACCOUNT`. Grant the service account object read/create/delete permissions on the bucket and restrict federation trust to the intended repository and trusted workflow/ref. See [operations](docs/operations.md) for state and access details.
4. Change the example's local persistence to GCS so state survives between workflow runs:

   ```yaml
   persistence:
     mode: gcs
     bucket: YOUR_BUCKET_NAME
     prefix: sift
   ```

5. Add the model provider's credential as a repository secret. The example uses `ANTHROPIC_API_KEY`; update the workflow environment if you choose another provider.
6. Copy [examples/review-workflow.yml](examples/review-workflow.yml) to `.github/workflows/sift.yml`. Replace `REPLACE_WITH_REVIEWED_COMMIT_SHA` with the full SHA of a Sift commit you have reviewed. Keep its per-PR concurrency group consistent across every workflow that runs Sift, with `cancel-in-progress: false`.
7. Commit the configuration, profiles, and workflow to your protected default branch before running a review.

The workflow loads configuration from that trusted branch. Sift independently fetches the PR's exact head, base, and merge base, including PRs targeting another branch. Proposed configuration or profile changes take effect after they reach the trusted ref.

Reviewed repository code runs inside investigator containers. Those containers receive neither runner credentials nor the Docker socket. Model providers receive review context, and stored sessions contain conversations and evidence; choose providers and bucket access appropriate for your repository's data.

## Run locally

Build from source with Node 24:

```sh
git clone https://github.com/timReynolds/sift.git
cd sift
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --help
node dist/src/cli.js --validate-config --config examples/sift.yml
```

Configuration validation checks the YAML schema. Profile loading, model availability, and credentials are checked when a review starts.

For a review, first add `.sift.yml` and the selected profiles to the reviewed repository's trusted branch. Supply these environment variables through your credential manager or shell:

| Variable | Purpose |
| --- | --- |
| `SIFT_GITHUB_READ_TOKEN` | Read-only GitHub token for fetching source and model-facing MCP reads. |
| `SIFT_GITHUB_WRITE_TOKEN` | Separate token for host-only review publication; `GITHUB_TOKEN` is a fallback. |
| `SIFT_BOT_LOGIN` | Login owning the reviews, such as `YOUR_APP_SLUG[bot]`. |
| Provider credential | Credential for the configured model, such as `ANTHROPIC_API_KEY`. |

GCS mode also requires Application Default Credentials. Local persistence needs no cloud account and retains snapshots under the state directory.

```sh
node dist/src/cli.js \
  --repository OWNER/REPO --pr 123 \
  --trusted-ref FULL_TRUSTED_COMMIT_SHA \
  --config .sift.yml --state .sift/state --dry-run
```

Dry-run executes investigators and saves state without GitHub mutations. It can omit the write token; without it, private pending reviews cannot be reconciled and coverage is reported as incomplete. Remove `--dry-run` to publish. The read and write tokens must be different, and repository policy may prevent workflow tokens from approving PRs.

By default, `--config` refers to a file in the fetched trusted commit. `--runner-config` opts into a runner-supplied configuration file; profiles still come from the trusted checkout. `--github-mcp PATH` uses a preinstalled server matching the pinned version. Otherwise Sift downloads and checksum-verifies the pinned GitHub MCP release.

## Review behavior

The lead chooses specialists from their descriptions and records why each is selected or skipped. Defaults publish findings through P2, request changes for verified P0/P1 findings, and approve only with complete coverage and no active findings. Non-blocking findings or incomplete coverage produce a comment review. Advisory mode never requests changes.

Mention `@sift` or `/sift` in an ordinary PR conversation to request follow-up. Human replies in Sift-owned review threads are imported without a mention. Bot messages and reactions do not trigger discussion work.

Action outputs report the reviewed revision, verdict, specialist decisions, findings, coverage gaps, publication, persistence, and measured usage. `REQUEST_CHANGES` is a successful review operation. Publication or persistence failures exit nonzero. See [action.yml](action.yml) for the output names.

## Documentation

| Guide | Contents |
| --- | --- |
| [Configuration](docs/configuration.md) | Models, review policy, execution limits, and persistence. |
| [Profiles and runtime](docs/profiles-and-runtime.md) | Custom reviewers, scoped repository instructions, and MCP capabilities. |
| [Operations](docs/operations.md) | Credentials, state storage, recovery, and troubleshooting. |
| [Architecture](docs/architecture.md) | Agent lifecycle, trust boundaries, and publication. |
| [Compatibility](docs/compatibility.md) | Pinned dependencies and supported integrations. |
| [Testing](docs/testing.md) | Automated coverage and live integration boundaries. |
| [Contributing](CONTRIBUTING.md) | Development setup, code style, and validation. |

The default suite uses deterministic models and simulated GitHub/MCP/GCS services alongside real Pi Durable and SQLite. Docker isolation has a separate opt-in check. Live model calls, GitHub review writes, and authenticated GCS transfers require account-specific validation; see the [testing guide](docs/testing.md).

## License

[MIT](LICENSE).
