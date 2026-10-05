import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { createSandbox, type CommandRunner } from '../src/sandbox.ts';

test('sandbox adapter never mounts credentials and clamps commands to host timeout', async () => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'sift-sandbox-'));
  const calls: string[][] = [];
  const requests: Array<{
    method: string;
    args: unknown[];
  }> = [];
  const run: CommandRunner = async (args, input, _signal, onLine) => {
    calls.push(args);
    if (input) {
      const parsedRequest = JSON.parse(input);
      requests.push(parsedRequest);
      onLine?.(
        JSON.stringify({
          result: {
            ok: true,
            value: {
              exitCode: 0,
            },
          },
        }),
      );
    }
    return '';
  };
  const sandbox = await createSandbox({
    workspace: directory,
    id: 'one',
    commandTimeoutSeconds: 3,
    run,
  });

  try {
    // Act
    getOrThrow(
      await sandbox.exec(
        'true',
        {
          timeout: 200,
        },
        BACKGROUND_CONTEXT,
      ),
    );

    // Assert
    const execRequest = requests[0]!;
    const commandOptions = execRequest.args[1] as {
      timeout: number;
    };

    assert.equal(commandOptions.timeout, 3);

    const create = calls[0]!;
    assert(create.includes('--cap-drop=ALL'));
    assert(create.includes('--security-opt=no-new-privileges'));
    assert.equal(create.filter((arg) => arg.includes('src=')).length, 3);
    assert(!create.some((arg) => /docker\.sock|\.aws|\.config|\.ssh|--env/.test(arg)));
  } finally {
    await sandbox.cleanup(BACKGROUND_CONTEXT);
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }

  assert(calls.at(-1)!.includes('--force'));
});

test('real container runs Pi filesystem and shell operations without runner secrets', {
  skip: process.env.SIFT_DOCKER_TEST !== '1',
}, async () => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'sift-container-'));
  await writeFile(join(directory, 'file.txt'), 'original');
  const sandbox = await createSandbox({
    workspace: directory,
    id: 'live-container-test',
    commandTimeoutSeconds: 5,
  });

  try {
    // Act: read the mounted file.
    const original = getOrThrow(await sandbox.readTextFile('file.txt', BACKGROUND_CONTEXT));

    // Assert
    assert.equal(original, 'original');

    // Act: write through the sandbox filesystem.
    getOrThrow(await sandbox.writeFile('file.txt', 'edited', BACKGROUND_CONTEXT));
    const edited = await readFile(join(directory, 'file.txt'), 'utf8');

    // Assert
    assert.equal(edited, 'edited');

    // Act: execute a command without runner credentials.
    const output: string[] = [];
    const result = getOrThrow(
      await sandbox.exec(
        'test -z "$SIFT_TEST_SECRET" && test ! -e /var/run/docker.sock && printf evidence > repro.txt && cat repro.txt',
        {
          onOutput: (text) => output.push(text),
        },
        BACKGROUND_CONTEXT,
      ),
    );

    // Assert
    assert.equal(result.exitCode, 0);
    assert.equal(output.join(''), 'evidence');
    assert.equal(await readFile(join(directory, 'repro.txt'), 'utf8'), 'evidence');

    // Act: read the command output through the binary filesystem API.
    const bytes = getOrThrow(await sandbox.readBinaryFile('repro.txt', BACKGROUND_CONTEXT));

    // Assert
    assert.equal(Buffer.from(bytes).toString(), 'evidence');
  } finally {
    await sandbox.cleanup(BACKGROUND_CONTEXT);
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
