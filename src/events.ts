import { z } from 'zod';

const Payload = z
  .object({
    action: z.string().optional(),
    number: z.number().int().positive().optional(),
    repository: z.object({
      id: z.number().int().positive(),
      name: z.string(),
      owner: z.object({
        login: z.string(),
      }),
    }),
    sender: z
      .object({
        login: z.string(),
        type: z.string().optional(),
      })
      .optional(),
    issue: z
      .object({
        number: z.number().int().positive(),
        pull_request: z.unknown().optional(),
      })
      .optional(),
    pull_request: z
      .object({
        number: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    comment: z
      .object({
        id: z.number().int().positive(),
        body: z.string(),
        user: z.object({
          login: z.string(),
          type: z.string().optional(),
        }),
        in_reply_to_id: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type WakeUp =
  | {
      kind: 'review';
      repository: string;
      repositoryId: string;
      pullNumber: number;
      source: string;
    }
  | {
      kind: 'skip';
      reason: string;
    };

/** Events only identify work. PR state and exact revisions must always be fetched afresh. */
export function normalizeEvent(
  name: string,
  value: unknown,
  options: {
    mention: string;
    botLogin?: string;
  },
): WakeUp {
  const event = Payload.parse(value);
  const actor = event.comment?.user ?? event.sender;
  if (
    ((name === 'issue_comment' || name === 'pull_request_review_comment') &&
      actor?.type === 'Bot') ||
    (options.botLogin && actor?.login.toLowerCase() === options.botLogin.toLowerCase())
  ) {
    return {
      kind: 'skip',
      reason: 'Bot-generated event',
    };
  }
  let pullNumber: number | undefined;
  if (name === 'pull_request' || name === 'pull_request_target') {
    if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(event.action ?? '')) {
      return {
        kind: 'skip',
        reason: 'Unrelated PR event',
      };
    }
    pullNumber = event.pull_request?.number ?? event.number;
  } else if (name === 'pull_request_review_comment') {
    if (!['created', 'edited'].includes(event.action ?? '') || !event.comment) {
      return {
        kind: 'skip',
        reason: 'Unrelated review comment event',
      };
    }
    if (!event.comment.in_reply_to_id && !mentioned(event.comment.body, options.mention)) {
      return {
        kind: 'skip',
        reason: 'Review comment is not a reply or explicit mention',
      };
    }
    // The host subsequently checks whether this reply belongs to a relevant review thread.
    pullNumber = event.pull_request?.number ?? event.number;
  } else if (name === 'issue_comment') {
    if (!event.issue?.pull_request) {
      return {
        kind: 'skip',
        reason: 'Issue is not a pull request',
      };
    }
    if (
      !['created', 'edited'].includes(event.action ?? '') ||
      !event.comment ||
      !mentioned(event.comment.body, options.mention)
    ) {
      return {
        kind: 'skip',
        reason: 'Unrelated PR conversation message',
      };
    }
    pullNumber = event.issue.number;
  } else if (name === 'workflow_dispatch') {
    const input = event.inputs?.pr;
    if (typeof input !== 'string' || !/^[1-9]\d*$/.test(input)) {
      throw new Error('Manual dispatch requires a positive pr input');
    }
    pullNumber = Number(input);
  } else {
    return {
      kind: 'skip',
      reason: `Unsupported event ${name}`,
    };
  }
  if (!pullNumber || !Number.isSafeInteger(pullNumber)) {
    throw new Error('Event did not identify a valid pull request');
  }
  return {
    kind: 'review',
    repository: `${event.repository.owner.login}/${event.repository.name}`,
    repositoryId: String(event.repository.id),
    pullNumber,
    source: event.comment ? `${name}:${event.comment.id}` : name,
  };
}

export function mentioned(body: string, mention: string): boolean {
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)(?:@${escaped}|/${escaped})(?![A-Za-z0-9_-])`, 'i').test(body);
}
