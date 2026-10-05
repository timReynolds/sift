import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { RepoPath, Sha, type ReviewState, type WorkspaceArtifact } from './contracts.ts';
import { captureArtifact, restoreArtifact, storeArtifact } from './artifacts.ts';
import type { SnapshotStore } from './persistence.ts';
import { createSandbox } from './sandbox.ts';

export type HostCommand = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: Buffer;
    signal?: AbortSignal;
  },
) => Promise<Buffer>;
export const hostCommand: HostCommand = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stop = () => {
      try {
        if (child.pid && process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        /* Already exited. */
      }
    };
    options.signal?.addEventListener('abort', stop, {
      once: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 512 * 1024 * 1024) {
        stop();
        reject(new Error('Repository export exceeds the 512 MiB runner limit'));
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      options.signal?.removeEventListener('abort', stop);
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(
          new Error(
            `${command} exited ${code}: ${stderr.replace(/https?:\/\/\S+@/g, '[redacted URL]')}`,
          ),
        );
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });

/** Fetch-only host checkout. Credentials are ephemeral process configuration, never a remote URL or .git/config. */
export class GitSource {
  #repositories = new Map<string, Promise<string>>();
  readonly directory: string;
  readonly token: string;
  readonly signal?: AbortSignal;
  readonly run: HostCommand;
  constructor(
    directory: string,
    token: string,
    signal?: AbortSignal,
    run: HostCommand = hostCommand,
  ) {
    this.directory = directory;
    this.token = token;
    this.signal = signal;
    this.run = run;
  }
  private env(auth = false): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: this.directory,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ...(auth
        ? {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`,
          }
        : {}),
    };
  }
  async export(
    repository: string,
    revision: string,
    destination: string,
    signal = this.signal,
  ): Promise<string[]> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error('Invalid repository');
    }
    Sha.parse(revision);
    const commandSignal = () =>
      signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000);
    let preparation = this.#repositories.get(repository);
    if (!preparation) {
      preparation = (async () => {
        const path = join(this.directory, repository.replace('/', '-'));
        await mkdir(path, {
          recursive: true,
        });
        await this.run('git', ['init', '--bare', path], {
          env: this.env(),
          signal: commandSignal(),
        });
        return path;
      })();
      this.#repositories.set(repository, preparation);
    }
    const bare = await preparation;
    await this.run(
      'git',
      [
        '-C',
        bare,
        '-c',
        'protocol.file.allow=never',
        'fetch',
        '--no-tags',
        '--depth=1',
        `https://github.com/${repository}.git`,
        revision,
      ],
      {
        env: this.env(true),
        signal: commandSignal(),
      },
    );
    const fetched = (
      await this.run('git', ['-C', bare, 'rev-parse', 'FETCH_HEAD^{commit}'], {
        env: this.env(),
        signal: commandSignal(),
      })
    )
      .toString()
      .trim();
    if (fetched !== revision) {
      throw new Error('Fetched revision differs from the exact requested commit');
    }
    const entries = (
      await this.run('git', ['-C', bare, 'ls-tree', '-rz', revision], {
        env: this.env(),
        signal: commandSignal(),
      })
    )
      .toString()
      .split('\0')
      .filter(Boolean);
    const paths: string[] = [];
    const links: string[] = [];
    const gaps: string[] = [];
    const blobs: Array<{
      path: string;
      oid: string;
      mode: string;
    }> = [];
    for (const entry of entries) {
      const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match) {
        throw new Error('Unsupported repository tree entry');
      }
      const path = RepoPath.parse(match[4]);
      paths.push(path);
      if (path.split('/').some((part) => part.toLowerCase() === '.git')) {
        throw new Error('Repository archive contains Git administration files');
      }
      if (match[1] === '120000') {
        links.push(path);
      }
      if (match[2] === 'commit') {
        gaps.push(
          `Submodule ${path} is not checked out; inspect its pinned change through GitHub before claiming coverage`,
        );
      } else {
        blobs.push({
          path,
          oid: match[3]!,
          mode: match[1]!,
        });
      }
    }
    for (const link of links) {
      if (paths.some((path) => path.startsWith(link + '/'))) {
        throw new Error('Repository archive traverses a symlink');
      }
    }
    // Read raw blobs instead of git archive: export-ignore/export-subst attributes must
    // never hide or alter files in the exact revision being investigated.
    const contents = await this.run('git', ['-C', bare, 'cat-file', '--batch'], {
      input: Buffer.from(blobs.map((blob) => blob.oid).join('\n') + (blobs.length ? '\n' : '')),
      env: this.env(),
      signal: commandSignal(),
    });
    await mkdir(dirname(destination), {
      recursive: true,
    });
    await mkdir(destination); // Never extract over an existing checkout or its symlinks.
    let offset = 0;
    const symlinks: Array<{
      path: string;
      target: string;
    }> = [];
    for (const blob of blobs) {
      const newline = contents.indexOf(10, offset);
      if (newline < 0) {
        throw new Error('Truncated Git blob header');
      }
      const header = /^([a-f0-9]{40}) blob (\d+)$/.exec(
        contents.subarray(offset, newline).toString(),
      );
      if (!header || header[1] !== blob.oid) {
        throw new Error('Git blob identity mismatch');
      }
      const length = Number(header[2]);
      const start = newline + 1;
      const end = start + length;
      if (!Number.isSafeInteger(length) || end >= contents.length || contents[end] !== 10) {
        throw new Error('Truncated Git blob content');
      }
      const data = contents.subarray(start, end);
      offset = end + 1;
      const path = join(destination, blob.path);
      await mkdir(dirname(path), {
        recursive: true,
      });
      if (blob.mode === '120000') {
        symlinks.push({
          path,
          target: data.toString(),
        });
      } else {
        if (!['100644', '100755'].includes(blob.mode)) {
          throw new Error('Unsupported Git file mode');
        }
        await writeFile(path, data);
        await chmod(path, blob.mode === '100755' ? 0o755 : 0o644);
        if (
          data.subarray(0, 80).toString().startsWith('version https://git-lfs.github.com/spec/v1\n')
        ) {
          gaps.push(`Git LFS object ${blob.path} is a pointer; its content has not been restored`);
        }
      }
    }
    if (offset !== contents.length) {
      throw new Error('Unexpected trailing Git blob data');
    }
    // Add symlinks only after writing all files, so no extraction can traverse them.
    for (const link of symlinks) {
      await symlink(link.target, link.path);
    }
    return gaps;
  }
}

type Workspace = {
  path: string;
  name: string;
  environment?: ExecutionEnv;
};
type WorkspaceOptions = {
  root: string;
  baseline: string;
  revision: string;
  store: SnapshotStore;
  keyPrefix: string;
  secrets: string[];
  commandTimeoutSeconds: number;
  image?: string;
  sandbox?: typeof createSandbox;
};
export class Workspaces {
  readonly items = new Map<string, Workspace>();
  readonly options: WorkspaceOptions;
  constructor(options: WorkspaceOptions) {
    this.options = options;
  }
  async prepare(
    id: string,
    name: string,
    artifact?: WorkspaceArtifact,
  ): Promise<string | undefined> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error('Invalid workspace identity');
    }
    if (this.items.has(id)) {
      return undefined;
    }
    const path = join(this.options.root, id);
    await cp(this.options.baseline, path, {
      recursive: true,
      verbatimSymlinks: true,
    });
    let failure: string | undefined;
    if (artifact) {
      const result = await restoreArtifact(
        this.options.store,
        artifact,
        path,
        this.options.revision,
      );
      if (!result.restored) {
        failure = result.reason;
        await rm(path, {
          recursive: true,
          force: true,
        });
        await cp(this.options.baseline, path, {
          recursive: true,
          verbatimSymlinks: true,
        });
      }
    }
    this.items.set(id, {
      path,
      name,
    });
    return failure;
  }
  async environment(id: string, name: string): Promise<ExecutionEnv> {
    await this.prepare(id, name);
    const item = this.items.get(id)!;
    item.environment ??= await (this.options.sandbox ?? createSandbox)({
      workspace: item.path,
      id,
      image: this.options.image,
      commandTimeoutSeconds: this.options.commandTimeoutSeconds,
    });
    return item.environment;
  }
  async stop(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.items.values()].map((item) => item.environment?.cleanup(BACKGROUND_CONTEXT)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
  }
  async save(state: ReviewState): Promise<void> {
    // Stop containers first so background shell processes cannot race artifact capture.
    await this.stop();
    for (const [id, item] of this.items) {
      const data = await captureArtifact({
        workspace: item.path,
        baseline: this.options.baseline,
        workspaceId: id,
        specialist: item.name,
        baseCommit: this.options.revision,
        secrets: this.options.secrets,
      });
      if (data) {
        state.artifacts[id] = await storeArtifact(
          this.options.store,
          this.options.keyPrefix,
          data,
          {
            workspaceId: id,
            specialist: item.name,
            baseCommit: this.options.revision,
          },
        );
      } else {
        delete state.artifacts[id];
      }
    }
  }
}
