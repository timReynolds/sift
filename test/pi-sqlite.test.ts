import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { ReviewDoc } from '../src/state.ts';

test('real Pi and SQLite persist application documents and deduplicate submissions after reopen', async () => {
  // Arrange: open a real Pi harness with SQLite storage.
  const directory = await mkdtemp(join(tmpdir(), 'sift-pi-'));
  const context = BACKGROUND_CONTEXT;
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('Reviewed')]);
  const open = async () =>
    Harness.open(
      await openNodeSqliteStorage(join(directory, 'session.sqlite')),
      {
        models,
        registry: createRegistry(),
      },
      context,
    );
  let harness = await open();

  try {
    let root = await harness.root(context, {
      agent: {
        model: {
          provider: 'faux',
          modelId: 'faux-1',
        },
      },
    });

    // Act: submit the original review task.
    const first = await root.submit(
      {
        type: 'input',
        content: 'Review',
        requestId: 'github:comment:17:version1',
      },
      context,
    );
    const firstResult = await first.wait(context);

    // Assert
    assert.equal(firstResult.status, 'done');

    // Act: persist an application document and reopen the session.
    await root.commit(async (tx) => {
      (await tx.doc(ReviewDoc, root.id)).gaps.push('security pending');
    }, context);
    await harness.close(context);
    harness = await open();
    root = await harness.root(context);

    // Act: replay the same external request after restart.
    const replay = await root.submit(
      {
        type: 'input',
        content: 'Review',
        requestId: 'github:comment:17:version1',
      },
      context,
    );

    // Assert: the request reuses the original Pi task.
    assert.equal(replay.id, first.id);

    // Act: read the recovered task, document, and message history.
    const replayResult = await replay.wait(context);
    const document = await harness.snapshot(ReviewDoc, root.id, context);
    const entries = await root.entries({}, 100, undefined, context);

    // Assert: completion and documents survive without duplicate input.
    assert.equal(replayResult.status, 'done');
    assert.deepEqual(document?.gaps, ['security pending']);
    assert.equal(entries.items.filter((entry) => entry.kind === 'pi.user').length, 1);
  } finally {
    await harness.close(context);
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
