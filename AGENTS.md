# Sift contributor guidance

Write code for a human reviewing the diff. Follow `biome.json`; use braces and multiline bodies for conditionals, loops, functions, and cleanup. Use blank lines to separate distinct steps, and keep small data literals compact when Biome permits it.

## Tests

- Structure each test as Arrange, Act, Assert, with a blank line between phases. Use phase comments where they make the transition easier to see.
- Name inputs and action results so a reviewer can see the scenario and expected outcome without unpacking nested calls inside assertions. Exception assertions may combine Act and Assert using `assert.throws` or `assert.rejects`.
- Separate independent assertion groups with a blank line. Keep related assertions together, and put a blank line between test cases and helper declarations.
- For workflows such as review, restart, reply, and recheck, show each stage as its own action and assertion group with a descriptive comment. Keep resource cleanup in `finally`.
- Keep fixtures close to their test. Reuse existing helpers when they clarify the scenario; introduce a shared helper only for repeated setup that obscures the behavior under test.

Before submitting changes, run `npm run lint:fix` and `npm run check` on the Node version pinned in `.node-version`. Review the test phases as well: lint checks syntax and formatting, while these instructions govern scenario clarity.
