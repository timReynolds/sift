import { recordDecision } from '../src/review.ts';
import { emptyReviewState, type Finding, type ReviewState } from '../src/contracts.ts';
import type { PullContext } from '../src/github.ts';

export const contextFixture = (): PullContext => ({
  repository: {
    id: '7',
    owner: 'acme',
    name: 'app',
    pullNumber: 12,
  },
  revision: {
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    mergeBase: 'c'.repeat(40),
    baseRef: 'release',
    headRef: 'feature',
  },
  title: 'Change handler',
  body: 'Handle requests',
  url: 'https://github.com/acme/app/pull/12',
  open: true,
  draft: false,
  internal: true,
  author: 'human',
  botLogin: 'sift[bot]',
  files: [
    {
      filename: 'src/handler.ts',
      status: 'modified',
      patch:
        '@@ -1,3 +1,3 @@\n function handler(input) {\n-  return input?.name;\n+  return input.name;\n }',
    },
  ],
  diff: '',
  reviews: [],
  threads: [],
  comments: [],
  checks: [],
  gaps: [],
});

export const findingFixture = (changes: Partial<Finding> = {}): Finding => ({
  id: 'null-input',
  issueKey: 'handler-null-input',
  specialists: ['correctness'],
  category: 'correctness',
  title: 'Handle missing sessions',
  explanation: 'The new handler dereferences null when the session expires.',
  anchor: {
    path: 'src/handler.ts',
    revision: 'a'.repeat(40),
    side: 'RIGHT',
    line: 2,
  },
  evidence: [
    {
      kind: 'reproduction',
      detail: 'handler(null) throws',
      command: 'node repro.mjs',
      result: 'TypeError',
    },
  ],
  impact: 'Expired sessions fail requests',
  scenario: 'When a session expires between requests',
  priority: 'P1',
  confidence: 'verified',
  introducedOrExposed: true,
  ...changes,
});

export function stateFixture(): ReviewState {
  const state = emptyReviewState();
  state.identity = contextFixture().repository;
  state.revision = contextFixture().revision;
  state.scope = {
    kind: 'full',
    reason: 'Initial review',
  };
  state.selected.correctness = {
    name: 'correctness',
    selected: true,
    reason: 'Application logic',
    status: 'completed',
  };
  state.coverage = {
    complete: true,
    head: state.revision.head,
    summary: 'Reviewed the diff, callers, and focused tests',
  };
  return state;
}

export function acceptedState() {
  const state = stateFixture();
  state.candidates.first = findingFixture();

  recordDecision(state, {
    candidateId: 'first',
    decision: 'accepted',
    reason: 'Concrete conditional regression',
    validation: 'Reproduction and changed caller both confirmed',
  });

  return state;
}
