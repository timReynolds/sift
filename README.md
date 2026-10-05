# Sift

This foundation branch establishes the pinned toolchain, readable coding style, finding/state contracts and real Pi SQLite restart test. The remaining dependent branches deliver the reviewer, GitHub integration, persistence and Action. See docs/sift-v1-design.md for the full scope.

Use Node 24 LTS, `npm ci --ignore-scripts`, and `npm run check`.

## Coding style

`npm run lint` enforces the Biome rules and formatting in `biome.json`, and runs as part of `npm run check` in CI. Use `npm run lint:fix` to apply the style before committing.

Always use braces for conditional and loop bodies, including a single statement. Keep block bodies and separate statements on separate lines, declare one variable at a time, and use blank lines between distinct steps. Use two spaces, single quotes, semicolons, and a 100-column formatting target. Small data literals stay compact; multiline fixtures should be easy to scan.

Structure tests into Arrange, Act, and Assert phases with blank lines between them. See [AGENTS.md](AGENTS.md) for the contributor conventions, including tests with multiple workflow stages.
