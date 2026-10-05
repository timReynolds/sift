import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type, type AssistantMessage } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage as answer,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { defineExtension, defineTool, type ConversationId } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Config } from '../src/config.ts';
import { parseProfile } from '../src/profiles.ts';
import { InvestigationDoc, openRuntime, type RuntimeOptions } from '../src/runtime.ts';
import { ReviewDoc } from '../src/state.ts';
import { LocalSnapshotStore, restoreDatabase, standaloneSnapshot } from '../src/persistence.ts';

const ctx = BACKGROUND_CONTEXT;

const revision = {
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  mergeBase: 'b'.repeat(40),
  baseRef: 'release',
  headRef: 'feature',
};

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  answer(fauxToolCall(name, args), {
    stopReason: 'toolUse',
  });

const report = {
  findings: [],
  checkedPaths: ['file.txt'],
  tests: [],
  complete: true,
  summary: 'Checked the changed path and its caller',
};

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sift-runtime-'));
  const config = Config.parse({
    version: 1,
    model: 'faux/lead',
    profiles: ['correctness', 'security', 'terraform'],
    agents: {
      correctness: {
        model: 'faux/correctness',
      },
      security: {
        model: 'faux/security',
        reasoning: 'low',
      },
    },
  });

  const profiles = new Map(
    ['lead', ...config.profiles].map((name) => [
      name,
      parseProfile(
        `---\nname: ${name}\ndescription: ${name === 'terraform' ? 'Review Terraform changes only' : name}\n---\nReview carefully.`,
        `${name}.agent.md`,
        config,
      ),
    ]),
  );

  const faux = fauxProvider({
    models: ['lead', 'correctness', 'security'].map((id) => ({
      id,
      reasoning: true,
    })),
  });

  const models = createModels();
  models.setProvider(faux.provider);

  const scripts = new Map<string, AssistantMessage[]>();
  const calls: Array<{
    model: string;
    tools: string[];
  }> = [];

  const respond = (
    context: Parameters<import('@earendil-works/pi-ai/providers/faux').FauxResponseFactory>[0],
    _options: unknown,
    _state: unknown,
    model: {
      id: string;
    },
  ) => {
    const tools = new Set<string>();
    for (const message of context.messages) {
      if (message.role !== 'system') {
        continue;
      }
      for (const tool of message.toolsRemoved ?? []) {
        tools.delete(tool.name);
      }
      for (const tool of message.toolsAdded ?? []) {
        tools.add(tool.name);
      }
    }

    calls.push({
      model: model.id,
      tools: [...tools],
    });

    const response = scripts.get(model.id)?.shift();
    if (!response) {
      throw new Error(`Missing scripted response for ${model.id}`);
    }

    return response;
  };

  faux.setResponses(
    Array.from(
      {
        length: 100,
      },
      () => respond,
    ),
  );

  const workspaces = new Map<string, string>();
  const options: RuntimeOptions = {
    database: join(directory, 'session.sqlite'),
    config,
    profiles,
    models,
    revision,
    reviewContext: 'A TypeScript PR targeting release; no Terraform changes.',
    instructions: 'Follow nested guidance.',
    environment: async (id, name) => {
      const path = join(directory, `${name}-${id}`);
      if (!workspaces.has(id)) {
        await mkdir(path, {
          recursive: true,
        });
        await writeFile(join(path, 'file.txt'), 'original');
        workspaces.set(id, path);
      }
      // Explicit test-only environment, no network credentials or real review repository.
      return new NodeExecutionEnv({
        cwd: path,
      });
    },
  };

  return {
    directory,
    options,
    scripts,
    calls,
    workspaces,
  };
}

const selection = [
  {
    name: 'correctness',
    selected: true,
    reason: 'Changed request handling',
  },
  {
    name: 'security',
    selected: true,
    reason: 'User input reaches the handler',
  },
  {
    name: 'terraform',
    selected: false,
    reason: 'No Terraform change or infrastructure question',
  },
];

test('Pi selects relevant specialists, uses per-agent models, and isolates coding investigations', async () => {
  // Arrange
  const fixture = await createFixture();
  fixture.scripts.set('lead', [
    call('plan_review', {
      scope: 'full',
      reason: 'First review',
      agents: selection,
    }),
    call('investigate', {
      assignments: [
        {
          name: 'correctness',
          task: 'Reproduce the handler behavior',
        },
        {
          name: 'security',
          task: 'Check input validation',
        },
      ],
    }),
    answer('Review complete'),
  ]);

  fixture.scripts.set('correctness', [
    call('write', {
      path: 'file.txt',
      content: 'correctness edit',
    }),
    call('bash', {
      command: 'test "$(cat file.txt)" = "correctness edit"',
    }),
    call('submit_findings', report),
    answer('Complete'),
  ]);

  fixture.scripts.set('security', [
    call('read', {
      path: 'file.txt',
    }),
    call('write', {
      path: 'file.txt',
      content: 'security edit',
    }),
    call('submit_findings', report),
    answer('Complete'),
  ]);
  const runtime = await openRuntime(fixture.options);

  try {
    // Act
    const settled = await (
      await runtime.root.submit(
        {
          type: 'input',
          content: 'Review now',
        },
        ctx,
      )
    ).wait(ctx);

    // Assert
    assert.equal(settled.status, 'done');

    const state = await runtime.harness.snapshot(ReviewDoc, runtime.root.id, ctx);

    assert.equal(state?.selected.correctness?.status, 'completed');
    assert.equal(state?.selected.security?.status, 'completed');
    assert.match(state?.selected.terraform?.reason ?? '', /No Terraform/);
    assert.equal(state?.selected.terraform?.status, 'skipped');

    // Each specialist retains its own filesystem changes.
    const correctness = state!.selected.correctness!.conversationId! as ConversationId;
    const security = state!.selected.security!.conversationId! as ConversationId;
    const correctnessFile = await readFile(
      join(fixture.workspaces.get(String(correctness))!, 'file.txt'),
      'utf8',
    );

    assert.equal(correctnessFile, 'correctness edit');

    const securityFile = await readFile(
      join(fixture.workspaces.get(String(security))!, 'file.txt'),
      'utf8',
    );

    assert.equal(securityFile, 'security edit');

    assert(fixture.calls.some((c) => c.model === 'correctness'));
    assert(fixture.calls.some((c) => c.model === 'security'));
    assert(!fixture.calls.some((c) => c.model === 'terraform'));

    const securityAgent = await (await runtime.harness.conversation(security, ctx))!.agent(ctx);

    assert.equal(securityAgent.thinkingLevel, 'low');
  } finally {
    await runtime.harness.close(ctx);
    await rm(fixture.directory, {
      recursive: true,
      force: true,
    });
  }
});

test('selected capabilities appear on the next request and are reconstructed after SQLite restart', async () => {
  // Arrange
  const fixture = await createFixture();
  const lookup = defineTool({
    name: 'docs_lookup',
    description: 'Read docs',
    parameters: Type.Object({}),
    replay: 'safe',
    execute: async () => ({
      content: [
        {
          type: 'text',
          text: 'documentation',
        },
      ],
    }),
  });
  const extension = defineExtension({
    name: 'sift.mcp.docs',
    tools: [lookup],
  });
  fixture.options.capabilities = new Map([
    [
      'lead',
      new Map([
        [
          'docs',
          {
            extension,
            tools: [lookup],
          },
        ],
      ]),
    ],
  ]);
  fixture.scripts.set('lead', [
    call('enable_capability', {
      name: 'undeclared',
    }),
    call('enable_capability', {
      name: 'docs',
    }),
    call('docs_lookup', {}),
    answer('Done'),
  ]);
  let runtime = await openRuntime(fixture.options);

  try {
    // Act: enable and use the declared capability.
    await (
      await runtime.root.submit(
        {
          type: 'input',
          content: 'Load documentation',
        },
        ctx,
      )
    ).wait(ctx);

    // Assert: tools become available only after the capability is enabled.
    assert(!fixture.calls[0]!.tools.includes('docs_lookup'));
    assert(!fixture.calls[1]!.tools.includes('docs_lookup'));
    assert(fixture.calls[2]!.tools.includes('docs_lookup'));

    const investigation = await runtime.harness.snapshot(InvestigationDoc, runtime.root.id, ctx);

    assert.deepEqual(investigation?.capabilities, ['docs']);

    // Arrange a new runtime over the existing SQLite database.
    await runtime.harness.close(ctx);
    runtime = await openRuntime(fixture.options);
    fixture.scripts.set('lead', [call('docs_lookup', {}), answer('Restored')]);

    // Act: use the capability without enabling it again.
    await (
      await runtime.root.submit(
        {
          type: 'input',
          content: 'Use restored capability',
        },
        ctx,
      )
    ).wait(ctx);

    // Assert
    assert(fixture.calls[4]!.tools.includes('docs_lookup'));
  } finally {
    await runtime.harness.close(ctx);
    await rm(fixture.directory, {
      recursive: true,
      force: true,
    });
  }
});

test('specialist failure remains an explicit coverage gap', async () => {
  // Arrange
  const fixture = await createFixture();
  fixture.scripts.set('lead', [
    call('plan_review', {
      scope: 'full',
      reason: 'First review',
      agents: selection,
    }),
    call('investigate', {
      assignments: [
        {
          name: 'correctness',
          task: 'Investigate',
        },
      ],
    }),
    answer('Coverage incomplete'),
  ]);

  fixture.scripts.set('correctness', [answer('I cannot finish this investigation')]);
  const runtime = await openRuntime(fixture.options);

  try {
    // Act
    await (
      await runtime.root.submit(
        {
          type: 'input',
          content: 'Review',
        },
        ctx,
      )
    ).wait(ctx);
    const state = await runtime.harness.snapshot(ReviewDoc, runtime.root.id, ctx);

    // Assert
    assert.equal(state?.selected.correctness?.status, 'failed');
    assert.match(state?.selected.correctness?.error ?? '', /structured findings/);
    assert.equal(state?.selected.security?.status, 'pending');
  } finally {
    await runtime.harness.close(ctx);
    await rm(fixture.directory, {
      recursive: true,
      force: true,
    });
  }
});

test('follow-up investigation retains specialist history and gets a current Pi task owner', async () => {
  // Arrange
  const fixture = await createFixture();
  fixture.scripts.set('lead', [
    call('plan_review', {
      scope: 'full',
      reason: 'First review',
      agents: selection,
    }),
    call('investigate', {
      assignments: [
        {
          name: 'correctness',
          task: 'Check the conditional path',
        },
      ],
    }),
    call('investigate', {
      assignments: [
        {
          name: 'correctness',
          task: 'Challenge the first result with null input',
          followUp: true,
        },
      ],
    }),
    answer('Validated'),
  ]);

  fixture.scripts.set('correctness', [
    call('submit_findings', report),
    answer('First answer'),
    call('submit_findings', {
      ...report,
      summary: 'Also checked null input',
    }),
    answer('Follow-up answer'),
  ]);
  const runtime = await openRuntime(fixture.options);

  try {
    // Act
    await (
      await runtime.root.submit(
        {
          type: 'input',
          content: 'Review',
        },
        ctx,
      )
    ).wait(ctx);
    const state = await runtime.harness.snapshot(ReviewDoc, runtime.root.id, ctx);

    // Assert
    assert.equal(state?.selected.correctness?.status, 'completed');

    const child = state!.selected.correctness!.conversationId! as ConversationId;
    const conversation = await runtime.harness.conversation(child, ctx);
    const entries = await conversation!.entries({}, 100, undefined, ctx);

    assert.equal(entries.items.filter((e) => e.kind === 'pi.user').length, 2);
    assert.match(JSON.stringify(entries.items), /Check the conditional path/);
    assert.match(JSON.stringify(entries.items), /Challenge the first result/);

    const investigation = await runtime.harness.snapshot(InvestigationDoc, child, ctx);

    assert.equal(investigation?.report?.summary, 'Also checked null input');
    assert.notEqual(
      investigation?.workspaceId,
      String(child),
      'The follow-up reuses its original investigation files',
    );
  } finally {
    await runtime.harness.close(ctx);
    await rm(fixture.directory, {
      recursive: true,
      force: true,
    });
  }
});

test('pending Pi-owned specialist work resumes after SQLite restart without duplicate admissions', async () => {
  // Arrange
  const fixture = await createFixture();
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });

  const pause = defineTool({
    name: 'pause',
    description: 'Simulate an interrupted external command',
    parameters: Type.Object({}),
    replay: 'unsafe',
    execute: async (_args, _api, context) => {
      started();
      await new Promise<void>((_resolve, reject) =>
        context.abortSignal!.addEventListener(
          'abort',
          () => reject(new Error('Process interrupted')),
          {
            once: true,
          },
        ),
      );
      return {};
    },
  });
  fixture.options.capabilities = new Map([
    [
      'correctness',
      new Map([
        [
          'test',
          {
            extension: defineExtension({
              name: 'test.pause',
              tools: [pause],
            }),
            tools: [pause],
          },
        ],
      ]),
    ],
  ]);
  fixture.scripts.set('lead', [
    call('plan_review', {
      scope: 'full',
      reason: 'First review',
      agents: selection,
    }),
    call('investigate', {
      assignments: [
        {
          name: 'correctness',
          task: 'Check with a command',
        },
      ],
    }),
    answer('Finished after recovery'),
  ]);

  fixture.scripts.set('correctness', [
    call('enable_capability', {
      name: 'test',
    }),
    call('pause', {}),
    call('submit_findings', report),
    answer('Investigated the interrupted operation'),
  ]);
  let runtime = await openRuntime(fixture.options);

  try {
    // Act: start the specialist and interrupt its external command.
    const submitted = await runtime.root.submit(
      {
        type: 'input',
        content: 'Review',
        requestId: 'run:1',
      },
      ctx,
    );
    await running;
    const before = await runtime.harness.snapshot(ReviewDoc, runtime.root.id, ctx);
    const childId = before!.selected.correctness!.conversationId! as ConversationId;
    await runtime.harness.close(ctx);

    // Arrange a restored database in a new runtime.
    const store = new LocalSnapshotStore(join(fixture.directory, 'store'));
    const snapshotPath = join(fixture.directory, 'upload.sqlite');
    await standaloneSnapshot(fixture.options.database, snapshotPath);
    await store.write('state', await readFile(snapshotPath));
    fixture.options.database = join(fixture.directory, 'download.sqlite');
    await restoreDatabase(store, 'state', fixture.options.database);
    runtime = await openRuntime(fixture.options);

    // Act: resume the existing submission.
    const resumed = await runtime.harness.submission(submitted.id, ctx);
    const settled = await resumed!.wait(ctx);

    // Assert
    assert.equal(settled.status, 'done');

    const after = await runtime.harness.snapshot(ReviewDoc, runtime.root.id, ctx);

    assert.equal(after?.selected.correctness?.status, 'completed');
    assert.equal(after?.selected.correctness?.conversationId, childId);

    const entries = await (await runtime.harness.conversation(childId, ctx))!.entries(
      {},
      100,
      undefined,
      ctx,
    );

    assert.equal(entries.items.filter((e) => e.kind === 'pi.user').length, 1);
    assert.match(JSON.stringify(entries.items), /interrupted/);
  } finally {
    await runtime.harness.close(ctx);
    await rm(fixture.directory, {
      recursive: true,
      force: true,
    });
  }
});
