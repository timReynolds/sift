import { readFile } from 'node:fs/promises';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { Finding, RepoPath, Sha } from './contracts.ts';
import type { GitHubComment } from './github.ts';
import { containedPath } from './profiles.ts';
import { recordDecision } from './review.ts';
import { ReviewDoc } from './state.ts';

const CodeEvidence = z
  .object({
    path: RepoPath,
    revision: Sha,
    quote: z.string().min(1).optional(),
    deleted: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.quote) !== Boolean(value.deleted),
    'Provide an exact code quote or confirm a deleted path',
  );
const Recheck = z
  .object({
    findingId: z.string(),
    status: z.enum(['still_valid', 'fixed', 'disproven', 'superseded', 'dismissed']),
    reason: z.string().min(1),
    code: CodeEvidence,
    finding: Finding.optional(),
    dismissalSource: z.string().optional(),
  })
  .strict();
const response = (value: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify(value),
    },
  ],
});

export function leadReviewTools(options: {
  baseline: string;
  messages: Map<string, GitHubComment>;
  head: string;
}): ToolRegistration[] {
  return [
    defineTool({
      name: 'cover_failed_investigation',
      description:
        'Record that another successfully completed specialist covered a failed investigation. Identify its concrete evidence and why it covers the same question; skipping alone cannot erase failure.',
      parameters: Type.Object({
        failedAgent: Type.String(),
        investigator: Type.String(),
        evidence: Type.String({
          minLength: 1,
        }),
      }),
      replay: 'safe',
      executionMode: 'sequential',
      execute: async (args, api, ctx) => {
        await api.commit(async (tx) => {
          const state = await tx.doc(ReviewDoc, api.conversationId);
          const failed = state.selected[args.failedAgent];
          const replacement = state.selected[args.investigator];
          if (
            !failed ||
            (!failed.error && failed.status !== 'failed') ||
            args.failedAgent === args.investigator ||
            replacement?.status !== 'completed' ||
            replacement.error
          ) {
            throw new Error('A distinct completed investigator must cover a recorded failure');
          }
          failed.selected = false;
          failed.status = 'skipped';
          delete failed.error;
          failed.reason = `Coverage supplied by ${args.investigator}: ${args.evidence}`;
        }, ctx);
        return response({
          recorded: true,
        });
      },
    }),
    defineTool({
      name: 'review_state',
      description:
        'Read outstanding findings, candidates, decisions, human message imports, coverage and publication history.',
      parameters: Type.Object({}),
      replay: 'safe',
      execute: async (_args, api, ctx) =>
        response(await api.snapshot(ReviewDoc, api.conversationId, ctx)),
    }),
    defineTool({
      name: 'decide_finding',
      description:
        'Accept or reject a candidate, record validation evidence, and merge underlying duplicates using one issueKey or existingFindingId. Suppress nits and unsupported claims.',
      parameters: Type.Object({
        candidateId: Type.String(),
        decision: Type.Union([Type.Literal('accepted'), Type.Literal('rejected')]),
        reason: Type.String({
          minLength: 1,
        }),
        issueKey: Type.Optional(Type.String()),
        existingFindingId: Type.Optional(Type.String()),
        validation: Type.Optional(Type.String()),
      }),
      replay: 'safe',
      executionMode: 'sequential',
      execute: async (args, api, ctx) => {
        await api.commit(async (tx) => {
          recordDecision(await tx.doc(ReviewDoc, api.conversationId), args);
        }, ctx);
        return response({
          recorded: true,
        });
      },
    }),
    defineTool({
      name: 'recheck_finding',
      description:
        'Update earlier feedback after inspecting current code. The host verifies your exact quote at the current head (or path deletion). Still-valid findings need a complete updated finding. A maintainer dismissal also needs its imported message key. Resolution is performed later by the host.',
      parameters: Type.Unsafe<z.infer<typeof Recheck>>(z.toJSONSchema(Recheck)),
      replay: 'safe',
      executionMode: 'sequential',
      execute: async (input, api, ctx) => {
        const args = Recheck.parse(input);
        if (args.code.revision !== options.head) {
          throw new Error('Code evidence must reference the current head');
        }
        let code: string | undefined;
        try {
          code = await readFile(await containedPath(options.baseline, args.code.path), 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        if (args.code.deleted ? code !== undefined : !code?.includes(args.code.quote!)) {
          throw new Error('Code evidence does not match the immutable current checkout');
        }
        await api.commit(async (tx) => {
          const state = await tx.doc(ReviewDoc, api.conversationId);
          const record = state.findings[args.findingId];
          if (!record) {
            throw new Error('Unknown earlier finding');
          }
          if (args.status === 'still_valid') {
            if (!args.finding) {
              throw new Error('Still-valid findings need an updated location and evidence');
            }
            const expected =
              args.finding.anchor.side === 'RIGHT'
                ? state.revision?.head
                : state.revision?.mergeBase;
            if (args.finding.anchor.revision !== expected || args.finding.id !== args.findingId) {
              throw new Error('Updated finding identity or revision differs');
            }
            record.finding = args.finding;
          }
          if (args.status === 'dismissed') {
            const message = args.dismissalSource
              ? options.messages.get(args.dismissalSource)
              : undefined;
            if (!message?.maintainer) {
              throw new Error('Only a verified maintainer can explicitly dismiss feedback');
            }
            record.dismissal = {
              by: message.author,
              sourceId: args.dismissalSource!,
              reason: args.reason,
            };
          } else if (record.status === 'dismissed') {
            throw new Error('An explicit maintainer dismissal is preserved; do not repost it');
          }
          record.status = args.status;
          record.reason = args.reason;
          record.checkedRevision = options.head;
        }, ctx);
        return response({
          recorded: true,
        });
      },
    }),
    defineTool({
      name: 'respond_to_human',
      description:
        'Record a concise evidence-based response to an imported human message, or a reason it requires no answer. No credentials or permissions can be changed. The host reconciles and publishes the reply once.',
      parameters: Type.Object({
        sourceKey: Type.String(),
        reason: Type.String({
          minLength: 1,
        }),
        body: Type.Optional(
          Type.String({
            minLength: 1,
          }),
        ),
      }),
      replay: 'safe',
      executionMode: 'sequential',
      execute: async (args, api, ctx) => {
        const message = options.messages.get(args.sourceKey);
        if (!message || message.bot) {
          throw new Error('Unknown human message');
        }
        await api.commit(async (tx) => {
          const imported = (await tx.doc(ReviewDoc, api.conversationId)).importedMessages[
            args.sourceKey
          ];
          if (!imported) {
            throw new Error('Message was not durably imported');
          }
          imported.disposition = args.reason;
          if (args.body) {
            imported.replyBody = args.body;
            imported.targetId = message.replyTo ?? message.id;
          }
        }, ctx);
        return response({
          recorded: true,
        });
      },
    }),
    defineTool({
      name: 'complete_review',
      description:
        'Record actual coverage and a concise public conclusion after deciding every candidate and investigating outstanding feedback. Failed specialists and unrechecked findings still prevent approval.',
      parameters: Type.Object({
        complete: Type.Boolean(),
        summary: Type.String({
          minLength: 1,
        }),
      }),
      replay: 'safe',
      executionMode: 'sequential',
      execute: async (args, api, ctx) => {
        await api.commit(async (tx) => {
          (await tx.doc(ReviewDoc, api.conversationId)).coverage = {
            ...args,
            head: options.head,
          };
        }, ctx);
        return response({
          recorded: true,
        });
      },
    }),
  ];
}
