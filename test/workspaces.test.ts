import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSource, type HostCommand } from '../src/workspaces.ts';

const revision = 'a'.repeat(40);

test('exact Git exports retain export-ignored files, executable modes and symlinks without persisting fetch credentials', async () => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'sift-source-'));
  const blobs = [
    {
      path: '.gitattributes',
      mode: '100644',
      oid: 'b'.repeat(40),
      content: 'important export-ignore\n',
    },
    {
      path: 'important',
      mode: '100755',
      oid: 'c'.repeat(40),
      content: '#!/bin/sh\necho exact\n',
    },
    {
      path: 'link',
      mode: '120000',
      oid: 'd'.repeat(40),
      content: 'important',
    },
  ];
  const run: HostCommand = async (command, args, options) => {
    assert.equal(command, 'git');
    assert(!args.includes('push'));
    assert(!args.some((arg) => arg.includes('example-secret')));

    if (args.includes('fetch')) {
      assert(options.env?.GIT_CONFIG_VALUE_0);
      assert.equal(options.env?.GIT_TERMINAL_PROMPT, '0');
    } else {
      assert.equal(options.env?.GIT_CONFIG_VALUE_0, undefined);
    }

    if (args.includes('rev-parse')) {
      return Buffer.from(revision + '\n');
    }

    if (args.includes('ls-tree')) {
      return Buffer.from(
        blobs.map((blob) => `${blob.mode} blob ${blob.oid}\t${blob.path}\0`).join(''),
      );
    }

    if (args.includes('cat-file')) {
      assert.equal(options.input?.toString(), blobs.map((blob) => blob.oid + '\n').join(''));
      return Buffer.from(
        blobs
          .map((blob) => `${blob.oid} blob ${Buffer.byteLength(blob.content)}\n${blob.content}\n`)
          .join(''),
      );
    }

    return Buffer.alloc(0);
  };

  try {
    const source = new GitSource(join(directory, 'git'), 'example-secret', undefined, run);
    const destination = join(directory, 'checkout');

    // Act
    const gaps = await source.export('acme/app', revision, destination);

    // Assert
    assert.deepEqual(gaps, []);
    assert.equal(await readFile(join(destination, 'important'), 'utf8'), blobs[1]!.content);
    assert.equal((await stat(join(destination, 'important'))).mode & 0o777, 0o755);
    assert.equal(await readlink(join(destination, 'link')), 'important');
    await assert.rejects(stat(join(destination, '.git')), {
      code: 'ENOENT',
    });

    // Act / Assert: branch names cannot substitute for an exact commit.
    await assert.rejects(
      source.export('acme/app', 'main', join(directory, 'bad')),
      /full Git commit SHA/,
    );
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
