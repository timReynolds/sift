import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage as answer,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { Type, type AssistantMessage } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Config } from '../src/config.ts';
import { digest } from '../src/contracts.ts';
import { runReview } from '../src/engine.ts';
import { LocalSnapshotStore, PersistedRunFailure } from '../src/persistence.ts';
import { parseProfile } from '../src/profiles.ts';
import { Workspaces } from '../src/workspaces.ts';
import { contextFixture, findingFixture } from './fixtures.ts';
import { FakePublicationPort } from './fake-publication.ts';

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  answer(fauxToolCall(name, args), {
    stopReason: 'toolUse',
  });

const plan = () =>
  call('plan_review', {
    scope: 'full',
    reason: 'Review current revision and outstanding feedback',
    agents: [
      {
        name: 'correctness',
        selected: true,
        reason: 'Application change',
      },
      {
        name: 'terraform',
        selected: false,
        reason: 'No infrastructure changes or questions',
      },
    ],
  });

const investigation = () =>
  call('investigate', {
    assignments: [
      {
        name: 'correctness',
        task: 'Read handler, reproduce the conditional defect and recheck prior feedback',
      },
    ],
  });

const complete = () =>
  call('complete_review', {
    complete: true,
    summary: 'Inspected the handler, callers and conditional input behavior.',
  });

async function engineFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sift-engine-'));
  const baseline = join(directory, 'baseline');
  await mkdir(join(baseline, 'src'), {
    recursive: true,
  });
  await writeFile(
    join(baseline, 'src/handler.ts'),
    'function handler(input) {\n  return input.name;\n}\n',
  );

  const config = Config.parse({
    version: 1,
    model: 'faux/lead',
    profiles: ['correctness', 'terraform'],
    agents: {
      correctness: {
        model: 'faux/checker',
      },
    },
  });
  const profiles = new Map(
    ['lead', ...config.profiles].map((name) => [
      name,
      parseProfile(
        `---\nname: ${name}\ndescription: ${name}\n---\nInvestigate carefully.`,
        `${name}.agent.md`,
        config,
      ),
    ]),
  );

  const provider = fauxProvider({
    models: [
      {
        id: 'lead',
      },
      {
        id: 'checker',
      },
    ],
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const scripts = new Map<string, AssistantMessage[]>();
  const prompts: string[] = [];
  provider.setResponses(
    Array.from(
      {
        length: 100,
      },
      () => (_context, _options, _state, model) => {
        if (model.id === 'lead') {
          prompts.push(JSON.stringify(_context));
        }

        const response = scripts.get(model.id)?.shift();
        if (!response) {
          throw new Error(`Missing response for ${model.id}`);
        }

        return response;
      },
    ),
  );

  const store = new LocalSnapshotStore(join(directory, 'store'));
  const publication = new FakePublicationPort();
  const context = contextFixture();
  const options = {
    context,
    config,
    profiles,
    models,
    store,
    publication,
    baseline,
    directory: join(directory, 'runs'),
    trustedRevision: 'd'.repeat(40),
    isMaintainer: async () => true,
    workspaces: (value: ConstructorParameters<typeof Workspaces>[0]) =>
      new Workspaces({
        ...value,
        sandbox: async ({ workspace }) =>
          new NodeExecutionEnv({
            cwd: workspace,
          }),
      }),
  };

  return {
    directory,
    scripts,
    options,
    prompts,
  };
}

test('real Pi/SQLite engine publishes a finding, restores state on a changed PR, answers a reply once, resolves and approves', async () => {
  const fixture = await engineFixture();

  try {
    // Arrange: script a specialist finding and the lead's acceptance.
    const finding = findingFixture();
    fixture.scripts.set('lead', [
      plan(),
      investigation(),
      call('decide_finding', {
        candidateId: `correctness:${finding.id}:${fixture.options.context.revision.head}`,
        decision: 'accepted',
        reason: 'Concrete changed null-input path',
        validation: 'Checked the failing reproduction and caller',
      }),
      complete(),
      answer('Finished'),
    ]);
    fixture.scripts.set('checker', [
      call('read', {
        path: 'src/handler.ts',
      }),
      call('write', {
        path: 'repro.txt',
        content: 'handler(null) throws',
      }),
      call('submit_findings', {
        findings: [finding],
        checkedPaths: ['src/handler.ts'],
        tests: [],
        complete: true,
        summary: 'Conditional defect reproduced',
      }),
      answer('Reported'),
    ]);

    // Act: review the original PR revision.
    const first = await runReview(fixture.options);

    // Assert: publish the accepted finding and preserve the baseline.
    assert.equal(first.status, 'reviewed');
    if (first.status !== 'reviewed') {
      return;
    }

    assert.equal(first.verdict, 'REQUEST_CHANGES', JSON.stringify(first));
    assert.equal(first.persistence, 'saved');
    assert.equal(first.findings.P1, 1);
    assert.match(first.skipped[0]!.reason, /No infrastructure/);
    assert.deepEqual(fixture.options.publication.writes, ['create', 'inline', 'REQUEST_CHANGES']);

    const baseline = await readFile(join(fixture.options.baseline, 'src/handler.ts'), 'utf8');

    assert.equal(baseline, 'function handler(input) {\n  return input.name;\n}\n');

    // Arrange: push the fix and add a maintainer's request to recheck it.
    const head = 'e'.repeat(40);
    const id = `f-${digest(finding.issueKey).slice(0, 24)}`;
    const thread = fixture.options.publication.data.threads[0]!;
    const human = {
      id: 900,
      body: 'Fixed the null session path. Please recheck.',
      author: 'maintainer',
      bot: false,
      updatedAt: '2026-10-04T02:00:00Z',
      url: 'https://example/human',
      replyTo: thread.comments[0]!.id,
      threadId: thread.id,
    };
    thread.comments.push(human);
    fixture.options.publication.data.comments.push(human);
    fixture.options.context.threads = structuredClone(fixture.options.publication.data.threads);
    fixture.options.context.revision.head = head;
    fixture.options.publication.data.head = head;
    await writeFile(
      join(fixture.options.baseline, 'src/handler.ts'),
      'function handler(input) {\n  return input?.name;\n}\n',
    );
    const key = `review:900:${human.updatedAt}:${digest(human.body).slice(0, 16)}`;
    fixture.scripts.set('lead', [
      plan(),
      investigation(),
      call('recheck_finding', {
        findingId: id,
        status: 'fixed',
        reason: 'The optional access handles missing sessions',
        code: {
          path: 'src/handler.ts',
          revision: head,
          quote: 'return input?.name;',
        },
      }),
      call('respond_to_human', {
        sourceKey: key,
        reason: 'Rechecked the fix',
        body: 'Confirmed the null session is handled; resolving this finding.',
      }),
      complete(),
      answer('Finished'),
    ]);
    fixture.scripts.set('checker', [
      call('read', {
        path: 'src/handler.ts',
      }),
      call('submit_findings', {
        findings: [],
        checkedPaths: ['src/handler.ts'],
        tests: [],
        complete: true,
        summary: 'Fixed null input verified',
      }),
      answer('Clean'),
    ]);

    // Act: restore the persisted review and check the new revision.
    const second = await runReview(fixture.options);

    // Assert: approve the fix, resolve the thread, and reply once.
    assert.equal(second.status, 'reviewed');
    if (second.status !== 'reviewed') {
      return;
    }

    assert.equal(second.verdict, 'APPROVE');
    assert.deepEqual(second.gaps, []);
    assert.equal(fixture.options.publication.data.threads[0]!.resolved, true);
    assert.equal(fixture.options.publication.writes.filter((write) => write === 'reply').length, 1);

    // Arrange: replay the same wake-up after the completed review.
    fixture.options.context.threads = structuredClone(fixture.options.publication.data.threads);
    const before = [...fixture.options.publication.writes];
    fixture.scripts.set('lead', [
      plan(),
      complete(),
      answer('No changes since the completed review'),
    ]);

    // Act: replay in dry-run mode.
    const dry = await runReview({
      ...fixture.options,
      dryRun: true,
    });

    // Assert: no duplicate reply or GitHub mutation.
    assert.equal(dry.status, 'reviewed');
    assert.deepEqual(fixture.options.publication.writes, before);
  } finally {
    await rm(fixture.directory, {
      recursive: true,
      force: true,
    });
  }
});

test('engine records failed specialist coverage and submits COMMENT rather than a false approval', async () => {
  const fixture = await engineFixture();

  try {
    // Arrange: let the specialist finish without completing its coverage.
    fixture.scripts.set('lead', [
      plan(),
      investigation(),
      complete(),
      answer('Finished with a gap'),
    ]);
    fixture.scripts.set('checker', [answer('Could not finish')]);

    // Act
    const result = await runReview(fixture.options);

    // Assert: incomplete coverage produces a comment and a recorded gap.
    assert.equal(result.status, 'reviewed');
    if (result.status !== 'reviewed') {
      return;
    }

    assert.equal(result.verdict, 'COMMENT');
    assert.equal(result.failed.length, 1);
    assert(result.gaps.length > 0);
    assert.deepEqual(fixture.options.publication.writes, ['create', 'COMMENT']);

    // Arrange: push a new revision and attempt to skip the failed specialist.
    fixture.options.context.revision.head = 'e'.repeat(40);
    fixture.options.publication.data.head = 'e'.repeat(40);
    fixture.scripts.set('lead', [
      call('plan_review', {
        scope: 'targeted',
        reason: 'A later push',
        agents: [
          {
            name: 'correctness',
            selected: false,
            reason: 'Attempted skip',
          },
          {
            name: 'terraform',
            selected: false,
            reason: 'No infrastructure change',
          },
        ],
      }),
      complete(),
      answer('Finished'),
    ]);

    // Act
    const retry = await runReview(fixture.options);

    // Assert: skipping the specialist does not erase its failed coverage.
    assert.equal(retry.status, 'reviewed');
    if (retry.status !== 'reviewed') {
      return;
    }

    assert.equal(
      retry.verdict,
      'COMMENT',
      'A new revision and skip do not erase prior failed coverage',
    );
    assert.equal(retry.failed.length, 1);
  } finally {
    await rm(fixture.directory, {
      recursive: true,
      force: true,
    });
  }
});

test('missing required workspace artifacts deliberately restart investigations before Pi work resumes', async () => {
  const fixture = await engineFixture();

  try {
    // Arrange: complete an investigation that creates a required artifact.
    fixture.scripts.set('lead', [plan(), investigation(), complete(), answer('Finished')]);
    fixture.scripts.set('checker', [
      call('write', {
        path: 'repro.txt',
        content: 'important reproduction',
      }),
      call('submit_findings', {
        findings: [],
        checkedPaths: ['src/handler.ts'],
        tests: [],
        complete: true,
        summary: 'Investigated',
      }),
      answer('Done'),
    ]);

    // Act: persist the review, then remove its required artifact.
    await runReview({
      ...fixture.options,
      dryRun: true,
    });

    await rm(join(fixture.directory, 'store/repositories/7/pulls/12/artifacts'), {
      recursive: true,
    });

    // Arrange: script a fresh investigation for the resumed review.
    fixture.prompts.length = 0;
    fixture.scripts.set('lead', [
      plan(),
      investigation(),
      complete(),
      answer('Restarted and complete'),
    ]);
    fixture.scripts.set('checker', [
      call('submit_findings', {
        findings: [],
        checkedPaths: ['src/handler.ts'],
        tests: [],
        complete: true,
        summary: 'Fresh investigation completed',
      }),
      answer('Done'),
    ]);

    // Act: resume with the artifact missing.
    const result = await runReview({
      ...fixture.options,
      dryRun: true,
    });

    // Assert: the lead is told to restart, and dry-run makes no publication.
    assert.equal(result.status, 'reviewed');
    assert(
      fixture.prompts.some(
        (prompt) => /restarted deliberately/.test(prompt) && /artifact is missing/.test(prompt),
      ),
    );
    assert.deepEqual(fixture.options.publication.writes, []);
  } finally {
    await rm(fixture.directory, {
      recursive: true,
      force: true,
    });
  }
});

test('graceful cancellation aborts Pi-owned work and persists a usable session', async () => {
  // Arrange: pause Pi-owned work until it receives an abort signal.
  const fixture = await engineFixture();
  const controller = new AbortController();
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });

  const pause = defineTool({
    name: 'pause_for_cancel',
    description: 'Test interruption',
    parameters: Type.Object({}),
    replay: 'unsafe',
    execute: async (_args, _api, ctx) => {
      began();

      await new Promise<void>((_resolve, reject) =>
        ctx.abortSignal!.addEventListener('abort', () => reject(new Error('Interrupted')), {
          once: true,
        }),
      );

      return {};
    },
  });

  const capability = {
    extension: defineExtension({
      name: 'test.cancellation',
      tools: [pause],
    }),
    tools: [pause],
  };

  try {
    fixture.scripts.set('lead', [
      call('enable_capability', {
        name: 'pause',
      }),
      call('pause_for_cancel', {}),
    ]);

    // Act: start the review and cancel it once the tool is running.
    const running = runReview({
      ...fixture.options,
      signal: controller.signal,
      capabilities: new Map([['lead', new Map([['pause', capability]])]]),
    });
    const checked = assert.rejects(
      running,
      (error) => error instanceof PersistedRunFailure && error.persistence === 'saved',
    );

    await started;
    controller.abort(new Error('Cancel test'));
    await checked;

    const session = await fixture.options.store.read('repositories/7/pulls/12/session.sqlite');

    // Assert: cancellation saved a usable session without publication.
    assert(session);
    assert.deepEqual(fixture.options.publication.writes, []);
  } finally {
    await rm(fixture.directory, {
      recursive: true,
      force: true,
    });
  }
});
