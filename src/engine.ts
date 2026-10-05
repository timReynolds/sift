import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai/models';
import type { Conversation, Harness } from '@earendil-works/pi-durable';
import type { UsageState } from '@earendil-works/pi-durable';
import {
  COMPATIBILITY,
  emptyReviewState,
  stateKey,
  type Publication,
  type ReviewState,
} from './contracts.ts';
import { configIdentity, type Config } from './config.ts';
import {
  messageVersion,
  relevantMessages,
  type GitHubComment,
  type PullContext,
} from './github.ts';
import { loadInstructions, renderInstructions } from './instructions.ts';
import { persistedRun, type SnapshotStore } from './persistence.ts';
import type { Profile } from './profiles.ts';
import {
  answerReply,
  publishReview,
  reopenFinding,
  resolveFinding,
  type PublicationPort,
} from './publication.ts';
import { coverageGaps, recoverFindings, reviewPlan } from './review.ts';
import { leadReviewTools } from './review-tools.ts';
import { InvestigationDoc, openRuntime, type Capability } from './runtime.ts';
import { ReviewDoc } from './state.ts';
import { Workspaces } from './workspaces.ts';

const background = BACKGROUND_CONTEXT;
export type ReviewResult =
  | {
      status: 'reviewed';
      revision: string;
      verdict: Publication['verdict'];
      publication: Publication['status'];
      persistence: 'saved';
      selected: string[];
      skipped: Array<{
        name: string;
        reason: string;
      }>;
      failed: Array<{
        name: string;
        reason: string;
      }>;
      findings: Record<string, number>;
      gaps: string[];
      usage: UsageState;
      plan: Publication;
    }
  | {
      status: 'skipped';
      reason: string;
    };
export type EngineOptions = {
  context: PullContext;
  config: Config;
  profiles: Map<string, Profile>;
  trustedRevision: string;
  baseline: string;
  directory: string;
  store: SnapshotStore;
  models: Models;
  publication: PublicationPort;
  capabilities?: Map<string, Map<string, Capability>>;
  secrets?: string[];
  dryRun?: boolean;
  signal?: AbortSignal;
  sourceGaps?: string[];
  isMaintainer: (login: string) => Promise<boolean>;
  workspaces?: (options: ConstructorParameters<typeof Workspaces>[0]) => Workspaces;
  requestId?: string;
};

/** One engine serves the CLI and Action. Model/provider/network boundaries are injectable; Pi and SQLite are real. */
export async function runReview(options: EngineOptions): Promise<ReviewResult> {
  const { context, config } = options;
  if (!context.open) {
    return {
      status: 'skipped',
      reason: 'Pull request is closed',
    };
  }
  if (!context.internal) {
    return {
      status: 'skipped',
      reason: 'External forks are outside the trusted v1 execution scope',
    };
  }
  if (context.draft && config.policy.drafts === 'skip') {
    return {
      status: 'skipped',
      reason: 'Draft pull request policy',
    };
  }
  await mkdir(options.directory, {
    recursive: true,
  });
  const runDirectory = await mkdtemp(join(options.directory, 'run-'));
  const database = join(runDirectory, 'session.sqlite');
  const key = stateKey(context.repository);
  const timeout = AbortSignal.timeout(config.execution.timeoutSeconds * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const ctx = withAbortSignal(signal, background);
  let harness: Harness | undefined;
  let root: Conversation | undefined;
  const manager = (options.workspaces ?? ((value) => new Workspaces(value)))({
    root: join(runDirectory, 'workspaces'),
    baseline: options.baseline,
    revision: context.revision.head,
    store: options.store,
    keyPrefix: key.replace(/\/session.sqlite$/, ''),
    secrets: options.secrets ?? [],
    commandTimeoutSeconds: config.execution.commandTimeoutSeconds,
    image: config.execution.containerImage,
  });
  await mkdir(manager.options.root, {
    recursive: true,
  });
  const messages = new Map<string, GitHubComment>();
  for (const message of relevantMessages(context, config.mention)) {
    // Permission lookup failure never grants dismissal authority.
    messages.set(messageVersion(message), {
      ...message,
      maintainer: await options.isMaintainer(message.author).catch(() => false),
    });
  }
  const instructions = renderInstructions(await loadInstructions(options.baseline));
  const reviewContext = JSON.stringify({
    repository: context.repository,
    revision: context.revision,
    title: context.title,
    body: context.body,
    files: context.files,
    diff: context.diff,
    checks: context.checks,
    reviews: context.reviews,
    threads: context.threads,
  });
  const snapshot = async (): Promise<ReviewState> =>
    structuredClone(
      (await harness!.snapshot(ReviewDoc, root!.id, background)) ?? emptyReviewState(),
    );
  const save = async (state: ReviewState) =>
    root!.commit(async (tx) => {
      Object.assign(await tx.doc(ReviewDoc, root!.id), structuredClone(state));
    }, background);
  let closed = false;
  try {
    const persisted = await persistedRun({
      store: options.store,
      key,
      database,
      run: async () => {
        const runtime = await openRuntime(
          {
            database,
            config,
            profiles: options.profiles,
            models: options.models,
            revision: context.revision,
            reviewContext,
            instructions,
            environment: manager.environment.bind(manager),
            capabilities: options.capabilities,
            leadTools: leadReviewTools({
              baseline: options.baseline,
              messages,
              head: context.revision.head,
            }),
            prepare: async (opened, lead) => {
              // This callback runs before the first model request or resumed task.
              harness = opened;
              root = lead;
              const state = await snapshot();
              if (
                state.identity &&
                (state.identity.id !== context.repository.id ||
                  state.identity.pullNumber !== context.repository.pullNumber)
              ) {
                throw new Error('Database belongs to a different repository/PR');
              }
              if (
                state.compatibility &&
                (state.compatibility.pi !== COMPATIBILITY.pi ||
                  state.compatibility.githubMcp !== COMPATIBILITY.githubMcp)
              ) {
                throw new Error(
                  'Incompatible saved runtime version; preserve the database and migrate explicitly',
                );
              }
              const identity = configIdentity(config, options.trustedRevision);
              const changed = Boolean(
                state.revision &&
                  (state.revision.head !== context.revision.head ||
                    state.revision.base !== context.revision.base),
              );
              const reconfigured = Boolean(
                state.compatibility && state.compatibility.configHash !== identity,
              );
              const restarts: string[] = [];
              if (!changed && !reconfigured) {
                for (const reference of Object.values(state.artifacts)) {
                  const failure = await manager.prepare(
                    reference.workspaceId,
                    reference.specialist,
                    reference,
                  );
                  if (failure) {
                    restarts.push(`${reference.specialist}: ${failure}`);
                    delete state.artifacts[reference.workspaceId];
                  }
                }
              }
              if (changed || reconfigured || restarts.length) {
                await lead.abort(background, {
                  background: true,
                });
                // Retain findings, discussions and publication receipts; new work must establish coverage.
                state.selected = Object.fromEntries(
                  Object.entries(state.selected)
                    .filter(([, agent]) => agent.error || agent.status === 'failed')
                    .map(([name, agent]) => {
                      const retained = {
                        ...agent,
                        status: 'failed' as const,
                      };
                      delete retained.conversationId;
                      return [name, retained];
                    }),
                );
                // Retain earlier decisions and undecided submissions across revisions too.
                // A changed head is not evidence that an uninvestigated concern disappeared.
                delete state.scope;
                delete state.coverage;
                if (changed || reconfigured) {
                  state.artifacts = {};
                }
                await lead.commit(async (tx) => {
                  const doc = await tx.doc(InvestigationDoc, lead.id);
                  doc.workspaceId = `lead-${context.revision.head}`;
                  if (reconfigured) {
                    doc.capabilities = [];
                  }
                }, background);
                await lead.reset(
                  `Review restarted deliberately: ${changed ? 'comparison revision changed; ' : ''}${reconfigured ? 'trusted configuration changed; ' : ''}${restarts.join('; ')}. Existing feedback is retained in review_state and must be rechecked.`,
                  background,
                );
              }
              state.identity = context.repository;
              state.revision = context.revision;
              state.compatibility = {
                pi: COMPATIBILITY.pi,
                githubMcp: COMPATIBILITY.githubMcp,
                configHash: identity,
                trustedRevision: options.trustedRevision,
              };
              state.gaps = [...context.gaps, ...(options.sourceGaps ?? [])];
              recoverFindings(state, context);
              for (const [sourceKey] of messages) {
                const sourcePrefix = sourceKey.split(':').slice(0, 2).join(':') + ':';
                for (const [priorKey, imported] of Object.entries(state.importedMessages)) {
                  if (
                    priorKey !== sourceKey &&
                    priorKey.startsWith(sourcePrefix) &&
                    !imported.answered
                  ) {
                    imported.disposition = `Superseded by edited message ${sourceKey}`;
                    delete imported.replyBody;
                    delete imported.targetId;
                  }
                }
                state.importedMessages[sourceKey] ??= {
                  requestId: `github:${sourceKey}`,
                  answered: false,
                };
              }
              await save(state);
            },
          },
          background,
        );
        harness = runtime.harness;
        root = runtime.root;
        const initial = await snapshot();
        for (const [sourceKey, message] of messages) {
          // Passive, idempotent imports carry public source data without interpreting it as host authority.
          await root.submit(
            {
              type: 'write',
              requestId: initial.importedMessages[sourceKey]!.requestId,
              entry: {
                kind: 'sift.github_message',
                model: [
                  {
                    role: 'user',
                    content: `Untrusted GitHub discussion to investigate: ${JSON.stringify({
                      sourceKey,
                      ...message,
                    })}`,
                    timestamp: Date.now(),
                  },
                ],
              },
            },
            ctx,
          );
        }
        const pending = await harness.inspect(ctx);
        if (pending.tasks.length || pending.submissions.length) {
          await root.waitForIdle(ctx);
        }
        const submission = await root.submit(
          {
            type: 'input',
            requestId: options.requestId ?? `review:${randomUUID()}`,
            content: `${reviewContext}\n\nInspect review_state first. Read previous feedback and imported human discussion; choose scope and specialist selection, run investigations, decide each candidate, recheck outstanding findings, respond_to_human as needed, then complete_review. Available lead capabilities: ${
              [...(options.capabilities?.get(config.lead)?.keys() ?? [])].join(', ') || 'none'
            }.`,
          },
          ctx,
        );
        const result = await submission.wait(ctx);
        if (result.status !== 'done') {
          throw new Error(`Lead review did not complete (${result.status})`);
        }
        const state = await snapshot();
        const checkpoint = async () => save(state);
        // This phase alone has GitHub write authority. Pi tools above only persist validated intent.
        for (const [id, record] of Object.entries(state.findings)) {
          if (
            record.github?.threadId &&
            ['fixed', 'disproven', 'superseded', 'dismissed'].includes(record.status) &&
            record.checkedRevision === context.revision.head
          ) {
            await resolveFinding(state, id, options.publication, checkpoint, options.dryRun);
          }
          if (
            record.github?.threadId &&
            record.status === 'still_valid' &&
            record.checkedRevision === context.revision.head &&
            context.threads.some(
              (thread) => thread.id === record.github?.threadId && thread.resolved,
            )
          ) {
            await reopenFinding(state, id, options.publication, checkpoint, options.dryRun);
          }
        }
        for (const [sourceKey, imported] of Object.entries(state.importedMessages)) {
          if (!imported.answered && imported.replyBody && imported.targetId) {
            await answerReply(
              state,
              sourceKey,
              imported.targetId,
              imported.replyBody,
              options.publication,
              checkpoint,
              options.dryRun,
            );
          }
        }
        const plan = reviewPlan(
          state,
          context,
          config.policy,
          config.profiles,
          state.coverage?.summary ?? 'Lead did not provide a complete coverage statement.',
        );
        await publishReview(state, plan, options.publication, checkpoint, options.dryRun);
        const gaps = coverageGaps(state, config.profiles);
        state.reviewedRevisions.push({
          revision: context.revision,
          coverageComplete: gaps.length === 0,
          verdict: plan.verdict,
        });
        await checkpoint();
        const selections = Object.values(state.selected);
        const counts: Record<string, number> = {
          P0: 0,
          P1: 0,
          P2: 0,
          P3: 0,
        };
        for (const record of Object.values(state.findings)) {
          if (
            record.decision === 'accepted' &&
            ['still_valid', 'needs_investigation'].includes(record.status)
          ) {
            counts[record.finding.priority]!++;
          }
        }
        return {
          status: 'reviewed' as const,
          revision: context.revision.head,
          verdict: plan.verdict,
          publication: plan.status,
          selected: selections.filter((agent) => agent.selected).map((agent) => agent.name),
          skipped: selections
            .filter((agent) => !agent.selected)
            .map(({ name, reason }) => ({
              name,
              reason,
            })),
          failed: selections
            .filter((agent) => agent.error || agent.status === 'failed')
            .map((agent) => ({
              name: agent.name,
              reason: agent.error ?? 'Incomplete investigation',
            })),
          findings: counts,
          gaps,
          usage: await harness.usage(background),
          plan,
        };
      },
      beforeClose: async () => {
        if (!harness || !root) {
          return;
        }
        // Abort admissions and shell processes before taking the filesystem companion snapshot.
        await root.abort(background, {
          background: true,
        });
        const state = await snapshot();
        await manager.save(state);
        await save(state);
      },
      close: async () => {
        await harness?.close(background);
        closed = true;
      },
    });
    return {
      ...persisted.result,
      persistence: persisted.persistence,
    };
  } finally {
    if (!closed) {
      await harness?.close(background);
    }
    await manager.stop();
  }
}
