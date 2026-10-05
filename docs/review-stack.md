# Review stack

Review and merge from the bottom upward. Each PR adds one responsibility and keeps its behavior tests beside the code. The six original PR links are preserved; the inserted draft PRs separate their former concerns.

Changed-line counts include handwritten code, tests and documentation, and exclude generated `package-lock.json` changes. Passing-test counts are cumulative for the branch. Each branch passed `npm run check` on Node 24.21.0: lint, typecheck, build and tests.

| Order | PR | Focus | Handwritten changes | Passing tests |
| --- | --- | --- | ---: | ---: |
| 1 | [#1](https://github.com/timReynolds/sift/pull/1) | Establish contracts and enforce readable coding style | 932 | 5 |
| 2 | [#8](https://github.com/timReynolds/sift/pull/8) | Validate configuration and explicit CLI inputs | 505 | 9 |
| 3 | [#9](https://github.com/timReynolds/sift/pull/9) | Load agent profiles and scoped repository instructions | 487 | 12 |
| 4 | [#10](https://github.com/timReynolds/sift/pull/10) | Isolate coding tools in credential-free containers | 563 | 13 |
| 5 | [#2](https://github.com/timReynolds/sift/pull/2) | Schedule and resume durable reviewer investigations | 1,146 | 18 |
| 6 | [#11](https://github.com/timReynolds/sift/pull/11) | Normalize GitHub review wake-up events | 330 | 20 |
| 7 | [#12](https://github.com/timReynolds/sift/pull/12) | Scope MCP tools and validate advertised methods | 627 | 23 |
| 8 | [#3](https://github.com/timReynolds/sift/pull/3) | Load exact PR context through typed GitHub reads | 960 | 31 |
| 9 | [#13](https://github.com/timReynolds/sift/pull/13) | Validate findings and plan review verdicts | 1,088 | 34 |
| 10 | [#14](https://github.com/timReynolds/sift/pull/14) | Reconcile durable review publication and replies | 979 | 43 |
| 11 | [#4](https://github.com/timReynolds/sift/pull/4) | Map publication operations to native GitHub MCP writes | 206 | 44 |
| 12 | [#5](https://github.com/timReynolds/sift/pull/5) | Persist SQLite snapshots with guarded object generations | 724 | 48 |
| 13 | [#15](https://github.com/timReynolds/sift/pull/15) | Capture and restore guarded investigation artifacts | 532 | 50 |
| 14 | [#16](https://github.com/timReynolds/sift/pull/16) | Restore exact Git workspaces for investigations | 491 | 51 |
| 15 | [#17](https://github.com/timReynolds/sift/pull/17) | Run the complete review lifecycle through Pi | 983 | 55 |
| 16 | [#18](https://github.com/timReynolds/sift/pull/18) | Wire trusted runner configuration and CLI outputs | 548 | 55 |
| 17 | [#6](https://github.com/timReynolds/sift/pull/6) | Package the CLI as a reusable GitHub Action | 512 | 56 |

The foundation also contains the initial generated dependency lockfile. The durable scheduler is the largest handwritten layer; its scheduling and restart tests stay together because they describe one stateful workflow.

From the sandbox layer onward, the default suite skips one optional real Docker test. Default tests use deterministic model responses; live model calls, GitHub review writes and authenticated GCS transfers remain separate acceptance checks.
