import { z } from 'zod';
import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { digest, Sha, type Repository, type Revision } from './contracts.ts';
import { mentioned } from './events.ts';
import type { McpCaller } from './mcp.ts';

type ReviewComment =
  RestEndpointMethodTypes['pulls']['listReviewComments']['response']['data'][number];
type Review = RestEndpointMethodTypes['pulls']['listReviews']['response']['data'][number];

export type GitHubComment = Pick<ReviewComment, 'id' | 'body'> & {
  author: string;
  bot: boolean;
  updatedAt: string;
  url: string;
  replyTo?: number;
  reviewId?: number;
  threadId?: string;
  maintainer?: boolean;
};
export type GitHubThread = {
  id: string;
  resolved: boolean;
  outdated: boolean;
  comments: GitHubComment[];
  owned: boolean;
};
export type GitHubReview = Pick<Review, 'id' | 'body' | 'state'> & {
  author: string;
  commit: string;
  url: string;
};
export type ChangedFile = Pick<
  RestEndpointMethodTypes['pulls']['listFiles']['response']['data'][number],
  'filename' | 'previous_filename' | 'status' | 'patch'
>;
export type PullContext = {
  repository: Repository;
  revision: Revision;
  title: string;
  body: string;
  url: string;
  open: boolean;
  draft: boolean;
  internal: boolean;
  author: string;
  botLogin: string;
  files: ChangedFile[];
  diff: string;
  reviews: GitHubReview[];
  threads: GitHubThread[];
  comments: GitHubComment[];
  checks: unknown;
  gaps: string[];
  inlineComments?: GitHubComment[];
};

const User = z.object({
  login: z.string(),
  type: z.string().optional(),
});
const RawComment = z.object({
  id: z.number().int(),
  body: z.string().default(''),
  user: User.nullable(),
  updated_at: z.string(),
  html_url: z.string(),
  in_reply_to_id: z.number().optional(),
  pull_request_review_id: z.number().nullable().optional(),
});
const RawReview = z.object({
  id: z.number().int(),
  body: z.string().nullable().optional(),
  user: User.nullable().optional(),
  state: z.string(),
  commit_id: Sha.nullable().optional(),
  html_url: z.string(),
});
const Branch = z.object({
  sha: Sha,
  ref: z.string(),
  repo: z
    .object({
      id: z.number().int(),
      full_name: z.string(),
    })
    .nullable(),
});
const RawPull = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  state: z.string(),
  draft: z.boolean().default(false),
  user: User.nullable(),
  head: Branch,
  base: Branch,
  changed_files: z.number().int(),
});
const MinimalThread = z.object({
  id: z.string(),
  is_resolved: z.boolean(),
  is_outdated: z.boolean(),
  total_count: z.number(),
  comments: z.array(
    z.object({
      html_url: z.string(),
    }),
  ),
});
const ThreadPage = z.object({
  review_threads: z.array(MinimalThread),
  totalCount: z.number(),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().optional(),
  }),
});
const Files = z.array(
  z.object({
    filename: z.string(),
    previous_filename: z.string().optional(),
    status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
    patch: z.string().optional(),
  }),
) satisfies z.ZodType<ChangedFile[]>;

export function mcpText(receipt: unknown): string {
  const result = CallToolResultSchema.parse(receipt);
  if (result.isError) {
    throw new Error('GitHub MCP returned an error result');
  }
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}
export function mcpJson(receipt: unknown): unknown {
  return JSON.parse(mcpText(receipt));
}

const commentOf = (raw: z.infer<typeof RawComment>): GitHubComment => ({
  id: raw.id,
  body: raw.body,
  author: raw.user?.login ?? '[deleted]',
  bot: raw.user?.type === 'Bot',
  updatedAt: raw.updated_at,
  url: raw.html_url,
  ...(raw.in_reply_to_id === undefined
    ? {}
    : {
        replyTo: raw.in_reply_to_id,
      }),
  ...(raw.pull_request_review_id == null
    ? {}
    : {
        reviewId: raw.pull_request_review_id,
      }),
});
const Comments = z.array(RawComment.transform(commentOf));

const reviewOf = (raw: z.infer<typeof RawReview>): GitHubReview => ({
  id: raw.id,
  body: raw.body ?? '',
  author: raw.user?.login ?? '[deleted]',
  state: raw.state,
  commit: raw.commit_id ?? '',
  url: raw.html_url,
});

export class GitHubReadApi {
  readonly #client: Octokit;
  readonly #repository: { owner: string; repo: string };
  constructor(
    repository: Pick<Repository, 'owner' | 'name'>,
    token: string,
    fetcher: typeof fetch = fetch,
  ) {
    this.#repository = { owner: repository.owner, repo: repository.name };
    this.#client = new Octokit({
      auth: token,
      request: {
        redirect: 'error',
        fetch: async (url: string | URL | Request, options?: RequestInit) => {
          for (let attempt = 0; ; attempt++) {
            const timeout = AbortSignal.timeout(120_000);
            const response = await fetcher(url, {
              ...options,
              signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
            });
            if (attempt >= 2 || response.status < 500) {
              return response;
            }
            await response.body?.cancel();
          }
        },
      },
    });
  }

  #parameters(signal?: AbortSignal) {
    return {
      ...this.#repository,
      headers: { 'x-github-api-version': '2022-11-28' },
      request: { signal },
    };
  }

  async #list<T>(readPage: (page: number) => Promise<{ data: T[] }>): Promise<T[]> {
    // SDK pagination swallows HTTP 409 and drops per-call signals; keep these reads fail-closed.
    const values: T[] = [];
    for (let page = 1; page <= 10000; page++) {
      const { data } = await readPage(page);
      if (!Array.isArray(data)) {
        throw new Error('GitHub returned an invalid comment page');
      }
      values.push(...data);
      if (data.length < 100) {
        return values;
      }
    }
    throw new Error('GitHub pagination limit reached; context is incomplete');
  }

  async pull(pullNumber: number, signal?: AbortSignal) {
    const { data } = await this.#client.rest.pulls.get({
      ...this.#parameters(signal),
      pull_number: pullNumber,
    });
    return RawPull.parse(data);
  }

  async compare(base: string, head: string, signal?: AbortSignal) {
    const { data } = await this.#client.rest.repos.compareCommitsWithBasehead({
      ...this.#parameters(signal),
      basehead: `${base}...${head}`,
    });
    const comparison = z
      .object({
        merge_base_commit: z.object({ sha: Sha }),
      })
      .parse(data);
    return comparison.merge_base_commit.sha;
  }

  inlineComments(pullNumber: number, signal?: AbortSignal) {
    return this.#list((page) =>
      this.#client.rest.pulls.listReviewComments({
        ...this.#parameters(signal),
        pull_number: pullNumber,
        per_page: 100,
        page,
      }),
    );
  }

  conversationComments(pullNumber: number, signal?: AbortSignal) {
    return this.#list((page) =>
      this.#client.rest.issues.listComments({
        ...this.#parameters(signal),
        issue_number: pullNumber,
        per_page: 100,
        page,
      }),
    );
  }

  pendingComments(pullNumber: number, reviewId: number, signal?: AbortSignal) {
    return this.#list((page) =>
      this.#client.rest.pulls.listCommentsForReview({
        ...this.#parameters(signal),
        pull_number: pullNumber,
        review_id: reviewId,
        per_page: 100,
        page,
      }),
    );
  }

  async isMaintainer(login: string, signal?: AbortSignal): Promise<boolean> {
    const { data } = await this.#client.rest.repos.getCollaboratorPermissionLevel({
      ...this.#parameters(signal),
      username: login,
    });
    const response = z
      .object({
        permission: z.string(),
      })
      .parse(data);
    return ['admin', 'maintain', 'write'].includes(response.permission);
  }
}

/** MCP supplies review context; the API supplement retains numeric IDs, complete replies and exact comparison identity. */
export async function readPullContext(options: {
  repository: Pick<Repository, 'owner' | 'name' | 'pullNumber'>;
  mcp: McpCaller;
  api: GitHubReadApi;
  botLogin: string;
  signal?: AbortSignal;
}): Promise<PullContext> {
  const { repository, mcp, api, botLogin, signal } = options;
  const call = (method: string, extra = {}) =>
    mcp.call(
      'pull_request_read',
      {
        owner: repository.owner,
        repo: repository.name,
        pullNumber: repository.pullNumber,
        method,
        ...extra,
      },
      signal,
    );
  const pull = await api.pull(repository.pullNumber, signal);
  const baseRepository = pull.base.repo;
  if (
    !baseRepository ||
    baseRepository.full_name.toLowerCase() !==
      `${repository.owner}/${repository.name}`.toLowerCase() ||
    pull.number !== repository.pullNumber
  ) {
    throw new Error('GitHub returned a different repository or PR');
  }
  const [metadata, mergeBase, diffReceipt, checks, inline, general] = await Promise.all([
    call('get'),
    api.compare(pull.base.sha, pull.head.sha, signal),
    call('get_diff'),
    call('get_check_runs', {
      page: 1,
      perPage: 100,
    }),
    api.inlineComments(repository.pullNumber, signal),
    api.conversationComments(repository.pullNumber, signal),
  ]);
  const mcpPull = z
    .object({
      head: z.object({
        sha: Sha,
      }),
      base: z.object({
        sha: Sha,
      }),
    })
    .parse(mcpJson(metadata));
  if (mcpPull.head.sha !== pull.head.sha || mcpPull.base.sha !== pull.base.sha) {
    throw new Error('PR revisions changed while collecting context');
  }
  const Checks = z.object({
    total_count: z.number().int().nonnegative(),
    check_runs: z.array(z.unknown()),
  });
  const allChecks = Checks.parse(mcpJson(checks));
  for (let page = 2; allChecks.check_runs.length < allChecks.total_count; page++) {
    if (page > 10000) {
      throw new Error('Incomplete check-run pagination');
    }
    const next = Checks.parse(
      mcpJson(
        await call('get_check_runs', {
          page,
          perPage: 100,
        }),
      ),
    );
    if (!next.check_runs.length) {
      throw new Error('Check-run collection changed while paging; retry current context');
    }
    allChecks.check_runs.push(...next.check_runs);
    allChecks.total_count = next.total_count;
  }
  const paginate = async (method: string) => {
    const all: unknown[] = [];
    for (let page = 1; page <= 10000; page++) {
      const entries = z.array(z.unknown()).parse(
        mcpJson(
          await call(method, {
            page,
            perPage: 100,
          }),
        ),
      );
      all.push(...entries);
      if (entries.length < 100) {
        return all;
      }
    }
    throw new Error(`Incomplete MCP pagination for ${method}`);
  };
  const [files, reviewReceipts] = await Promise.all([
    paginate('get_files'),
    paginate('get_reviews'),
  ]);
  const reviews = z.array(RawReview).parse(reviewReceipts);
  const allInline: unknown[] = [...inline];
  for (const review of reviews) {
    if (review.state === 'PENDING' && review.user?.login.toLowerCase() === botLogin.toLowerCase()) {
      allInline.push(...(await api.pendingComments(repository.pullNumber, review.id, signal)));
    }
  }
  const inlineById = new Map(Comments.parse(allInline).map((comment) => [comment.id, comment]));
  const inlineComments = [...inlineById.values()];
  const threads: GitHubThread[] = [];
  const cursors = new Set<string>();
  let after: string | undefined;
  do {
    const page = ThreadPage.parse(
      mcpJson(
        await call('get_review_comments', {
          perPage: 100,
          ...(after
            ? {
                after,
              }
            : {}),
        }),
      ),
    );
    for (const thread of page.review_threads) {
      const first = thread.comments[0];
      const root = inlineComments.find((comment) => comment.url === first?.html_url);
      if (!root) {
        throw new Error(`Cannot reconcile root comment for thread ${thread.id}`);
      }
      // The pinned server only returns the first 100 replies and omits numeric IDs. REST supplies all pages.
      const comments = inlineComments
        .filter((comment) => comment.id === root.id || comment.replyTo === root.id)
        .map((comment) => ({
          ...comment,
          threadId: thread.id,
        }));
      if (comments.length < thread.total_count) {
        throw new Error(`Incomplete discussion for thread ${thread.id}`);
      }
      threads.push({
        id: thread.id,
        resolved: thread.is_resolved,
        outdated: thread.is_outdated,
        comments,
        owned:
          root.author.toLowerCase() === botLogin.toLowerCase() &&
          root.body.includes('<!-- sift:finding:'),
      });
    }
    if (!page.pageInfo.hasNextPage) {
      break;
    }
    after = page.pageInfo.endCursor;
    if (!after || cursors.has(after)) {
      throw new Error('Incomplete review-thread pagination');
    }
    cursors.add(after);
  } while (true);
  const current = await api.pull(repository.pullNumber, signal);
  if (current.head.sha !== pull.head.sha || current.base.sha !== pull.base.sha) {
    throw new Error('PR revisions changed while collecting context');
  }
  return {
    repository: {
      ...repository,
      id: String(baseRepository.id),
    },
    revision: {
      head: pull.head.sha,
      base: pull.base.sha,
      mergeBase,
      baseRef: pull.base.ref,
      headRef: pull.head.ref,
    },
    title: pull.title,
    body: pull.body ?? '',
    url: pull.html_url,
    open: current.state === 'open',
    draft: current.draft,
    internal: pull.head.repo?.id === baseRepository.id,
    author: pull.user?.login ?? '[deleted]',
    botLogin,
    files: Files.parse(files),
    diff: mcpText(diffReceipt),
    checks: allChecks,
    threads,
    comments: Comments.parse(general),
    inlineComments,
    reviews: reviews.map(reviewOf),
    gaps:
      files.length === pull.changed_files
        ? []
        : [`GitHub returned ${files.length} of ${pull.changed_files} changed files`],
  };
}

export function relevantMessages(context: PullContext, mention: string): GitHubComment[] {
  const human = (comment: GitHubComment) =>
    !comment.bot && comment.author.toLowerCase() !== context.botLogin.toLowerCase();
  const threadMessages = context.threads.flatMap((thread) =>
    thread.comments.filter(
      (comment) => human(comment) && (thread.owned || mentioned(comment.body, mention)),
    ),
  );
  return [
    ...threadMessages,
    ...context.comments.filter((comment) => human(comment) && mentioned(comment.body, mention)),
  ];
}

export function messageVersion(comment: GitHubComment): string {
  return `${comment.threadId ? 'review' : 'issue'}:${comment.id}:${comment.updatedAt}:${digest(comment.body).slice(0, 16)}`;
}
