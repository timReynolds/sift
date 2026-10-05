import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('lint enforces braces, separate declarations and multiline statements', () => {
  // Arrange: isolate lint examples from the repository sources.
  const directory = mkdtempSync(join(tmpdir(), 'sift-style-'));
  const path = join(directory, 'example.ts');
  const check = (source: string) => {
    writeFileSync(path, source);
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../node_modules/@biomejs/biome/bin/biome', import.meta.url)),
        'check',
        '--config-path',
        fileURLToPath(new URL('..', import.meta.url)),
        '--vcs-enabled=false',
        path,
      ],
      {
        encoding: 'utf8',
      },
    );
  };

  try {
    const readable =
      'function readable(condition: boolean) {\n  if (condition) {\n    return true;\n  }\n  return false;\n}\n';

    // Act: check a compliant example.
    const valid = check(readable);

    // Assert
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);

    // Arrange: include each forbidden control, declaration, and statement style.
    const cases: [string, string][] = [
      ['useBlockStatements', 'if (condition) run();\n'],
      ['useBlockStatements', 'if (condition) {\n  run();\n} else stop();\n'],
      ['useBlockStatements', 'for (const item of items) run(item);\n'],
      ['useBlockStatements', 'while (condition) run();\n'],
      ['useBlockStatements', 'do run(); while (condition);\n'],
      ['useSingleVarDeclarator', 'let first = 1, second = 2;\n'],
      ['format', 'function compact() { run(); }\n'],
      ['format', 'if (condition) { run(); }\n'],
      ['format', 'try { run(); } catch (error) { report(error); }\n'],
      ['format', 'run(); stop();\n'],
    ];

    // Act and Assert: every compact example fails with the expected diagnostic.
    for (const [diagnostic, source] of cases) {
      const result = check(source);

      assert.notEqual(result.status, 0, source);
      assert.ok((result.stdout + result.stderr).includes(diagnostic), source);
    }
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});
