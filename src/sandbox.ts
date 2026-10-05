import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@earendil-works/chord';
import {
  err,
  ExecutionError,
  FileError,
  ok,
  type ExecutionEnv,
  type FileErrorCode,
  type Result,
  type ShellExecOptions,
  type TextLineReader,
} from '@earendil-works/pi-durable/env';

export const DEFAULT_INVESTIGATION_IMAGE =
  'node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6';

function packageRoot(): string {
  let path = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(path, 'runtime/sandbox-worker.mjs'))) {
    const parent = dirname(path);
    if (parent === path) {
      throw new Error('Sift sandbox worker is missing from the package');
    }
    path = parent;
  }
  return path;
}

export type CommandRunner = (
  args: string[],
  input?: string,
  signal?: AbortSignal,
  onLine?: (line: string) => void,
) => Promise<string>;
export const dockerCommand: CommandRunner = (args, input, signal, onLine) =>
  new Promise((resolve, reject) => {
    // Only the Docker client receives runner configuration. No host environment is forwarded to a container.
    const child = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (!onLine) {
        stdout += chunk;
      } else {
        pending += chunk;
        let newline;
        try {
          while ((newline = pending.indexOf('\n')) !== -1) {
            onLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
        } catch (error) {
          child.kill();
          reject(error);
        }
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`Investigation container command failed (${code}): ${stderr}`)),
    );
    child.stdin.on('error', () => {
      /* Exit/error handlers report a closed worker pipe. */
    });
    child.stdin.end(input);
  });

type WireResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        path?: string;
        spillPath?: string;
      };
    };

/** All Pi file and shell operations cross the container boundary, including absolute paths and symlinks. */
export async function createSandbox(options: {
  workspace: string;
  id: string;
  image?: string;
  commandTimeoutSeconds: number;
  run?: CommandRunner;
}): Promise<ExecutionEnv> {
  const run = options.run ?? dockerCommand;
  const image = options.image ?? DEFAULT_INVESTIGATION_IMAGE;
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('Investigation image must be pinned by digest');
  }
  const root = packageRoot();
  const workspace = await realpath(options.workspace);
  // Docker's --mount parser cannot quote commas in a source path.
  if ([workspace, root].some((path) => /[,\r\n]/.test(path))) {
    throw new Error('Container mount paths cannot contain commas or newlines');
  }
  const container = `sift-${randomUUID()}`;
  await run([
    'run',
    '--detach',
    '--rm',
    '--name',
    container,
    '--label',
    'sift.investigation=true',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=256',
    '--memory=4g',
    '--cpus=2',
    '--mount',
    `type=bind,src=${workspace},dst=/work`,
    '--mount',
    `type=bind,src=${join(root, 'node_modules')},dst=/opt/sift/node_modules,readonly`,
    '--mount',
    `type=bind,src=${join(root, 'runtime/sandbox-worker.mjs')},dst=/opt/sift/worker.mjs,readonly`,
    '--workdir=/work',
    image,
    'sleep',
    'infinity',
  ]);
  let closed = false;
  const cleanup = async () => {
    if (!closed) {
      closed = true;
      await run(['rm', '--force', container]);
    }
  };
  const rpc = async (
    method: string,
    args: unknown[],
    context: Context,
    onOutput?: (text: string, context: Context) => void,
  ): Promise<WireResult> => {
    if (closed) {
      return {
        ok: false,
        error: {
          code: 'aborted',
          message: 'Investigation container was stopped; restart the investigation deliberately',
        },
      };
    }
    let receipt: WireResult | undefined;
    try {
      await run(
        ['exec', '-i', container, 'node', '/opt/sift/worker.mjs'],
        JSON.stringify({
          method,
          args,
          cwd: '/work',
        }),
        context.abortSignal,
        (line) => {
          const message = JSON.parse(line) as {
            output?: string;
            result?: WireResult;
          };
          if (message.output !== undefined) {
            onOutput?.(message.output, context);
          }
          if (message.result) {
            receipt = message.result;
          }
        },
      );
      if (!receipt) {
        throw new Error('Investigation worker exited without an operation receipt');
      }
      return receipt;
    } catch (error) {
      if (context.abortSignal?.aborted) {
        // Killing docker exec alone can leave the command running in the container.
        await cleanup();
        return {
          ok: false,
          error: {
            code: 'aborted',
            message: 'Investigation cancelled; container stopped',
          },
        };
      }
      return {
        ok: false,
        error: {
          code: 'unknown',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };
  const fileCall = async (
    method: string,
    args: unknown[],
    context: Context,
  ): Promise<Result<unknown, FileError>> => {
    const receipt = await rpc(method, args, context);
    if (!receipt.ok) {
      return err(
        new FileError(
          receipt.error.code as FileErrorCode,
          receipt.error.message,
          receipt.error.path,
        ),
      );
    }
    if (method === 'readBinaryFile') {
      return ok(
        Buffer.from(
          (
            receipt.value as {
              base64: string;
            }
          ).base64,
          'base64',
        ),
      );
    }
    return ok(receipt.value);
  };
  const env = {
    id: `sift:${options.id}`,
    cwd: '/work',
    cleanup,
    exec: async (command: string, execOptions: ShellExecOptions | undefined, context: Context) => {
      const { onOutput, ...rest } = execOptions ?? {};
      const receipt = await rpc(
        'exec',
        [
          command,
          {
            ...rest,
            timeout: Math.min(
              execOptions?.timeout ?? options.commandTimeoutSeconds,
              options.commandTimeoutSeconds,
            ),
          },
        ],
        context,
        onOutput,
      );
      if (receipt.ok) {
        return receipt;
      }
      const error = new ExecutionError(
        receipt.error.code === 'timeout'
          ? 'timeout'
          : receipt.error.code === 'aborted'
            ? 'aborted'
            : 'unknown',
        receipt.error.message,
      );
      error.spillPath = receipt.error.spillPath;
      return err(error);
    },
    openTextLineReader: async (
      path: string,
      context: Context,
    ): Promise<Result<TextLineReader, FileError>> => {
      const receipt = await fileCall('readTextFile', [path], context);
      if (!receipt.ok) {
        return receipt;
      }
      const text = receipt.value as string;
      const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      let index = 0;
      return ok({
        readLine: async (ctx) => {
          if (ctx.abortSignal?.aborted) {
            return err(new FileError('aborted', 'aborted'));
          }
          const line = lines[index++];
          return ok(
            line === undefined
              ? undefined
              : {
                  text: line.replace(/\r?\n$/, ''),
                  terminated: line.endsWith('\n'),
                },
          );
        },
        close: async () => {
          index = lines.length;
        },
      });
    },
  };
  const methods = new Set([
    'absolutePath',
    'joinPath',
    'readTextFile',
    'readTextLines',
    'readBinaryFile',
    'writeFile',
    'appendFile',
    'truncateFile',
    'flushFile',
    'renameFile',
    'fileInfo',
    'listDir',
    'canonicalPath',
    'exists',
    'createDir',
    'remove',
    'createTempDir',
    'createTempFile',
  ]);
  return new Proxy(env, {
    get(target, property, receiver) {
      if (typeof property !== 'string' || !methods.has(property)) {
        return Reflect.get(target, property, receiver);
      }
      return (...input: unknown[]) => {
        const context = input.pop() as Context;
        if (
          (property === 'writeFile' || property === 'appendFile') &&
          input[1] instanceof Uint8Array
        ) {
          input[1] = {
            base64: Buffer.from(input[1]).toString('base64'),
          };
        }
        return fileCall(property, input, context);
      };
    },
  }) as unknown as ExecutionEnv;
}
