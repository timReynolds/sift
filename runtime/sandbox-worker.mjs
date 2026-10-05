// This worker runs inside an investigator container, never on the credential-bearing host.
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

const allowed = new Set([
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
  'exec',
]);
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const { method, args, cwd } = JSON.parse(Buffer.concat(chunks).toString());
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const env = new NodeExecutionEnv({
  cwd,
});
try {
  if (!allowed.has(method)) {
    throw new Error('Unsupported environment operation');
  }
  if ((method === 'writeFile' || method === 'appendFile') && args[1]?.base64 !== undefined) {
    args[1] = Buffer.from(args[1].base64, 'base64');
  }
  if (method === 'exec') {
    args[1] = {
      ...args[1],
      onOutput: (text) =>
        send({
          output: text,
        }),
    };
  }
  const result = await env[method](...args, BACKGROUND_CONTEXT);
  if (method === 'readBinaryFile' && result.ok) {
    result.value = {
      base64: Buffer.from(result.value).toString('base64'),
    };
  }
  if (!result.ok) {
    result.error = {
      code: result.error.code,
      message: result.error.message,
      path: result.error.path,
      spillPath: result.error.spillPath,
    };
  }
  send({
    result,
  });
} catch (error) {
  send({
    result: {
      ok: false,
      error: {
        code: 'unknown',
        message: error instanceof Error ? error.message : String(error),
      },
    },
  });
} finally {
  await env.cleanup(BACKGROUND_CONTEXT);
}
