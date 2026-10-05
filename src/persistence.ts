import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { Storage } from '@google-cloud/storage';
import { RepoPath } from './contracts.ts';

export type StoredObject = {
  data: Buffer;
  generation: string;
};
/** Snapshot transport only. Pi continues to own its unmodified SQLite backend. */
export interface SnapshotStore {
  read(key: string): Promise<StoredObject | undefined>;
  write(key: string, data: Buffer, expectedGeneration?: string): Promise<string>;
}
export class GenerationConflict extends Error {
  constructor() {
    super(
      'Snapshot generation conflict: newer state was preserved; rerun from the latest snapshot',
    );
  }
}
export class CorruptState extends Error {
  constructor(message: string) {
    super(
      `Unreadable state database; preserve it and restore a known-good generation or explicitly start recovery: ${message}`,
    );
  }
}
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const statusCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

async function retry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (
        attempt >= 2 ||
        ![
          '408',
          '429',
          '500',
          '502',
          '503',
          '504',
          'ECONNRESET',
          'ETIMEDOUT',
          'EAI_AGAIN',
        ].includes(statusCode(error))
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}

export class GcsSnapshotStore implements SnapshotStore {
  readonly #storage: Storage;
  readonly #bucket: string;
  readonly #prefix: string;
  constructor(
    bucket: string,
    prefix = 'sift',
    storage = new Storage({
      retryOptions: {
        autoRetry: false,
      },
    }),
  ) {
    this.#storage = storage;
    this.#bucket = bucket;
    this.#prefix = RepoPath.parse(prefix);
  }
  #key(key: string) {
    return `${this.#prefix}/${RepoPath.parse(key)}`;
  }
  async read(key: string): Promise<StoredObject | undefined> {
    const bucket = this.#storage.bucket(this.#bucket);
    const file = bucket.file(this.#key(key));
    let generation: string;
    try {
      const [metadata] = await retry(() => file.getMetadata());
      if (metadata.generation === undefined) {
        throw new Error('GCS state has no object generation');
      }
      generation = String(metadata.generation);
    } catch (error) {
      if (statusCode(error) === '404') {
        return undefined;
      }
      throw error;
    }
    // A disappearing version after metadata lookup is an error, never a missing/new session.
    const [data] = await retry(() =>
      bucket
        .file(this.#key(key), {
          generation,
        })
        .download({
          validation: 'crc32c',
        }),
    );
    return {
      data,
      generation,
    };
  }
  async write(key: string, data: Buffer, expectedGeneration?: string): Promise<string> {
    const file = this.#storage.bucket(this.#bucket).file(this.#key(key));
    const operationId = randomUUID();
    const sha256 = hash(data);
    let failure: unknown;
    try {
      await retry(() =>
        file.save(data, {
          resumable: false,
          validation: 'crc32c',
          preconditionOpts: {
            ifGenerationMatch: expectedGeneration ?? '0',
          },
          metadata: {
            contentType: 'application/octet-stream',
            metadata: {
              siftOperationId: operationId,
              siftSha256: sha256,
            },
          },
        }),
      );
    } catch (error) {
      failure = error;
    }
    // Reconcile an upload whose response was lost, without dropping its generation guard.
    try {
      const [metadata] = await retry(() => file.getMetadata());
      if (
        metadata.metadata?.siftOperationId === operationId &&
        metadata.metadata?.siftSha256 === sha256 &&
        metadata.generation !== undefined
      ) {
        return String(metadata.generation);
      }
    } catch (error) {
      if (!failure) {
        throw error;
      }
    }
    if (statusCode(failure) === '412' || failure === undefined) {
      throw new GenerationConflict();
    }
    throw failure;
  }
}

export class LocalSnapshotStore implements SnapshotStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  async read(key: string): Promise<StoredObject | undefined> {
    try {
      const data = await readFile(join(this.root, RepoPath.parse(key)));
      return {
        data,
        generation: hash(data),
      };
    } catch (error) {
      if (statusCode(error) === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }
  async write(key: string, data: Buffer, expectedGeneration?: string): Promise<string> {
    const destination = join(this.root, RepoPath.parse(key));
    await mkdir(dirname(destination), {
      recursive: true,
    });
    const lock = `${destination}.lock`;
    try {
      await mkdir(lock);
    } catch (error) {
      if (statusCode(error) === 'EEXIST') {
        throw new GenerationConflict();
      }
      throw error;
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const current = await this.read(key);
      if (current?.generation !== expectedGeneration) {
        throw new GenerationConflict();
      }
      await writeFile(temporary, data, {
        mode: 0o600,
      });
      await rename(temporary, destination);
      return hash(data);
    } finally {
      await rm(temporary, {
        force: true,
      });
      await rm(lock, {
        recursive: true,
        force: true,
      });
    }
  }
}

export function validateSqlite(path: string): void {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      readOnly: true,
    });
    const result = database.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || Object.values(result[0]!)[0] !== 'ok') {
      throw new Error('SQLite integrity check failed');
    }
    if (
      !database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='durable_metadata'")
        .get()
    ) {
      throw new Error('Not a Pi Durable database');
    }
  } catch (error) {
    throw new CorruptState(error instanceof Error ? error.message : String(error));
  } finally {
    database?.close();
  }
}

/** SQLite's backup API includes committed WAL pages. The destination is explicitly made standalone. */
export async function standaloneSnapshot(source: string, destination: string): Promise<void> {
  validateSqlite(source);
  await mkdir(dirname(destination), {
    recursive: true,
  });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const database = new DatabaseSync(source, {
    readOnly: true,
  });
  try {
    await backup(database, temporary);
    const snapshot = new DatabaseSync(temporary);
    try {
      snapshot.exec('PRAGMA journal_mode=DELETE');
    } finally {
      snapshot.close();
    }
    validateSqlite(temporary);
    await rename(temporary, destination);
  } finally {
    database.close();
    await rm(temporary, {
      force: true,
    });
    await rm(`${temporary}-wal`, {
      force: true,
    });
    await rm(`${temporary}-shm`, {
      force: true,
    });
  }
}

export async function restoreDatabase(
  store: SnapshotStore,
  key: string,
  path: string,
): Promise<string | undefined> {
  const object = await store.read(key);
  if (!object) {
    try {
      await stat(path);
      throw new Error(
        'Missing remote state cannot reuse an existing local database; use a fresh run directory',
      );
    } catch (error) {
      if (statusCode(error) !== 'ENOENT') {
        throw error;
      }
    }
    return undefined;
  }
  await mkdir(dirname(path), {
    recursive: true,
  });
  for (const suffix of ['-wal', '-shm']) {
    try {
      await stat(`${path}${suffix}`);
      throw new Error('Refusing to restore over an active SQLite sidecar');
    } catch (error) {
      if (statusCode(error) !== 'ENOENT') {
        throw error;
      }
    }
  }
  const temporary = `${path}.${randomUUID()}.download`;
  try {
    await writeFile(temporary, object.data, {
      mode: 0o600,
    });
    validateSqlite(temporary);
    await rename(temporary, path);
  } finally {
    await rm(temporary, {
      force: true,
    });
  }
  return object.generation;
}

export class PersistedRunFailure extends AggregateError {
  readonly persistence: 'saved' | 'failed';
  constructor(errors: unknown[], persistence: 'saved' | 'failed') {
    super(
      errors,
      errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; '),
    );
    this.persistence = persistence;
  }
}

/** Restore errors do not enter the save path; ordinary execution failures do. */
export async function persistedRun<T>(options: {
  store: SnapshotStore;
  key: string;
  database: string;
  run: () => Promise<T>;
  beforeClose?: () => Promise<void>;
  close: () => Promise<void>;
}): Promise<{
  result: T;
  persistence: 'saved';
  generation: string;
}> {
  const generation = await restoreDatabase(options.store, options.key, options.database);
  const errors: unknown[] = [];
  let result: T | undefined;
  let saved: string | undefined;
  let ready = true;
  try {
    result = await options.run();
  } catch (error) {
    errors.push(error);
  }
  try {
    await options.beforeClose?.();
  } catch (error) {
    errors.push(error);
    ready = false;
  }
  try {
    await options.close();
  } catch (error) {
    errors.push(error);
    ready = false;
  }
  if (ready) {
    const snapshot = `${options.database}.snapshot`;
    try {
      await standaloneSnapshot(options.database, snapshot);
      saved = await options.store.write(options.key, await readFile(snapshot), generation);
    } catch (error) {
      errors.push(error);
    } finally {
      await rm(snapshot, {
        force: true,
      });
    }
  }
  if (errors.length) {
    throw new PersistedRunFailure(errors, saved === undefined ? 'failed' : 'saved');
  }
  return {
    result: result as T,
    persistence: 'saved',
    generation: saved!,
  };
}
