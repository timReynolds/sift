import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, configIdentity, parseConfig, resolveEnv } from '../src/config.ts';
import { modelRef } from '../src/contracts.ts';
import { cliOptions } from '../src/cli.ts';

const config = {
  version: 1,
  model: 'faux/lead',
  profiles: ['correctness', 'security'],
};

test('configuration has explicit available agents and conservative review defaults', () => {
  // Arrange
  const invalidAgentSelections = [
    { ...config, profiles: ['lead'] },
    { ...config, profiles: ['security', 'security'] },
    { ...config, agents: { unrelated: { model: 'faux/other' } } },
  ];
  const sharedSources = {
    ...config,
    sources: { shared: { repository: 'owner/profiles', ref: 'a'.repeat(40) } },
  };

  // Act
  const parsed = Config.parse(config);
  const shared = Config.parse(sharedSources);

  // Assert: conservative defaults
  assert.equal(parsed.policy.blockThrough, 'P1');
  assert.equal(parsed.policy.publishThrough, 'P2');
  assert.equal(parsed.policy.drafts, 'skip');
  assert.equal(parsed.execution.concurrency, 4);

  // Assert: local and reusable profiles use the same dedicated directory.
  assert.deepEqual(parsed.sources.local, ['.agents/sift']);
  assert.equal(shared.sources.shared?.path, '.agents/sift');

  // Act and Assert: every override names an available specialist.
  for (const selection of invalidAgentSelections) {
    assert.throws(() => Config.parse(selection));
  }
});

test('configuration rejects implicit permissions, mutable shared refs, and literal secrets', () => {
  // Arrange
  const invalidConfigurations = [
    {
      ...config,
      allowPush: true,
    },
    {
      ...config,
      sources: {
        shared: { repository: 'a/b', ref: 'main' },
      },
    },
    {
      ...config,
      mcp: {
        test: { type: 'stdio', command: 'server', tools: ['*'] },
      },
    },
    {
      ...config,
      mcp: {
        test: {
          type: 'stdio',
          command: 'server',
          tools: ['read'],
          env: { TOKEN: 'secret-value' },
        },
      },
    },
    {
      ...config,
      mcp: {
        test: {
          type: 'http',
          url: 'https://test.example/?token=secret',
          tools: ['read'],
        },
      },
    },
  ];
  const references = { TOKEN: 'TEST_SECRET' };
  const environment = { TEST_SECRET: 'value' };

  // Act and Assert: unsafe configuration is rejected.
  for (const invalidConfig of invalidConfigurations) {
    assert.throws(() => Config.parse(invalidConfig));
  }

  // Act: resolve an explicitly named environment variable.
  const resolved = resolveEnv(references, environment);

  // Assert
  assert.deepEqual(resolved, { TOKEN: 'value' });
  assert.throws(() => resolveEnv(references, {}), /TEST_SECRET/);
});

test('YAML rejects duplicate configuration keys and identity is key-order independent', () => {
  // Act and Assert: duplicate YAML keys are rejected.
  assert.throws(() => parseConfig('version: 1\nversion: 2'));

  // Arrange
  const first = Config.parse(config);
  const second = Config.parse({
    profiles: config.profiles,
    model: config.model,
    version: 1,
  });
  const revision = 'a'.repeat(40);
  const changedRevision = 'b'.repeat(40);

  // Act
  const firstIdentity = configIdentity(first, revision);
  const reorderedIdentity = configIdentity(second, revision);
  const changedIdentity = configIdentity(first, changedRevision);

  // Assert
  assert.equal(firstIdentity, reorderedIdentity);
  assert.notEqual(firstIdentity, changedIdentity);
});

test('CLI validates explicit PR context and does not infer event SHA as head', () => {
  // Arrange
  const args = ['--pr', '12', '--dry-run'];
  const invalidArgs = [['--pr', '-1'], ['--repository', 'bad/path/extra'], ['--push']];

  // Act
  const options = cliOptions(args);

  // Assert
  assert.equal(options.pr, '12');

  // Act and Assert: malformed context and unsupported flags are rejected.
  for (const invalidInput of invalidArgs) {
    assert.throws(() => cliOptions(invalidInput));
  }

  // Act: a provider ID can contain additional path segments.
  const model = modelRef('openrouter/vendor/model');

  // Assert
  assert.deepEqual(model, { provider: 'openrouter', modelId: 'vendor/model' });
});
