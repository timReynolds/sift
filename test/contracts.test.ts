import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Anchor, Finding, RepoPath, stateKey } from '../src/contracts.ts';

test('repository identity keeps state across pushes and repository renames', () => {
  // Arrange
  const originalRepository = { id: '123', owner: 'old', name: 'old', pullNumber: 8 };
  const renamedRepository = { id: '123', owner: 'new', name: 'new', pullNumber: 8 };
  const invalidRepository = { id: '../bad', owner: 'a', name: 'b', pullNumber: 8 };

  // Act
  const originalKey = stateKey(originalRepository);
  const renamedKey = stateKey(renamedRepository);

  // Assert
  assert.equal(originalKey, renamedKey);

  // Act and Assert: an unsafe repository ID is rejected.
  assert.throws(() => stateKey(invalidRepository));
});

test('finding anchors reject unsafe paths, invalid ranges and partial revisions', () => {
  // Arrange
  const unsafePaths = ['/tmp/a', '../a', 'a/../b', 'a\\b', 'a//b', './a'];
  const partialRevision = { path: 'src/a', revision: 'abc', side: 'RIGHT', line: 1 };
  const reversedRange = {
    path: 'src/a',
    revision: 'a'.repeat(40),
    side: 'RIGHT',
    startLine: 4,
    line: 2,
  };

  // Act and Assert: traversal and malformed paths are rejected.
  for (const path of unsafePaths) {
    assert.throws(() => RepoPath.parse(path));
  }

  // Act
  const safePath = RepoPath.parse('src/file.ts');

  // Assert
  assert.equal(safePath, 'src/file.ts');

  // Act and Assert: an anchor needs a complete revision and valid range.
  assert.throws(() => Anchor.parse(partialRevision));
  assert.throws(() => Anchor.parse(reversedRange));
});

test('priority and confidence are independent and complete evidence is mandatory', () => {
  // Arrange
  const finding = {
    id: 'bug',
    issueKey: 'conditional-null',
    specialists: ['correctness'],
    category: 'correctness',
    title: 'Null input crashes',
    explanation: 'A new caller passes null',
    anchor: {
      path: 'src/a.ts',
      revision: 'a'.repeat(40),
      side: 'RIGHT',
      line: 2,
    },
    evidence: [{ kind: 'code', detail: 'Caller passes null on missing session' }],
    impact: 'Request fails',
    scenario: 'When session expires',
    priority: 'P1',
    confidence: 'plausible',
    introducedOrExposed: true,
  };
  const missingEvidence = { ...finding, evidence: [] };
  const incompleteSuggestion = {
    ...finding,
    suggestion: { replacement: '...', complete: false },
  };

  // Act
  const parsed = Finding.parse(finding);

  // Assert
  assert.equal(parsed.confidence, 'plausible');

  // Act and Assert: evidence and complete suggestions are required.
  assert.throws(() => Finding.parse(missingEvidence));
  assert.throws(() => Finding.parse(incompleteSuggestion));
});
