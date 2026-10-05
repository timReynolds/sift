import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureArtifact, restoreArtifact, storeArtifact } from '../src/artifacts.ts';
import { LocalSnapshotStore } from '../src/persistence.ts';

const revision = 'a'.repeat(40);

test('shell changes, deletions, executable modes and reproduction files survive artifact restoration', async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), 'sift-artifacts-'));
  const baseline = join(root, 'base');
  const workspace = join(root, 'work');
  const restored = join(root, 'restored');

  try {
    await mkdir(baseline);
    await writeFile(join(baseline, 'large-unchanged'), Buffer.alloc(100_000));
    await writeFile(join(baseline, 'deleted'), 'old');
    await cp(baseline, workspace, {
      recursive: true,
    });
    await rm(join(workspace, 'deleted'));
    await mkdir(join(workspace, 'repro'));
    await writeFile(join(workspace, 'repro/run.sh'), '#!/bin/sh\necho reproduced\n');
    await chmod(join(workspace, 'repro/run.sh'), 0o755);
    await symlink('repro/run.sh', join(workspace, 'reproduce'));
    await mkdir(join(workspace, 'node_modules'));
    await writeFile(join(workspace, 'node_modules/cache'), Buffer.alloc(100_000));
    await writeFile(join(workspace, '.env'), 'SECRET=excluded');

    // Act: capture the workspace changes.
    const data = await captureArtifact({
      baseline,
      workspace,
      workspaceId: '12',
      specialist: 'tests',
      baseCommit: revision,
      maxBytes: 5000,
    });

    // Assert
    assert(data);

    // Arrange: store the captured artifact.
    const store = new LocalSnapshotStore(join(root, 'store'));

    // Act
    const reference = await storeArtifact(store, 'pr-1', data, {
      workspaceId: '12',
      specialist: 'tests',
      baseCommit: revision,
    });
    const duplicateReference = await storeArtifact(store, 'pr-1', data, {
      workspaceId: '12',
      specialist: 'tests',
      baseCommit: revision,
    });

    // Assert
    assert.deepEqual(duplicateReference, reference);

    // Arrange: restore into a fresh baseline checkout.
    await cp(baseline, restored, {
      recursive: true,
    });

    // Act
    const result = await restoreArtifact(store, reference, restored, revision);

    // Assert
    assert.deepEqual(result, {
      restored: true,
    });
    assert.equal(
      await readFile(join(restored, 'repro/run.sh'), 'utf8'),
      '#!/bin/sh\necho reproduced\n',
    );
    assert.equal((await lstat(join(restored, 'repro/run.sh'))).mode & 0o777, 0o755);
    assert.equal(await readlink(join(restored, 'reproduce')), 'repro/run.sh');

    for (const path of ['deleted', '.env', 'node_modules']) {
      await assert.rejects(lstat(join(restored, path)), {
        code: 'ENOENT',
      });
    }

    // Act: try restoring against a different revision.
    const mismatched = await restoreArtifact(store, reference, restored, 'b'.repeat(40));

    // Assert
    assert.equal(mismatched.restored, false);

    // Arrange: simulate loss of the stored artifact.
    await rm(join(root, 'store', reference.object));

    // Act
    const missing = await restoreArtifact(store, reference, restored, revision);

    // Assert
    assert.match(missing.reason!, /missing.*restart/);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});

test('artifacts refuse credentials and never traverse workspace symlinks during restoration', async () => {
  // Arrange
  const root = await mkdtemp(join(tmpdir(), 'sift-artifacts-'));

  try {
    const baseline = join(root, 'base');
    const workspace = join(root, 'work');
    await mkdir(baseline);
    await mkdir(workspace);
    await writeFile(join(workspace, 'evidence.txt'), 'secret-value');

    // Act / Assert: credential-bearing evidence must be rejected.
    await assert.rejects(
      captureArtifact({
        baseline,
        workspace,
        workspaceId: '2',
        specialist: 'tests',
        baseCommit: revision,
        secrets: ['secret-value'],
      }),
      /credential/,
    );

    // Arrange: capture safe evidence and replace its destination with a symlink.
    await rm(join(workspace, 'evidence.txt'));
    await mkdir(join(workspace, 'dir'));
    await writeFile(join(workspace, 'dir/file'), 'safe');
    const data = (await captureArtifact({
      baseline,
      workspace,
      workspaceId: '2',
      specialist: 'tests',
      baseCommit: revision,
    }))!;
    const store = new LocalSnapshotStore(join(root, 'store'));
    const reference = await storeArtifact(store, 'pr-1', data, {
      workspaceId: '2',
      specialist: 'tests',
      baseCommit: revision,
    });
    await symlink(root, join(baseline, 'dir'));

    // Act
    const result = await restoreArtifact(store, reference, baseline, revision);

    // Assert: replace the directory symlink itself, never its external target.
    assert.equal(result.restored, true);
    assert.equal((await lstat(join(baseline, 'dir'))).isSymbolicLink(), false);
    await assert.rejects(lstat(join(root, 'file')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
    });
  }
});
