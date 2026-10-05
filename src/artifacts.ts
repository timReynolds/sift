import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { z } from 'zod';
import { RepoPath, Sha, type WorkspaceArtifact } from './contracts.ts';
import { GenerationConflict, type SnapshotStore } from './persistence.ts';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const Node = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('file'),
      mode: z.number().int().min(0).max(511),
      content: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('directory'),
      mode: z.number().int().min(0).max(511),
    })
    .strict(),
  z
    .object({
      kind: z.literal('symlink'),
      target: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('deleted'),
    })
    .strict(),
]);
const Artifact = z
  .object({
    version: z.literal(1),
    workspaceId: z.string(),
    specialist: z.string(),
    baseCommit: Sha,
    files: z.record(RepoPath, Node),
  })
  .strict();
type Artifact = z.infer<typeof Artifact>;
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '.terraform',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  'coverage',
  '.sift',
]);
function credentialPath(path: string) {
  return path
    .split('/')
    .some(
      (part) =>
        /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.aws|\.ssh|\.config|credentials(?:\.json)?|application_default_credentials\.json)$/i.test(
          part,
        ) || /\.(?:pem|key|p12|pfx)$/i.test(part),
    );
}
function hasSecret(value: Buffer, secrets: string[]) {
  const text = value.toString('utf8');
  return (
    secrets
      .flatMap((secret) => [secret, secret.replace(/^(?:Bearer|Basic)\s+/i, '')])
      .filter((value) => value.length >= 4)
      .some((secret) => text.includes(secret)) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(
      text,
    )
  );
}

async function manifest(root: string): Promise<Artifact['files']> {
  const files: Artifact['files'] = {};
  const walk = async (directory: string) => {
    for (const entry of await readdir(join(root, directory), {
      withFileTypes: true,
    })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (credentialPath(path) || EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      RepoPath.parse(path);
      const absolute = join(root, path);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        files[path] = {
          kind: 'symlink',
          target,
        };
      } else if (info.isDirectory()) {
        files[path] = {
          kind: 'directory',
          mode: info.mode & 0o777,
        };
        await walk(path);
      } else if (info.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(absolute)) {
          hash.update(chunk);
        }
        files[path] = {
          kind: 'file',
          mode: info.mode & 0o777,
          content: '',
          sha256: hash.digest('hex'),
        };
      }
    }
  };
  await walk('');
  return files;
}

/** Compare actual filesystem contents, so shell edits and deletions are captured alongside Pi edits. */
export async function captureArtifact(options: {
  workspace: string;
  baseline: string;
  workspaceId: string;
  specialist: string;
  baseCommit: string;
  secrets?: string[];
  maxBytes?: number;
}): Promise<Buffer | undefined> {
  Sha.parse(options.baseCommit);
  const maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;
  const [before, after] = await Promise.all([
    manifest(options.baseline),
    manifest(options.workspace),
  ]);
  const changed: Artifact['files'] = {};
  let bytes = 0;
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[path]) === JSON.stringify(after[path])) {
      continue;
    }
    const node = after[path] ?? {
      kind: 'deleted' as const,
    };
    if (node.kind === 'file') {
      const absolute = join(options.workspace, path);
      bytes += (await lstat(absolute)).size;
      if (bytes > maxBytes) {
        throw new Error('Investigation changes exceed the artifact byte limit');
      }
      const data = await readFile(absolute);
      if (sha256(data) !== node.sha256) {
        throw new Error(
          'Workspace changed during capture; stop investigation processes before saving',
        );
      }
      if (hasSecret(data, options.secrets ?? [])) {
        throw new Error(`Investigation file contains a credential: ${path}`);
      }
      node.content = data.toString('base64');
    } else if (
      node.kind === 'symlink' &&
      hasSecret(Buffer.from(node.target), options.secrets ?? [])
    ) {
      throw new Error(`Investigation symlink contains a credential: ${path}`);
    }
    changed[path] = node;
  }
  if (!Object.keys(changed).length) {
    return undefined;
  }
  const artifact: Artifact = {
    version: 1,
    workspaceId: options.workspaceId,
    specialist: options.specialist,
    baseCommit: options.baseCommit,
    files: changed,
  };
  const data = Buffer.from(JSON.stringify(artifact));
  if (data.length > maxBytes) {
    throw new Error('Investigation artifact exceeds the byte limit');
  }
  return compress(data);
}

export async function storeArtifact(
  store: SnapshotStore,
  prefix: string,
  data: Buffer,
  identity: Omit<WorkspaceArtifact, 'object' | 'sha256' | 'version' | 'required'>,
): Promise<WorkspaceArtifact> {
  const hash = sha256(data);
  const object = `${RepoPath.parse(prefix)}/artifacts/${hash}.json.gz`;
  try {
    await store.write(object, data);
  } catch (error) {
    if (
      !(error instanceof GenerationConflict) ||
      sha256((await store.read(object))?.data ?? Buffer.alloc(0)) !== hash
    ) {
      throw error;
    }
  }
  return {
    ...identity,
    version: 1,
    object,
    sha256: hash,
    required: true,
  };
}

async function safeParent(root: string, path: string): Promise<string> {
  const rootReal = await realpath(root);
  const destination = resolve(root, RepoPath.parse(path));
  // Build parents one at a time without traversing any existing symlink.
  let current = rootReal;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error('Artifact path traverses a non-directory');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await mkdir(current);
      } else {
        throw error;
      }
    }
  }
  if (!destination.startsWith(resolve(root) + sep)) {
    throw new Error('Artifact path escaped workspace');
  }
  return destination;
}

export async function restoreArtifact(
  store: SnapshotStore,
  reference: WorkspaceArtifact,
  workspace: string,
  expectedBase: string,
): Promise<{
  restored: boolean;
  reason?: string;
}> {
  try {
    if (reference.version !== 1 || reference.baseCommit !== expectedBase) {
      throw new Error('Artifact version or base revision is incompatible');
    }
    const object = await store.read(reference.object);
    if (!object || sha256(object.data) !== reference.sha256) {
      throw new Error('Required workspace artifact is missing or has the wrong digest');
    }
    const artifact = Artifact.parse(
      JSON.parse(
        (
          await decompress(object.data, {
            maxOutputLength: MAX_ARTIFACT_BYTES,
          })
        ).toString(),
      ),
    );
    if (
      artifact.workspaceId !== reference.workspaceId ||
      artifact.specialist !== reference.specialist ||
      artifact.baseCommit !== expectedBase
    ) {
      throw new Error('Artifact belongs to a different investigation');
    }
    const entries = Object.entries(artifact.files);
    for (const [path, node] of entries.sort(
      ([a], [b]) => b.split('/').length - a.split('/').length,
    )) {
      if (node.kind === 'deleted') {
        await rm(await safeParent(workspace, path), {
          recursive: true,
          force: true,
        });
      }
    }
    for (const [path, node] of entries.sort(
      ([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b),
    )) {
      if (node.kind === 'deleted') {
        continue;
      }
      const destination = await safeParent(workspace, path);
      if (node.kind === 'directory') {
        const existing = await lstat(destination).catch(() => undefined);
        if (existing && !existing.isDirectory()) {
          await rm(destination, {
            recursive: true,
            force: true,
          });
        }
        await mkdir(destination, {
          recursive: true,
        });
        await chmod(destination, node.mode);
      } else {
        await rm(destination, {
          recursive: true,
          force: true,
        });
        if (node.kind === 'symlink') {
          await symlink(node.target, destination);
        } else {
          const content = Buffer.from(node.content, 'base64');
          if (sha256(content) !== node.sha256) {
            throw new Error('Artifact file content failed integrity validation');
          }
          await writeFile(destination, content, {
            mode: node.mode,
          });
          await chmod(destination, node.mode);
        }
      }
    }
    return {
      restored: true,
    };
  } catch (error) {
    return {
      restored: false,
      reason: `${error instanceof Error ? error.message : String(error)}; restart the investigation in a fresh checkout`,
    };
  }
}
