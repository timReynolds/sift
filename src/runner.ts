import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Config, loadConfig, type McpServer } from './config.ts';
import { COMPATIBILITY, digest, Sha } from './contracts.ts';
import { runReview, type ReviewResult } from './engine.ts';
import { normalizeEvent } from './events.ts';
import { GitHubReadApi, readPullContext, relevantMessages } from './github.ts';
import { GitHubPublication } from './github-publication.ts';
import {
  GITHUB_READ_METHODS,
  GITHUB_READ_TOOLS,
  GITHUB_WRITE_METHODS,
  GITHUB_WRITE_TOOLS,
  McpConnection,
  type Scope,
} from './mcp.ts';
import { installGitHubMcp } from './mcp-binary.ts';
import { runnerModels } from './models.ts';
import { GcsSnapshotStore, LocalSnapshotStore } from './persistence.ts';
import { containedPath, loadProfiles } from './profiles.ts';
import type { Capability } from './runtime.ts';
import { GitSource } from './workspaces.ts';

export type RunnerOptions = {
  repository?: string;
  pr?: string;
  config: string;
  state: string;
  event?: string;
  'event-name'?: string;
  'trusted-ref'?: string;
  'dry-run'?: boolean;
  'github-mcp'?: string;
  'runner-config'?: boolean;
  signal?: AbortSignal;
};
export async function runFromOptions(
  options: RunnerOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReviewResult> {
  const botLogin = env.SIFT_BOT_LOGIN ?? 'github-actions[bot]';
  let repository = options.repository ?? env.GITHUB_REPOSITORY;
  let pullNumber = options.pr ? Number(options.pr) : undefined;
  const eventPath = options.event ?? env.GITHUB_EVENT_PATH;
  const eventName = options['event-name'] ?? env.GITHUB_EVENT_NAME;
  const event = eventPath ? JSON.parse(await readFile(eventPath, 'utf8')) : undefined;
  // Preliminary event normalization uses the default mention; trusted config supplies the final decision below.
  if (!repository && event?.repository?.full_name) {
    repository = String(event.repository.full_name);
  }
  if (!pullNumber) {
    pullNumber =
      event?.pull_request?.number ??
      event?.issue?.number ??
      (event?.inputs?.pr ? Number(event.inputs.pr) : undefined);
  }
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('--repository OWNER/REPO is required');
  }
  if (event && eventName === 'issue_comment' && !event.issue?.pull_request) {
    return {
      status: 'skipped',
      reason: 'Issue is not a pull request',
    };
  }
  if (!pullNumber || !Number.isSafeInteger(pullNumber) || pullNumber < 1) {
    throw new Error('--pr NUMBER or a supported GitHub event is required');
  }
  const trustedRevision = Sha.parse(options['trusted-ref'] ?? env.GITHUB_SHA);
  const readToken = env.SIFT_GITHUB_READ_TOKEN;
  const writeToken = env.SIFT_GITHUB_WRITE_TOKEN ?? env.GITHUB_TOKEN;
  if (!readToken) {
    throw new Error(
      'SIFT_GITHUB_READ_TOKEN is required; use a read-only installation or workflow token',
    );
  }
  if (!options['dry-run'] && !writeToken) {
    throw new Error('SIFT_GITHUB_WRITE_TOKEN (or GITHUB_TOKEN) is required for publication');
  }
  if (writeToken && readToken === writeToken) {
    throw new Error(
      'Use separate read and write tokens so model-facing MCP connections have no write credential',
    );
  }
  const root = resolve(options.state);
  await mkdir(root, {
    recursive: true,
  });
  const scratch = await mkdtemp(join(root, 'checkout-'));
  const connections: McpConnection[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Runner cancellation requested'));
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    const source = new GitSource(join(scratch, 'git'), readToken, signal);
    const trustedRoot = join(scratch, 'trusted');
    await source.export(repository, trustedRevision, trustedRoot);
    const config = await loadConfig(
      options['runner-config']
        ? resolve(options.config)
        : await containedPath(trustedRoot, options.config),
    );
    if (event && eventName) {
      const wake = normalizeEvent(eventName, event, {
        mention: config.mention,
        botLogin,
      });
      if (wake.kind === 'skip') {
        return {
          status: 'skipped',
          reason: wake.reason,
        };
      }
      if (
        wake.repository.toLowerCase() !== repository.toLowerCase() ||
        wake.pullNumber !== pullNumber
      ) {
        throw new Error('CLI context differs from event repository/PR');
      }
    }
    const runSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(config.execution.timeoutSeconds * 1000),
    ]);
    const [owner, name] = repository.split('/') as [string, string];
    const scope: Scope = {
      owner,
      name,
      pullNumber,
      ownedThreads: new Set(),
    };
    const binary = options['github-mcp']
      ? resolve(options['github-mcp'])
      : await installGitHubMcp(join(scratch, 'mcp'), runSignal);
    const readerDefinition: McpServer = {
      type: 'stdio',
      command: binary,
      args: ['stdio', '--read-only', '--tools', GITHUB_READ_TOOLS.join(',')],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: 'SIFT_GITHUB_READ_TOKEN',
      },
      tools: GITHUB_READ_TOOLS,
      methods: GITHUB_READ_METHODS,
    };
    const reader = await McpConnection.connect(readerDefinition, {
      env,
      scope,
      expectedVersion: COMPATIBILITY.githubMcp,
    });
    connections.push(reader);
    // Pending reviews are visible only to their creator. The host uses the publication
    // identity for reconciliation; models receive the separate read-only connection.
    let operational = reader;
    if (writeToken) {
      const tools = options['dry-run']
        ? GITHUB_READ_TOOLS
        : [...GITHUB_READ_TOOLS, ...GITHUB_WRITE_TOOLS];
      operational = await McpConnection.connect(
        {
          type: 'stdio',
          command: binary,
          args: ['stdio', '--tools', tools.join(',')],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: 'SIFT_OPERATIONAL_WRITE_TOKEN',
          },
          tools,
          methods: options['dry-run']
            ? GITHUB_READ_METHODS
            : {
                ...GITHUB_READ_METHODS,
                ...GITHUB_WRITE_METHODS,
              },
        },
        {
          env: {
            ...env,
            SIFT_OPERATIONAL_WRITE_TOKEN: writeToken,
          },
          scope,
          expectedVersion: COMPATIBILITY.githubMcp,
        },
      );
      connections.push(operational);
    }
    const api = new GitHubReadApi(scope, writeToken ?? readToken);
    const preflight = await api.pull(pullNumber, runSignal);
    if (
      preflight.state !== 'open' ||
      preflight.head.repo?.id !== preflight.base.repo?.id ||
      (preflight.draft && config.policy.drafts === 'skip')
    ) {
      return {
        status: 'skipped',
        reason:
          preflight.state !== 'open'
            ? 'Pull request is closed'
            : preflight.head.repo?.id !== preflight.base.repo?.id
              ? 'External forks are unsupported in v1'
              : 'Draft policy',
      };
    }
    const context = await readPullContext({
      repository: scope,
      mcp: operational,
      api,
      botLogin,
      signal: runSignal,
    });
    if (
      event?.repository?.id !== undefined &&
      String(event.repository.id) !== context.repository.id
    ) {
      throw new Error('Event repository identity differs from the fetched PR');
    }
    if (!writeToken) {
      context.gaps.push(
        'Dry-run has no publication identity credential; private pending reviews could not be reconciled',
      );
    }
    if (!context.open || !context.internal || (context.draft && config.policy.drafts === 'skip')) {
      return {
        status: 'skipped',
        reason: !context.open
          ? 'Pull request is closed'
          : !context.internal
            ? 'External forks are unsupported in v1'
            : 'Draft policy',
      };
    }
    if (
      eventName === 'pull_request_review_comment' &&
      event?.comment &&
      !relevantMessages(context, config.mention).some((comment) => comment.id === event.comment.id)
    ) {
      return {
        status: 'skipped',
        reason: 'Reply is outside Sift-owned discussion and has no explicit mention',
      };
    }
    const references = `${context.title}\n${context.body}`;
    scope.linkedIssues = [
      ...new Set([
        ...[...references.matchAll(/(?:^|\s)#(\d+)\b/g)].map((match) => Number(match[1])),
        ...[
          ...references.matchAll(
            /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)\b/g,
          ),
        ]
          .filter((match) => match[1]!.toLowerCase() === repository.toLowerCase())
          .map((match) => Number(match[2])),
      ]),
    ];
    const baseline = join(scratch, 'reviewed');
    const sourceGaps = await source.export(repository, context.revision.head, baseline, runSignal);
    let sharedRoot: string | undefined;
    if (config.sources.shared) {
      sharedRoot = join(scratch, 'shared');
      await source.export(
        config.sources.shared.repository,
        config.sources.shared.ref,
        sharedRoot,
        runSignal,
      );
    }
    const profiles = await loadProfiles(config, trustedRoot, sharedRoot);
    const models = await runnerModels(profiles, runSignal);
    const capabilities = new Map<string, Map<string, Capability>>();
    const github = reader.capability('github');
    const secrets = [readToken, writeToken].filter((value): value is string => Boolean(value));
    for (const profile of profiles.values()) {
      const groups = new Map<string, Capability>([['github', github]]);
      for (const [capability, definition] of Object.entries({
        ...config.mcp,
        ...profile.mcp,
      })) {
        if (capability === 'github') {
          throw new Error('The built-in GitHub capability cannot be replaced');
        }
        const refs = Object.values(
          definition.type === 'stdio' ? definition.env : definition.headers,
        );
        if (refs.some((ref) => writeToken && env[ref] === writeToken)) {
          throw new Error(
            'A model-facing MCP connection cannot receive the operational GitHub write credential',
          );
        }
        secrets.push(
          ...refs.map((ref) => env[ref]).filter((value): value is string => Boolean(value)),
        );
        const connection = await McpConnection.connect(definition, {
          env,
        });
        connections.push(connection);
        groups.set(
          capability,
          connection.capability(`mcp_${digest(`${profile.name}:${capability}`).slice(0, 12)}`),
        );
      }
      capabilities.set(profile.name, groups);
    }
    const store =
      config.persistence.mode === 'gcs'
        ? new GcsSnapshotStore(config.persistence.bucket, config.persistence.prefix)
        : new LocalSnapshotStore(join(root, 'objects'));
    return await runReview({
      context,
      config,
      profiles,
      trustedRevision,
      baseline,
      directory: root,
      store,
      models,
      capabilities,
      secrets,
      sourceGaps,
      dryRun: options['dry-run'],
      signal: runSignal,
      isMaintainer: (login) => api.isMaintainer(login, runSignal),
      publication: new GitHubPublication({
        repository: scope,
        reader: operational,
        writer: operational,
        api,
        botLogin,
        ownedThreads: scope.ownedThreads!,
        signal: runSignal,
      }),
      requestId: env.GITHUB_RUN_ID
        ? `actions:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT ?? '1'}`
        : undefined,
    });
  } finally {
    const closed = await Promise.allSettled(connections.map((connection) => connection.close()));
    await rm(scratch, {
      recursive: true,
      force: true,
    });
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    const failed = closed.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      throw failed.reason;
    }
  }
}
