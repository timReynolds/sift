# Acceptance coverage

Run `npm run check` on Node 24: strict TypeScript, production build and the Node test runner. No real credentials are required. Tests inject fake external/model boundaries but do not replace Pi Durable or SQLite with mocks.

| Acceptance behavior | Executable coverage |
| --- | --- |
| Relevant specialist selection, explicit Terraform skip | `runtime.test.ts`, `engine.test.ts` |
| Different configured models and isolated coding tools | `runtime.test.ts`; optional real Docker in `sandbox.test.ts` |
| Next-request capability activation and restart | `runtime.test.ts` with real Pi/SQLite |
| Semantic duplicate merge, recorded nit/unsupported rejection | `review-publication.test.ts` |
| Conditional defects and independent priority/confidence | `review-publication.test.ts`, `contracts.test.ts` |
| Native APPROVE, REQUEST_CHANGES and COMMENT policy | `engine.test.ts`, `review-publication.test.ts`, `github-publication.test.ts` |
| Fix recheck, own-thread resolution, refreshed approval | Full restored-session scenario in `engine.test.ts` |
| Human reply imported/answered once; bot filtering | `engine.test.ts`, `review-publication.test.ts`, `mcp-events.test.ts` |
| Stale-head approval rejection and stacked comparison | `review-publication.test.ts`, `github-context.test.ts` |
| Specialist failure is incomplete coverage | `runtime.test.ts`, `engine.test.ts` |
| Accepted GitHub write with lost local response/state | `review-publication.test.ts` |
| Partial pending review; invalid/missing anchors | `review-publication.test.ts`, `github-publication.test.ts` |
| SQLite upload/download/reopen of durable state and pending work | `runtime.test.ts`, `persistence.test.ts`, `engine.test.ts` |
| Committed WAL survives standalone backup | `persistence.test.ts` keeps a real WAL open during snapshot |
| GCS generation conflict and lost response guards | `persistence.test.ts` fake GCS SDK-shaped boundary |
| Ordinary failure attempts persistence; failed upload visible | `persistence.test.ts`, `action.test.ts` |
| Required artifact restores or explicitly restarts | `artifacts.test.ts`, `engine.test.ts` |
| Dry-run has no GitHub mutations; credential-free investigations | `engine.test.ts`, `review-publication.test.ts`, `sandbox.test.ts` |
| Action and CLI share one engine | `action.test.ts`, `action.ts` → `cli.ts` → `runner.ts` → `engine.ts` |

MCP protocol tests use the real TypeScript MCP client/server transports with scripted tool responses. GitHub context tests simulate HTTP and MCP pagination, including more than 100 replies. Publication tests simulate accepted writes, transport failure, missing comments and denied approval. GCS tests retain exact string generations, preconditions and metadata semantics while keeping bytes local. Engine tests use real Pi faux providers, tasks, documents, SQLite snapshots, workspace artifact capture, and reopen across revisions.

The real Docker test is opt-in locally (`SIFT_DOCKER_TEST=1 SIFT_TEST_SECRET=must-not-leak npm test`) and enabled in the repository CI workflow. It proves Pi shell/filesystem operations run in the pinned container and a runner secret is absent. The official MCP 1.14.0 binary's handshake, approved tool names and method enums were also inspected directly without making GitHub API writes. Its release archives are checksum-pinned.

Not validated by these tests: model-provider network behavior, a real GitHub App installation/review approval under organization policy, authenticated GCS transfer/permissions, or a consumer workflow running in GitHub Actions. Use the documented opt-in live CLI path with a disposable trusted PR and an existing bucket to validate those account-specific boundaries. No claim of a live model review, GitHub review write or cloud deployment is made.
