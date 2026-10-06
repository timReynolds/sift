# Contributing to Sift

Use Node 24, as pinned in [.node-version](.node-version). Git is needed for workspace tests. Real reviews also need tar and Docker; the optional container test needs Docker.

## Development

```sh
git clone https://github.com/timReynolds/sift.git
cd sift
npm ci --ignore-scripts
npm run check
```

`npm run check` runs lint, type checking, the build, and tests. Default tests need no credentials or cloud resources. See [testing](docs/testing.md) for focused commands and Docker coverage.

The CLI and composite Action use the same engine. Review [architecture](docs/architecture.md) before changing agent lifecycle, persistence, or publication. Keep [configuration](docs/configuration.md), examples, and [compatibility](docs/compatibility.md) aligned with behavior changes.

## Pull requests

- Describe the problem, resulting behavior, and validation in the PR.
- Keep changes focused and add a regression check for behavior changes.
- Follow [AGENTS.md](AGENTS.md) for readable code and Arrange/Act/Assert test structure. [biome.json](biome.json) defines formatting and lint rules.
- Run `npm run lint:fix`, review the diff, and run `npm run check` before submitting.
- Run the Docker check when changing container execution, permissions, or cleanup.
- Keep credentials, session databases, investigation artifacts, and private review transcripts out of commits and issue reports.

Report reproducible bugs through [GitHub issues](https://github.com/timReynolds/sift/issues), including the Sift revision, Node version, command or workflow, and sanitized error output. Describe live integration checks separately from tests using simulated services.
