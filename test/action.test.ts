import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { actionMain } from '../src/action.ts';
import { cliOptions } from '../src/cli.ts';
import { writeOutputs } from '../src/outputs.ts';
import { PersistedRunFailure } from '../src/persistence.ts';

test('packaged Action forwards literal inputs to the same CLI and exposes operational status separately', async () => {
  // Arrange: load the packaged Action definition.
  const action = parse(await readFile(new URL('../action.yml', import.meta.url), 'utf8'));

  // Assert: the composite Action runs the packaged entry point.
  assert.equal(action.runs.using, 'composite');
  assert.equal(action.runs.steps.at(-1).run, 'node "$GITHUB_ACTION_PATH/dist/src/action.js"');

  // Arrange: provide literal Action inputs, including a path with spaces.
  let invoked = false;
  const inputs = {
    SIFT_INPUT_CONFIG: 'config with spaces.yml',
    SIFT_INPUT_TRUSTED_REF: 'a'.repeat(40),
    SIFT_INPUT_REPOSITORY: 'acme/app',
    SIFT_INPUT_PR: '12',
    SIFT_INPUT_DRY_RUN: 'true',
    RUNNER_TEMP: '/tmp',
  };

  // Act
  await actionMain(inputs, async (args) => {
    invoked = true;
    const parsed = cliOptions(args);

    // Assert: the CLI receives the literal input values.
    assert.equal(parsed.config, 'config with spaces.yml');
    assert.equal(parsed.pr, '12');
    assert.equal(parsed['dry-run'], true);
    assert.equal(parsed['trusted-ref'], 'a'.repeat(40));
  });

  assert(invoked);

  // Arrange: capture the operational failure outputs.
  const directory = await mkdtemp(join(tmpdir(), 'sift-outputs-'));

  try {
    const env = {
      GITHUB_OUTPUT: join(directory, 'output'),
      GITHUB_STEP_SUMMARY: join(directory, 'summary'),
    };

    // Act
    await writeOutputs(new PersistedRunFailure([new Error('Upload unavailable')], 'failed'), env);

    const output = await readFile(env.GITHUB_OUTPUT, 'utf8');

    // Assert
    assert.match(output, /operational-status=failed/);
    assert.match(output, /persistence-status=failed/);
    assert(!output.includes('verdict=APPROVE'));

    const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8');

    assert.match(summary, /No review success is implied/);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
