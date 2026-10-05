import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { createSandbox, type CommandRunner } from '../src/sandbox.ts';

test('sandbox adapter never mounts credentials and clamps commands to host timeout', async () => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'sift-sandbox-'));
  const expectedUser = `${process.getuid?.()}:${process.getgid?.()}`;
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
    const userArgument = create[create.indexOf('--user') + 1];
    const homeArgument = create[create.indexOf('--env') + 1];

    assert.equal(userArgument, expectedUser);
    assert.equal(homeArgument, 'HOME=/tmp');
    assert.equal(
      create.filter((arg) => arg === '--env' || arg.startsWith('--env=') || arg === '-e').length,
      1,
    );

    assert(create.includes('--cap-drop=ALL'));
    assert(create.includes('--security-opt=no-new-privileges'));
    assert.equal(create.filter((arg) => arg.includes('src=')).length, 3);
    assert(!create.some((arg) => /docker\.sock|\.aws|\.config|\.ssh/.test(arg)));
  } finally {
    await sandbox.cleanup(BACKGROUND_CONTEXT);
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }

  assert(calls.at(-1)!.includes('--force'));
});

test('real container edits runner-owned files without runner secrets', {
  skip: process.env.SIFT_DOCKER_TEST !== '1',
}, async () => {
  // Arrange: match private runner scratch space and ordinary exported source permissions.
  const directory = await mkdtemp(join(tmpdir(), 'sift-container-'));
  const file = join(directory, 'file.txt');
  await chmod(directory, 0o700);
  await writeFile(file, 'original');
  await chmod(file, 0o644);

  const previousSecret = process.env.SIFT_TEST_SECRET;
  process.env.SIFT_TEST_SECRET = 'runner-secret-must-not-leak';
  let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;

  try {
    sandbox = await createSandbox({
      workspace: directory,
      id: 'live-container-test',
      commandTimeoutSeconds: 5,
    });

    // Act: read the mounted file.
    const original = getOrThrow(await sandbox.readTextFile('file.txt', BACKGROUND_CONTEXT));

    // Assert
    assert.equal(original, 'original');

    // Act: edit an existing runner-owned source file.
    getOrThrow(await sandbox.writeFile('file.txt', 'edited', BACKGROUND_CONTEXT));
    const edited = await readFile(file, 'utf8');

    // Assert
    assert.equal(edited, 'edited');

    // Act: use a writable home and create nested evidence without runner credentials.
    const command = `
set -e
test -z "$SIFT_TEST_SECRET"
test ! -e /var/run/docker.sock
test "$HOME" = /tmp
printf cache > "$HOME/sift-test-cache"
mkdir -p evidence/nested
printf evidence > evidence/nested/repro.txt
cat evidence/nested/repro.txt
`;
    const output: string[] = [];
    const result = getOrThrow(
      await sandbox.exec(
        command,
        {
          onOutput: (text) => output.push(text),
        },
        BACKGROUND_CONTEXT,
      ),
    );

    const reproduction = join(directory, 'evidence/nested/repro.txt');
    const evidence = await readFile(reproduction, 'utf8');
    const evidenceDirectory = await stat(join(directory, 'evidence/nested'));
    const reproductionFile = await stat(reproduction);

    // Assert
    assert.equal(result.exitCode, 0);
    assert.equal(output.join(''), 'evidence');

    assert.equal(evidence, 'evidence');
    assert.equal(evidenceDirectory.uid, process.getuid?.());
    assert.equal(reproductionFile.uid, process.getuid?.());

    // Act: read the nested command output through the binary filesystem API.
    const bytes = getOrThrow(
      await sandbox.readBinaryFile('evidence/nested/repro.txt', BACKGROUND_CONTEXT),
    );

    // Assert
    assert.equal(Buffer.from(bytes).toString(), 'evidence');
  } finally {
    if (previousSecret === undefined) {
      delete process.env.SIFT_TEST_SECRET;
    } else {
      process.env.SIFT_TEST_SECRET = previousSecret;
    }

    await sandbox?.cleanup(BACKGROUND_CONTEXT);
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
