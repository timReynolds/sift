#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.ts';
import { COMPATIBILITY, PRODUCT } from './contracts.ts';

export function cliOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      help: {
        type: 'boolean',
        short: 'h',
      },
      version: {
        type: 'boolean',
      },
      config: {
        type: 'string',
        default: '.sift.yml',
      },
      repository: {
        type: 'string',
      },
      pr: {
        type: 'string',
      },
      event: {
        type: 'string',
      },
      'event-name': {
        type: 'string',
      },
      state: {
        type: 'string',
        default: '.sift/state',
      },
      'trusted-ref': {
        type: 'string',
      },
      'dry-run': {
        type: 'boolean',
        default: false,
      },
      'validate-config': {
        type: 'boolean',
      },
      'github-mcp': {
        type: 'string',
      },
      'runner-config': {
        type: 'boolean',
        default: false,
      },
    },
    strict: true,
  });
  if (values.pr !== undefined && !/^[1-9]\d*$/.test(values.pr)) {
    throw new Error('--pr must be a positive integer');
  }
  if (
    values.repository !== undefined &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository)
  ) {
    throw new Error('--repository must be owner/repo');
  }
  return values;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = cliOptions(args);
  if (options.help) {
    console.log(
      `${PRODUCT.name}: durable GitHub code review\n\nsift --repository OWNER/REPO --pr NUMBER --config .sift.yml\n  --event PATH --event-name NAME  GitHub event context\n  --state DIRECTORY              Local working state\n  --trusted-ref SHA              Trusted configuration revision\n  --dry-run                      Compute without GitHub writes\n  --runner-config                Trust an explicit runner configuration path\n  --github-mcp PATH              Use a preinstalled pinned server binary\n  --validate-config              Validate configuration and exit\n  --version                      Show compatibility versions`,
    );
    return;
  }
  if (options.version) {
    console.log(JSON.stringify(COMPATIBILITY));
    return;
  }
  if (options['validate-config']) {
    await loadConfig(options.config);
    console.log('Configuration valid');
    return;
  }
  throw new Error(
    'The foundation branch provides configuration validation; review execution arrives in the delivery branch.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
