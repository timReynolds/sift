import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Policy } from '../src/contracts.ts';
import { anchorValid, recordDecision, reviewPlan, verdictFor } from '../src/review.ts';
import { acceptedState, contextFixture, findingFixture, stateFixture } from './fixtures.ts';

const policy = Policy.parse({});
const profiles = ['correctness'];

test('lead decisions merge overlapping defects, preserve conditional bugs, and suppress noise with reasons', () => {
  // Arrange: report the same defect from another specialist.
  const state = acceptedState();
  state.candidates.second = findingFixture({
    id: 'security-report',
    specialists: ['security'],
    anchor: {
      ...findingFixture().anchor,
      line: 3,
    },
  });

  // Act
  recordDecision(state, {
    candidateId: 'second',
    decision: 'accepted',
    reason: 'Same expired-session dereference',
    validation: 'Confirmed same call path',
  });

  // Arrange: add a style-only candidate.
  state.candidates.nit = findingFixture({
    id: 'nit',
    issueKey: 'rename-variable',
    priority: 'P3',
  });

  // Act
  recordDecision(state, {
    candidateId: 'nit',
    decision: 'rejected',
    reason: 'Style nit with no behavioral impact',
  });

  // Arrange: add an unsupported severe candidate.
  state.candidates.speculation = findingFixture({
    id: 'speculation',
    issueKey: 'speculative-severe',
    priority: 'P0',
    confidence: 'unsupported',
  });

  // Act
  recordDecision(state, {
    candidateId: 'speculation',
    decision: 'accepted',
    reason: 'Severe hypothetical',
    validation: 'No reproduction',
  });

  // Assert
  assert.equal(Object.keys(state.findings).length, 1);
  const finding = Object.values(state.findings)[0]!.finding;
  assert.deepEqual(finding.specialists, ['correctness', 'security']);
  assert.match(finding.scenario!, /session expires/);
  assert.match(state.candidateDecisions.second!.reason, /Merged duplicate/);
  assert.match(state.candidateDecisions.nit!.reason, /Style nit/);
  assert.equal(state.candidateDecisions.speculation!.decision, 'rejected');

  const verdict = verdictFor(state, policy, profiles);
  assert.equal(verdict, 'REQUEST_CHANGES');
});

test('verdict separates severity, confidence, advisory policy and incomplete or forgotten coverage', () => {
  // Arrange
  const state = stateFixture();

  // Act
  const cleanVerdict = verdictFor(state, policy, profiles);

  // Assert
  assert.equal(cleanVerdict, 'APPROVE');

  // Arrange: a failed specialist leaves a coverage gap.
  state.selected.correctness!.status = 'failed';
  state.selected.correctness!.error = 'Timed out';

  // Act
  const incompleteVerdict = verdictFor(state, policy, profiles);

  // Assert
  assert.equal(incompleteVerdict, 'COMMENT');

  // Arrange: skip the failed specialist.
  state.selected.correctness!.selected = false;
  state.selected.correctness!.status = 'skipped';

  // Act
  const skippedVerdict = verdictFor(state, policy, profiles);

  // Assert
  assert.equal(
    skippedVerdict,
    'COMMENT',
    'Skipping a failed agent does not erase its coverage gap',
  );

  // Arrange: use advisory policy with an accepted finding.
  const accepted = acceptedState();

  // Act
  const advisoryVerdict = verdictFor(
    accepted,
    Policy.parse({
      mode: 'advisory',
    }),
    profiles,
  );

  // Assert
  assert.equal(advisoryVerdict, 'COMMENT');

  // Arrange: lower the finding's confidence.
  Object.values(accepted.findings)[0]!.finding.confidence = 'plausible';

  // Act
  const plausibleVerdict = verdictFor(accepted, policy, profiles);

  // Assert
  assert.equal(plausibleVerdict, 'COMMENT');

  // Arrange: require another investigation.
  Object.values(accepted.findings)[0]!.status = 'needs_investigation';

  // Act
  const investigationVerdict = verdictFor(accepted, policy, profiles);

  // Assert
  assert.equal(investigationVerdict, 'COMMENT');
});

test('inline validation checks exact diff side, range and revision; deferred blockers remain in summaries', () => {
  // Arrange
  const context = contextFixture();

  // Act
  const validAnchor = anchorValid(findingFixture(), context);
  const outsideDiff = anchorValid(
    findingFixture({
      anchor: {
        ...findingFixture().anchor,
        line: 80,
      },
    }),
    context,
  );
  const leftAtHead = anchorValid(
    findingFixture({
      anchor: {
        ...findingFixture().anchor,
        side: 'LEFT',
      },
    }),
    context,
  );
  const leftAtMergeBase = anchorValid(
    findingFixture({
      anchor: {
        ...findingFixture().anchor,
        side: 'LEFT',
        revision: context.revision.mergeBase,
      },
    }),
    context,
  );

  // Assert
  assert(validAnchor);
  assert(!outsideDiff);
  assert(!leftAtHead);
  assert(leftAtMergeBase);

  // Arrange: retain an accepted finding whose line is outside the diff.
  const state = acceptedState();
  Object.values(state.findings)[0]!.finding.anchor.line = 80;

  // Act
  const plan = reviewPlan(state, context, policy, profiles, 'One issue');

  // Assert
  assert.equal(plan.verdict, 'REQUEST_CHANGES');
  assert.equal(plan.findings.length, 0);
  assert.equal(plan.unanchored.length, 1);
  assert.match(plan.summary, /No valid inline anchor/);
  assert.match(plan.summary, /blob\/[a-f0-9]{40}\/src\/handler.ts#L80/);

  // Act: defer findings below the publication threshold.
  const deferred = reviewPlan(
    acceptedState(),
    context,
    Policy.parse({
      publishThrough: 'P0',
    }),
    profiles,
    'Deferred',
  );

  // Assert
  assert.equal(deferred.deferred.length, 1);
  assert.equal(deferred.verdict, 'REQUEST_CHANGES');
  assert.match(deferred.summary, /\[P1\]/);
});
