import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { Storage } from '@google-cloud/storage';
import {
  CorruptState,
  GcsSnapshotStore,
  GenerationConflict,
  LocalSnapshotStore,
  persistedRun,
  PersistedRunFailure,
  restoreDatabase,
  standaloneSnapshot,
} from '../src/persistence.ts';
import { ReviewDoc } from '../src/state.ts';

const ctx = BACKGROUND_CONTEXT;

const open = async (path: string) =>
  Harness.open(
    await openNodeSqliteStorage(path, {
      walAutoCheckpointPages: 0,
    }),
    {
      models: createModels(),
      registry: createRegistry(),
    },
    ctx,
  );

test('a standalone SQLite snapshot includes committed WAL state and reopens real Pi documents', async () => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'sift-wal-'));
  const path = join(directory, 'live.sqlite');
  const snapshot = join(directory, 'standalone.sqlite');
  let harness = await open(path);

  try {
    const root = await harness.root(ctx);
    await root.commit(async (tx) => {
      const doc = await tx.doc(ReviewDoc, root.id);
      doc.gaps.push('pending security review');
      doc.importedMessages['reply:1'] = {
        requestId: 'github:1',
        answered: false,
      };
    }, ctx);
    assert((await stat(`${path}-wal`)).size > 0);

    // Act: take a standalone snapshot of the committed WAL state.
    await standaloneSnapshot(path, snapshot);

    // Assert
    await assert.rejects(stat(`${snapshot}-wal`), {
      code: 'ENOENT',
    });

    // Arrange: upload the standalone snapshot.
    const store = new LocalSnapshotStore(join(directory, 'store'));
    const generation = await store.write(
      'repositories/7/pulls/12/session.sqlite',
      await readFile(snapshot),
    );
    const restored = join(directory, 'restored.sqlite');

    // Act
    const restoredGeneration = await restoreDatabase(
      store,
      'repositories/7/pulls/12/session.sqlite',
      restored,
    );

    // Assert
    assert.equal(restoredGeneration, generation);

    // Act: reopen the restored database through the real document harness.
    await harness.close(ctx);
    harness = await open(restored);
    const reopened = await harness.root(ctx);
    const state = await harness.snapshot(ReviewDoc, reopened.id, ctx);

    // Assert
    assert.deepEqual(state?.gaps, ['pending security review']);
    assert.equal(state?.importedMessages['reply:1']?.answered, false);
  } finally {
    await harness.close(ctx);
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

class FakeGcs {
  objects = new Map<
    string,
    {
      data: Buffer;
      generation: string;
      metadata: Record<string, string>;
    }
  >();
  conditions: string[] = [];
  downloads: string[] = [];
  next = 10_000_000_000_000_000_000n;
  loseResponse = false;

  bucket() {
    return {
      file: (
        key: string,
        options?: {
          generation?: string;
        },
      ) => ({
        getMetadata: async () => {
          const record = this.objects.get(key);

          if (!record) {
            throw Object.assign(new Error('Missing'), {
              code: 404,
            });
          }

          return [
            {
              generation: record.generation,
              metadata: record.metadata,
            },
          ];
        },
        download: async () => {
          const record = this.objects.get(key);
          this.downloads.push(options?.generation ?? 'UNGUARDED');

          if (!record || record.generation !== options?.generation) {
            throw Object.assign(new Error('Generation missing'), {
              code: 404,
            });
          }

          return [record.data];
        },
        save: async (
          data: Buffer,
          options: {
            preconditionOpts: {
              ifGenerationMatch: string;
            };
            metadata: {
              metadata: Record<string, string>;
            };
          },
        ) => {
          const guard = options.preconditionOpts.ifGenerationMatch;
          this.conditions.push(guard);

          if (guard !== (this.objects.get(key)?.generation ?? '0')) {
            throw Object.assign(new Error('Precondition failed'), {
              code: 412,
            });
          }

          this.objects.set(key, {
            data: Buffer.from(data),
            generation: String(++this.next),
            metadata: options.metadata.metadata,
          });

          if (this.loseResponse) {
            this.loseResponse = false;
            throw Object.assign(new Error('Lost response'), {
              code: 500,
            });
          }
        },
      }),
    };
  }
}

test('GCS uses create-only and exact string generation guards, rejects stale saves, and reconciles lost upload responses', async () => {
  // Arrange
  const fake = new FakeGcs();
  const store = new GcsSnapshotStore('bucket', 'sift', fake as unknown as Storage);

  // Act
  const missing = await store.read('state');

  // Assert
  assert.equal(missing, undefined);

  // Act: create the first generation.
  const first = await store.write('state', Buffer.from('one'));

  // Assert
  assert.equal(fake.conditions[0], '0');
  assert.equal(first, '10000000000000000001');

  // Act
  const firstRead = await store.read('state');

  // Assert
  assert.equal(firstRead?.data.toString(), 'one');
  assert.equal(fake.downloads[0], first);

  // Arrange: lose the upload response after accepting the next generation.
  fake.loseResponse = true;

  // Act
  const second = await store.write('state', Buffer.from('two'), first);

  // Assert
  assert.equal(second, '10000000000000000002');

  // Act / Assert: reject a stale save without losing the latest data.
  await assert.rejects(store.write('state', Buffer.from('stale'), first), GenerationConflict);

  // Act
  const latest = await store.read('state');

  // Assert
  assert.equal(latest?.data.toString(), 'two');
  assert.deepEqual(fake.conditions, ['0', first, first, first]);
});

test('corrupt downloads are visible and do not overwrite an existing valid object or local file', async () => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'sift-corrupt-'));
  const store = new LocalSnapshotStore(join(directory, 'store'));
  const path = join(directory, 'local.sqlite');

  try {
    await store.write('state', Buffer.from('corrupt database'));
    await writeFile(path, 'preserve this local file');

    // Act / Assert
    await assert.rejects(restoreDatabase(store, 'state', path), CorruptState);

    // Assert: the failed restoration preserves both existing files.
    assert.equal(await readFile(path, 'utf8'), 'preserve this local file');
    const stored = await store.read('state');
    assert.equal(stored?.data.toString(), 'corrupt database');
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

test('ordinary execution failure still saves usable state and upload failure is reported separately', async () => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'sift-failure-'));
  const store = new LocalSnapshotStore(join(directory, 'store'));
  let harness: Awaited<ReturnType<typeof open>> | undefined;

  try {
    // Act / Assert: an execution failure still persists the committed state.
    await assert.rejects(
      persistedRun({
        store,
        key: 'state',
        database: join(directory, 'run.sqlite'),
        run: async () => {
          harness = await open(join(directory, 'run.sqlite'));
          const root = await harness.root(ctx);
          await root.commit(async (tx) => {
            (await tx.doc(ReviewDoc, root.id)).gaps.push('model failed');
          }, ctx);

          throw new Error('Model unavailable');
        },
        close: async () => {
          await harness?.close(ctx);
        },
      }),
      (error) =>
        error instanceof PersistedRunFailure &&
        error.persistence === 'saved' &&
        /Model unavailable/.test(error.message),
    );

    // Assert
    const saved = await store.read('state');
    assert(saved);

    // Arrange: let execution succeed while the upload fails.
    const failing = {
      read: store.read.bind(store),
      write: async () => {
        throw new Error('Upload failed');
      },
    };

    // Act / Assert
    await assert.rejects(
      persistedRun({
        store: failing,
        key: 'state',
        database: join(directory, 'next.sqlite'),
        run: async () => {
          harness = await open(join(directory, 'next.sqlite'));
          return 'review completed';
        },
        close: async () => {
          await harness?.close(ctx);
        },
      }),
      (error) =>
        error instanceof PersistedRunFailure &&
        error.persistence === 'failed' &&
        /Upload failed/.test(error.message),
    );
  } finally {
    await harness?.close(ctx);
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
