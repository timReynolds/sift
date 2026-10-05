#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { main } from './cli.ts';

/** The Action only maps inputs; the CLI owns validation and invokes the same review engine. */
export function actionArguments(env: NodeJS.ProcessEnv): string[] {
  const args = [
    '--config',
    env.SIFT_INPUT_CONFIG ?? '.sift.yml',
    '--state',
    env.SIFT_INPUT_STATE ?? `${env.RUNNER_TEMP ?? '.'}/sift-state`,
  ];
  for (const [name, value] of [
    ['repository', env.SIFT_INPUT_REPOSITORY ?? env.GITHUB_REPOSITORY],
    ['pr', env.SIFT_INPUT_PR],
    ['trusted-ref', env.SIFT_INPUT_TRUSTED_REF],
  ] as const) {
    if (value) {
      args.push(`--${name}`, value);
    }
  }
  if (env.SIFT_INPUT_DRY_RUN === 'true') {
    args.push('--dry-run');
  }
  return args;
}
export async function actionMain(
  env = process.env,
  execute: (args: string[]) => Promise<void> = main,
): Promise<void> {
  await execute(actionArguments(env));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  actionMain().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
