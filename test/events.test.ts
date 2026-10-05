import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mentioned, normalizeEvent } from '../src/events.ts';

const event = {
  repository: {
    id: 7,
    owner: {
      login: 'acme',
    },
    name: 'app',
  },
  sender: {
    login: 'human',
    type: 'User',
  },
};

test('events handle issue comments, human replies, bots and manual dispatch without trusting event SHAs', () => {
  // Arrange
  const options = {
    mention: 'sift',
    botLogin: 'sift[bot]',
  };

  // Act: normalize a comment on an ordinary issue.
  const issueComment = normalizeEvent(
    'issue_comment',
    {
      ...event,
      action: 'created',
      issue: {
        number: 8,
      },
      comment: {
        id: 1,
        body: '@sift review',
        user: event.sender,
      },
    },
    options,
  );

  // Assert
  assert.deepEqual(issueComment, {
    kind: 'skip',
    reason: 'Issue is not a pull request',
  });

  // Arrange a comment on a pull request with an untrusted event SHA.
  const message = {
    ...event,
    action: 'created',
    issue: {
      number: 12,
      pull_request: {
        url: 'https://example',
      },
    },
    comment: {
      id: 1,
      body: '@sift review this',
      user: event.sender,
    },
    after: 'wrong-sha',
  };

  // Act
  const review = normalizeEvent('issue_comment', message, options);

  // Assert
  assert.deepEqual(review, {
    kind: 'review',
    repository: 'acme/app',
    repositoryId: '7',
    pullNumber: 12,
    source: 'issue_comment:1',
  });

  // A comment without a mention does not trigger a review.
  const unrelatedComment = normalizeEvent(
    'issue_comment',
    {
      ...message,
      comment: {
        ...message.comment,
        body: 'thanks',
      },
    },
    options,
  );

  assert.equal(unrelatedComment.kind, 'skip');

  // Bot comments do not trigger a review either.
  const botComment = normalizeEvent(
    'issue_comment',
    {
      ...message,
      comment: {
        ...message.comment,
        user: {
          login: 'sift[bot]',
          type: 'Bot',
        },
      },
    },
    options,
  );

  assert.equal(botComment.kind, 'skip');

  // Human replies to a review thread trigger a recheck without a mention.
  const humanReply = normalizeEvent(
    'pull_request_review_comment',
    {
      ...event,
      action: 'created',
      pull_request: {
        number: 12,
      },
      comment: {
        id: 9,
        body: 'This is fixed',
        in_reply_to_id: 8,
        user: event.sender,
      },
    },
    options,
  );

  assert.equal(humanReply.kind, 'review');

  // Manual dispatch requires a valid pull request number.
  const manualReview = normalizeEvent(
    'workflow_dispatch',
    {
      ...event,
      inputs: {
        pr: '12',
      },
    },
    options,
  );

  assert.equal(manualReview.kind, 'review');

  assert.throws(() =>
    normalizeEvent(
      'workflow_dispatch',
      {
        ...event,
        inputs: {
          pr: '-2',
        },
      },
      options,
    ),
  );

  const closedPull = normalizeEvent(
    'pull_request',
    {
      ...event,
      action: 'closed',
      number: 12,
    },
    options,
  );

  assert.equal(closedPull.kind, 'skip');
});

test('mentions match the configured identity rather than longer bot names', () => {
  assert(mentioned('@sift please review', 'sift'));
  assert(mentioned('/sift: recheck', 'sift'));
  assert(!mentioned('@sift-other please review', 'sift'));
  assert(mentioned('@sift-team- please review', 'sift-team-'));
});
