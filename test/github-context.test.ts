import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GitHubReadApi,
  mcpText,
  messageVersion,
  readPullContext,
  relevantMessages,
} from '../src/github.ts';
import type { McpCaller } from '../src/mcp.ts';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const mergeBase = 'c'.repeat(40);
const repository = {
  owner: 'acme',
  name: 'app',
  pullNumber: 12,
};
const botLogin = 'sift[bot]';
const rawPull = {
  number: 12,
  title: 'Fix request flow',
  body: 'Part of stacked PR #9',
  html_url: 'https://github.com/acme/app/pull/12',
  state: 'open',
  draft: false,
  user: {
    login: 'author',
  },
  changed_files: 1,
  head: {
    sha: head,
    ref: 'feature',
    repo: {
      id: 7,
      full_name: 'acme/app',
    },
  },
  base: {
    sha: base,
    ref: 'stack-base',
    repo: {
      id: 7,
      full_name: 'acme/app',
    },
  },
};

const comment = (id: number, root = false) => ({
  id,
  body: root ? '<!-- sift:finding:old --> Prior blocker' : 'I fixed this; please recheck',
  user: {
    login: root ? botLogin : 'human',
    type: root ? 'Bot' : 'User',
  },
  updated_at: '2026-10-04T00:00:00Z',
  html_url: `https://github.com/acme/app/pull/12#discussion_r${id}`,
  ...(root
    ? {}
    : {
        in_reply_to_id: 1,
      }),
  pull_request_review_id: 3,
});

function boundaries(
  options: { moveHead?: boolean; count?: number; nullableMetadata?: boolean } = {},
) {
  const requests: string[] = [];
  let pullReads = 0;

  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    const path = url.pathname.replace('/repos/acme/app', '');
    let value: unknown;
    if (path === '/pulls/12') {
      pullReads++;
      value =
        options.moveHead && pullReads > 1
          ? {
              ...rawPull,
              head: {
                ...rawPull.head,
                sha: 'd'.repeat(40),
              },
            }
          : {
              ...rawPull,
              changed_files: options.count ?? 1,
              ...(options.nullableMetadata ? { body: null, draft: undefined, user: null } : {}),
            };
    } else if (path === `/compare/${base}...${head}`) {
      value = {
        merge_base_commit: {
          sha: mergeBase,
        },
      };
    } else if (path === '/pulls/12/comments') {
      const page = Number(url.searchParams.get('page'));
      value = Array.from(
        {
          length: 101,
        },
        (_, index) => ({
          ...comment(index + 1, index === 0),
          ...(options.nullableMetadata && index === 1
            ? { user: null, pull_request_review_id: null }
            : {}),
        }),
      ).slice((page - 1) * 100, page * 100);
    } else if (path === '/issues/12/comments') {
      value = [
        {
          ...comment(150),
          body: options.nullableMetadata ? undefined : '@sift check the boundary case',
          user: options.nullableMetadata ? null : comment(150).user,
          in_reply_to_id: undefined,
        },
        {
          ...comment(151),
          body: 'Unrelated planning discussion',
        },
      ];
    } else {
      throw new Error(`Unexpected API request ${path}`);
    }

    return Response.json(value);
  }) as typeof fetch;

  const mcp: McpCaller = {
    call: async (name, args) => {
      assert.equal(name, 'pull_request_read');
      let value: unknown;
      switch (args.method) {
        case 'get':
          value = {
            head: {
              sha: head,
            },
            base: {
              sha: base,
            },
          };
          break;
        case 'get_diff':
          return {
            content: [
              {
                type: 'text',
                text: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
              },
            ],
          };
        case 'get_files':
          value = [
            {
              filename: 'src/a.ts',
              status: 'modified',
              patch: '@@ -1 +1 @@\n-old\n+new',
            },
          ];
          break;
        case 'get_reviews':
          value = [
            {
              id: 3,
              state: 'CHANGES_REQUESTED',
              body: options.nullableMetadata ? null : 'Previous review',
              user: options.nullableMetadata ? null : { login: botLogin },
              commit_id: options.nullableMetadata ? null : base,
              html_url: 'https://github.com/acme/app/pull/12#pullrequestreview-3',
            },
          ];
          break;
        case 'get_review_comments':
          value = {
            review_threads: [
              {
                id: 'thread-1',
                is_resolved: false,
                is_outdated: true,
                total_count: 101,
                comments: Array.from(
                  {
                    length: 100,
                  },
                  (_, index) => ({
                    html_url: comment(index + 1).html_url,
                  }),
                ),
              },
            ],
            totalCount: 1,
            pageInfo: {
              hasNextPage: false,
              endCursor: 'end',
            },
          };
          break;
        case 'get_check_runs':
          value = {
            total_count: 0,
            check_runs: [],
          };
          break;
        default:
          throw new Error(`Unexpected MCP method ${String(args.method)}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(value),
          },
        ],
      };
    },
  };

  return {
    api: new GitHubReadApi(repository, 'fake-token', fetcher),
    mcp,
    requests,
  };
}

test('MCP text extraction validates SDK results and ignores resource content', () => {
  // Arrange
  const receipt = {
    content: [
      { type: 'text', text: 'First message' },
      {
        type: 'resource',
        resource: { uri: 'sift://context', text: 'Supplemental context' },
      },
      { type: 'text', text: 'Second message' },
    ],
  };
  const malformedReceipt = { content: [{ type: 'text' }] };

  // Act
  const text = mcpText(receipt);
  const emptyText = mcpText({});

  // Assert
  assert.equal(text, 'First message\nSecond message');
  assert.equal(emptyText, '');

  // Act / Assert: failed and malformed tool results cannot become review context.
  assert.throws(() => mcpText({ isError: true }), /GitHub MCP returned an error result/);
  assert.throws(() => mcpText(malformedReceipt));
});

test('stacked PR context uses its actual base and preserves all replies beyond the MCP cap', async () => {
  // Arrange
  const fixture = boundaries();

  // Act
  const context = await readPullContext({
    ...fixture,
    repository,
    botLogin,
  });

  // Assert
  assert.deepEqual(context.revision, {
    head,
    base,
    mergeBase,
    headRef: 'feature',
    baseRef: 'stack-base',
  });
  assert(fixture.requests.some((path) => path.includes(`/compare/${base}...${head}`)));
  assert(!fixture.requests.some((path) => path.includes('main')));
  assert.equal(context.threads[0]?.comments.length, 101);
  assert.equal(context.threads[0]?.owned, true);
  assert.equal(context.threads[0]?.resolved, false, 'Outdated is not resolved');
  assert.equal(context.internal, true);

  // Act: select messages that need a response.
  const messages = relevantMessages(context, 'sift');

  // Assert
  assert.equal(messages.length, 101);
  assert(!messages.some((message) => message.author === botLogin || message.id === 151));

  assert.equal(messageVersion(messages[0]!), messageVersion(structuredClone(messages[0]!)));
  assert.notEqual(
    messageVersion(messages[0]!),
    messageVersion({
      ...messages[0]!,
      body: 'Edited reply',
    }),
  );
});

test('context fails when head changes during collection and records truncated file coverage', async () => {
  // Arrange a pull request that changes while its context is collected.
  const moving = boundaries({
    moveHead: true,
  });

  // Act / Assert
  await assert.rejects(
    readPullContext({
      ...moving,
      repository,
      botLogin,
    }),
    /revisions changed/,
  );

  // Arrange a pull request whose changed-file list is truncated.
  const truncated = boundaries({
    count: 2,
  });

  // Act
  const context = await readPullContext({
    ...truncated,
    repository,
    botLogin,
  });

  // Assert
  assert.deepEqual(context.gaps, ['GitHub returned 1 of 2 changed files']);
});

test('context normalizes deleted users and optional GitHub metadata', async () => {
  // Arrange
  const fixture = boundaries({ nullableMetadata: true });

  // Act
  const context = await readPullContext({
    ...fixture,
    repository,
    botLogin,
  });
  const deletedReply = context.inlineComments?.find((reply) => reply.id === 2);

  // Assert
  assert.equal(context.author, '[deleted]');
  assert.equal(context.body, '');
  assert.equal(context.draft, false);

  assert.equal(deletedReply?.author, '[deleted]');
  assert.equal(deletedReply?.bot, false);
  assert(deletedReply && !('reviewId' in deletedReply));
  assert.equal(context.comments[0]?.author, '[deleted]');
  assert.equal(context.comments[0]?.body, '');

  assert.equal(context.reviews[0]?.author, '[deleted]');
  assert.equal(context.reviews[0]?.body, '');
  assert.equal(context.reviews[0]?.commit, '');
});

test('GitHub reader uses scoped SDK requests and recovers after two server failures', async () => {
  // Arrange
  const requests: Request[] = [];
  const fetcher = (async (input, init) => {
    requests.push(new Request(input, init));

    if (requests.length < 3) {
      return Response.json({ message: 'Service unavailable' }, { status: 503 });
    }

    return Response.json([comment(2)]);
  }) as typeof fetch;
  const api = new GitHubReadApi(repository, 'fake-token', fetcher);

  // Act
  const comments = await api.inlineComments(12);
  const request = requests[0]!;
  const url = new URL(request.url);

  // Assert
  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.id, 2);
  assert.equal(requests.length, 3);

  assert.equal(url.origin, 'https://api.github.com');
  assert.equal(url.pathname, '/repos/acme/app/pulls/12/comments');
  assert.equal(url.searchParams.get('per_page'), '100');
  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(request.method, 'GET');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers.get('authorization'), 'token fake-token');
  assert.equal(request.headers.get('x-github-api-version'), '2022-11-28');
});

test('GitHub reader rejects incomplete 409 responses without retrying', async () => {
  // Arrange
  let requests = 0;
  const fetcher = (async () => {
    requests++;
    return Response.json({ message: 'Git Repository is empty' }, { status: 409 });
  }) as typeof fetch;
  const api = new GitHubReadApi(repository, 'fake-token', fetcher);

  // Act / Assert
  await assert.rejects(api.inlineComments(12), { status: 409 });
  assert.equal(requests, 1);
});

test('GitHub permission failures never grant maintainer access or retry', async () => {
  for (const status of [403, 404]) {
    // Arrange
    let requests = 0;
    const fetcher = (async () => {
      requests++;
      return Response.json({ message: 'Permission unavailable' }, { status });
    }) as typeof fetch;
    const api = new GitHubReadApi(repository, 'fake-token', fetcher);

    // Act / Assert
    await assert.rejects(api.isMaintainer('human'), { status });
    assert.equal(requests, 1);
  }
});

test('GitHub reader propagates cancellation without retrying the request', async () => {
  // Arrange
  const controller = new AbortController();
  const requests: Request[] = [];
  const fetcher = (async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);

    controller.abort(new Error('Cancelled GitHub read'));
    request.signal.throwIfAborted();

    return Response.json([]);
  }) as typeof fetch;
  const api = new GitHubReadApi(repository, 'fake-token', fetcher);

  // Act / Assert
  await assert.rejects(api.inlineComments(12, controller.signal), /Cancelled GitHub read/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.signal.aborted, true);
});
