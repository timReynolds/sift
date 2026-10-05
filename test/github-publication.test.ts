import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubPublication } from '../src/github-publication.ts';
import { GitHubReadApi } from '../src/github.ts';
import type { McpCaller } from '../src/mcp.ts';
import { contextFixture, findingFixture } from './fixtures.ts';

test('GitHub publication uses pinned MCP method names, separates comment/thread IDs, and preserves native verdicts', async () => {
  // Arrange
  const calls: Array<{
    name: string;
    args: Record<string, unknown>;
  }> = [];
  const mcp: McpCaller = {
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({
        name,
        args,
      });
      return {
        content: [
          {
            type: 'text',
            text: '{}',
          },
        ],
      };
    },
  };
  const repository = contextFixture().repository;
  const port = new GitHubPublication({
    repository,
    reader: mcp,
    writer: mcp,
    api: new GitHubReadApi(repository, 'unused'),
    botLogin: 'sift[bot]',
    ownedThreads: new Set(['thread-1']),
  });

  // Act
  await port.createPending('intent', findingFixture().anchor.revision);
  await port.addInline('finding', {
    ...findingFixture().anchor,
    startLine: 1,
  });
  await port.submit('APPROVE', 'verdict');
  await port.resolve('thread-1');
  await port.reply(42, 'reply');
  await port.conversationReply('answer');
  await port.deletePending();

  // Assert
  assert.deepEqual(calls.map((call) => call.args.method).filter(Boolean), [
    'create',
    'submit_pending',
    'resolve_thread',
    'delete_pending',
  ]);
  assert.equal(calls[0]!.args.commitID, findingFixture().anchor.revision);
  assert.equal(calls[1]!.args.subjectType, 'LINE');
  assert.equal(calls[1]!.args.startSide, 'RIGHT');
  assert.equal(calls[2]!.args.event, 'APPROVE');
  assert.equal(calls[3]!.args.threadId, 'thread-1');
  assert.equal(calls[4]!.args.commentId, 42);
  assert.equal(calls[5]!.args.issue_number, repository.pullNumber);

  // Act / Assert: reject attempts to resolve a human-owned thread.
  await assert.rejects(port.resolve('human-thread'), /unowned/);
});
