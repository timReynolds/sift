import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Policy } from '../src/contracts.ts';
import {
  findingBody,
  recordDecision,
  recoverFindings,
  reviewPlan,
  verdictFor,
} from '../src/review.ts';
import {
  answerReply,
  InvalidAnchor,
  publishReview,
  reopenFinding,
  resolveFinding,
} from '../src/publication.ts';
import { acceptedState, contextFixture, findingFixture, stateFixture } from './fixtures.ts';
import { FakePublicationPort } from './fake-publication.ts';

const policy = Policy.parse({});
const profiles = ['correctness'];

test('native review publication verifies IDs, recovers an accepted write with a lost response, and deduplicates replay', async () => {
  // Arrange
  const state = acceptedState();
  const context = contextFixture();
  const port = new FakePublicationPort();
  port.loseResponse = true;
  let saves = 0;
  const save = async () => {
    saves++;
  };
  const plan = reviewPlan(state, context, policy, profiles, 'One validated issue');

  // Act
  await publishReview(state, plan, port, save);

  // Assert
  assert.equal(plan.status, 'submitted');
  assert.equal(Object.keys(plan.posted).length, 1);
  assert(saves >= 3);

  // Act: replay publication after the lost response.
  const replay = reviewPlan(state, context, policy, profiles, 'One validated issue');
  await publishReview(state, replay, port, save);

  // Assert
  assert.deepEqual(port.writes, ['create', 'inline', 'REQUEST_CHANGES']);

  // Arrange: lose the local database.
  const lostDatabase = stateFixture();

  // Act
  recoverFindings(lostDatabase, {
    ...context,
    threads: port.data.threads,
  });

  // Assert
  assert.equal(Object.keys(lostDatabase.findings).length, 1);
  assert.equal(Object.values(lostDatabase.findings)[0]!.status, 'needs_investigation');
  const recoveredVerdict = verdictFor(lostDatabase, policy, profiles);
  assert.notEqual(recoveredVerdict, 'APPROVE');

  // Arrange: revalidate the recovered finding.
  const recovered = Object.values(lostDatabase.findings)[0]!;
  recovered.status = 'still_valid';
  recovered.checkedRevision = context.revision.head;
  const revalidated = reviewPlan(
    lostDatabase,
    context,
    policy,
    profiles,
    'Revalidated after database loss',
  );

  // Act
  await publishReview(lostDatabase, revalidated, port, async () => {});

  // Assert
  assert.equal(port.writes.filter((write) => write === 'inline').length, 1);
});

test('dry-run makes no GitHub writes; stale revisions block approval; unsupported approval is a failure', async () => {
  // Arrange
  const state = stateFixture();
  const context = contextFixture();
  const port = new FakePublicationPort();
  const plan = reviewPlan(state, context, policy, profiles, 'Clean');

  // Act
  await publishReview(state, plan, port, async () => {}, true);

  // Assert
  assert.equal(port.writes.length, 0);

  // Arrange: advance the remote revision before publication.
  port.data.head = 'd'.repeat(40);

  // Act / Assert
  await assert.rejects(
    publishReview(state, plan, port, async () => {}),
    /stale/,
  );
  assert.equal(port.writes.length, 0);
  assert.equal(plan.status, 'stale');

  // Arrange: restore the revision, but refuse native approval.
  port.data.head = context.revision.head;
  port.refuseApproval = true;
  const approval = reviewPlan(state, context, policy, profiles, 'Clean');

  // Act / Assert
  await assert.rejects(
    publishReview(state, approval, port, async () => {}),
    /APPROVE publication was not confirmed/,
  );
  assert(!port.writes.includes('COMMENT'));
});

test('partial pending review is reconciled and missing inline results cannot masquerade as successful publication', async () => {
  // Arrange
  const state = acceptedState();
  const context = contextFixture();
  const port = new FakePublicationPort();
  let plan = reviewPlan(state, context, policy, profiles, 'One issue');
  port.omitInline = true;

  // Act / Assert
  await assert.rejects(
    publishReview(state, plan, port, async () => {}),
    /was not confirmed/,
  );
  assert.equal(port.data.reviews[0]!.state, 'PENDING');
  assert(!port.writes.includes('REQUEST_CHANGES'));

  // Arrange: allow inline publication and retry the pending review.
  port.omitInline = false;
  plan = reviewPlan(state, context, policy, profiles, 'One issue');

  // Act
  await publishReview(state, plan, port, async () => {});

  // Assert
  assert.equal(port.writes.filter((write) => write === 'create').length, 1);
  assert.equal(plan.status, 'submitted');
});

test('a fixed finding resolves only its own rechecked thread and refreshes the verdict', async () => {
  // Arrange
  const state = acceptedState();
  const context = contextFixture();
  const port = new FakePublicationPort();
  await publishReview(
    state,
    reviewPlan(state, context, policy, profiles, 'Issue'),
    port,
    async () => {},
  );
  const record = Object.values(state.findings)[0]!;

  // Act / Assert: an unchecked finding cannot resolve its thread.
  await assert.rejects(
    resolveFinding(state, record.finding.id, port, async () => {}),
    /rechecked/,
  );

  // Arrange: verify the fix against the current revision.
  record.status = 'fixed';
  record.reason = 'Rechecked the caller and ran the reproduction against the new code';
  state.revision!.head = 'd'.repeat(40);
  state.coverage!.head = state.revision!.head;
  record.checkedRevision = state.revision!.head;
  port.data.head = state.revision!.head;

  // Act
  await resolveFinding(state, record.finding.id, port, async () => {});

  // Assert
  assert.equal(port.data.threads[0]?.resolved, true);
  const verdict = verdictFor(state, policy, profiles);
  assert.equal(verdict, 'APPROVE');

  // Act: refresh the published verdict after resolving the finding.
  const refreshed = reviewPlan(
    state,
    {
      ...context,
      revision: state.revision!,
    },
    policy,
    profiles,
    'Fixed and rechecked',
  );
  await publishReview(state, refreshed, port, async () => {});

  // Assert
  assert(port.writes.includes('APPROVE'));

  // Arrange: the thread is now owned by a human.
  port.data.threads[0]!.owned = false;

  // Act / Assert
  await assert.rejects(
    resolveFinding(state, record.finding.id, port, async () => {}),
    /Only Sift-owned/,
  );
});

test('a human response is answered once even when local state loses its answer receipt', async () => {
  // Arrange
  const state = acceptedState();
  const context = contextFixture();
  const port = new FakePublicationPort();
  await publishReview(
    state,
    reviewPlan(state, context, policy, profiles, 'Issue'),
    port,
    async () => {},
  );
  state.importedMessages['reply:18:v1'] = {
    requestId: 'github:reply:18:v1',
    answered: false,
  };
  const rootId = port.data.comments[0]!.id;

  // Act
  await answerReply(
    state,
    'reply:18:v1',
    rootId,
    'Rechecked; the guard now covers this case.',
    port,
    async () => {},
  );

  // Arrange: lose the local answer receipt.
  state.importedMessages['reply:18:v1']!.answered = false;

  // Act
  await answerReply(
    state,
    'reply:18:v1',
    rootId,
    'Rechecked; the guard now covers this case.',
    port,
    async () => {},
  );

  // Assert
  assert.equal(port.writes.filter((write) => write === 'reply').length, 1);
  assert(state.importedMessages['reply:18:v1']!.answered);
  const body = findingBody(Object.values(state.findings)[0]!);
  assert.match(body, /sift:data:/);
});

test('a revalidated recurrence reopens its own resolved thread and conversation answers deduplicate', async () => {
  // Arrange
  const state = acceptedState();
  const context = contextFixture();
  const port = new FakePublicationPort();
  await publishReview(
    state,
    reviewPlan(state, context, policy, profiles, 'Issue'),
    port,
    async () => {},
  );
  const record = Object.values(state.findings)[0]!;
  port.data.threads[0]!.resolved = true;

  // Act
  await reopenFinding(state, record.finding.id, port, async () => {});

  // Assert
  assert.equal(port.data.threads[0]!.resolved, false);

  // Arrange: import a human conversation request.
  port.data.comments.push({
    id: 700,
    body: '@sift please explain',
    author: 'human',
    bot: false,
    updatedAt: 'now',
    url: 'https://example/human',
  });
  state.importedMessages.general = {
    requestId: 'github:general',
    answered: false,
  };

  // Act
  await answerReply(
    state,
    'general',
    700,
    'The reproduction demonstrates the conditional failure.',
    port,
    async () => {},
  );

  // Arrange: lose the local answer receipt.
  state.importedMessages.general!.answered = false;

  // Act
  await answerReply(
    state,
    'general',
    700,
    'The reproduction demonstrates the conditional failure.',
    port,
    async () => {},
  );

  // Assert
  assert.equal(port.writes.filter((write) => write === 'conversation_reply').length, 1);
});

test('server-rejected inline anchors remain visible in a recoverable summary after complete local state loss', async () => {
  // Arrange
  const state = stateFixture();
  const context = contextFixture();
  const port = new FakePublicationPort();
  state.candidates.issue = findingFixture();
  recordDecision(state, {
    candidateId: 'issue',
    decision: 'accepted',
    reason: 'Confirmed',
    validation: 'Reproduced',
  });
  port.addInline = async () => {
    throw new InvalidAnchor('Line not in diff');
  };
  const plan = reviewPlan(state, context, Policy.parse({}), ['correctness'], 'One issue');

  // Act
  await publishReview(state, plan, port, async () => {});

  // Assert
  assert.equal(plan.status, 'submitted');
  assert.equal(plan.unanchored.length, 1);
  assert.equal(plan.findings.length, 0);
  assert.match(port.data.reviews[0]!.body, /GitHub rejected this inline anchor/);

  // Arrange: simulate complete local state loss.
  const recovered = stateFixture();

  // Act
  recoverFindings(recovered, {
    ...context,
    reviews: port.data.reviews,
  });

  // Assert
  assert.equal(Object.keys(recovered.findings).length, 1);
  assert.equal(Object.values(recovered.findings)[0]!.status, 'needs_investigation');
});

test('a superseded pending batch is replaced after importing its findings without leaving a duplicate thread', async () => {
  // Arrange
  const state = stateFixture();
  const context = contextFixture();
  const port = new FakePublicationPort();
  state.candidates.issue = findingFixture();
  recordDecision(state, {
    candidateId: 'issue',
    decision: 'accepted',
    reason: 'Confirmed',
    validation: 'Reproduced',
  });
  const originalSubmit = port.submit.bind(port);
  port.submit = async () => {
    throw new Error('Lost session before submission');
  };

  // Act / Assert: interrupt the original pending batch.
  await assert.rejects(
    publishReview(
      state,
      reviewPlan(state, context, Policy.parse({}), ['correctness'], 'Original intent'),
      port,
      async () => {},
    ),
  );
  assert.equal(port.data.threads.length, 1);

  // Arrange: import the pending batch into a new local state.
  const recovered = stateFixture();

  // Act
  recoverFindings(recovered, {
    ...context,
    reviews: port.data.reviews,
    threads: port.data.threads,
  });

  // Arrange: revalidate the recovered finding before retrying publication.
  const finding = Object.values(recovered.findings)[0]!;
  finding.status = 'still_valid';
  finding.checkedRevision = context.revision.head;
  port.submit = originalSubmit;

  // Act
  await publishReview(
    recovered,
    reviewPlan(recovered, context, Policy.parse({}), ['correctness'], 'Rechecked after recovery'),
    port,
    async () => {},
  );

  // Assert
  assert.equal(port.data.threads.length, 1);
  assert.equal(port.data.reviews.length, 1);
  assert.equal(port.data.reviews[0]!.state, 'CHANGES_REQUESTED');
  assert(port.writes.includes('delete_pending'));
});

test('a newer published recurrence overrides an older snapshot that thought the finding was fixed', async () => {
  // Arrange
  const state = stateFixture();
  const context = contextFixture();
  const port = new FakePublicationPort();
  state.candidates.issue = findingFixture();
  recordDecision(state, {
    candidateId: 'issue',
    decision: 'accepted',
    reason: 'Confirmed',
    validation: 'Reproduced',
  });
  const oldSnapshot = structuredClone(state);
  const oldFinding = Object.values(oldSnapshot.findings)[0]!;
  oldFinding.status = 'fixed';

  // Act: publish the recurrence and import it into the older snapshot.
  await publishReview(
    state,
    reviewPlan(state, context, Policy.parse({}), ['correctness'], 'The bug recurred'),
    port,
    async () => {},
  );
  recoverFindings(oldSnapshot, {
    ...context,
    reviews: port.data.reviews,
    threads: port.data.threads,
  });

  // Assert
  assert.equal(Object.values(oldSnapshot.findings)[0]!.status, 'needs_investigation');
});
