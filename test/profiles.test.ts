import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Config } from '../src/config.ts';
import { catalogue, codingToolNames, loadProfiles, parseProfile } from '../src/profiles.ts';
import { instructionsFor, loadInstructions } from '../src/instructions.ts';

const config = Config.parse({
  version: 1,
  model: 'faux/lead',
  profiles: ['correctness'],
  agents: {
    correctness: {
      model: 'faux/small',
      reasoning: 'low',
    },
  },
});

test('profiles support frontmatter, per-agent settings, coding aliases, and secret references', () => {
  // Arrange
  const profileSource = `---
name: correctness
description: Find defects
tools: read, Bash, Edit
sift:
  reasoning: high
mcp-servers:
  docs:
    type: local
    command: docs-server
    tools: [read]
    env:
      TOKEN: "\${{ secrets.DOCS_TOKEN }}"
---
Investigate regressions.`;

  // Act
  const profile = parseProfile(profileSource, 'correctness.agent.md', config);

  // Assert
  assert.equal(profile.model, 'faux/small');
  assert.equal(profile.reasoning, 'low');
  assert.deepEqual([...codingToolNames(profile)], ['read', 'bash', 'edit', 'write']);
  assert.deepEqual(profile.mcp.docs?.type === 'stdio' && profile.mcp.docs.env, {
    TOKEN: 'DOCS_TOKEN',
  });

  // Invalid profile settings must still be rejected.
  assert.throws(() =>
    parseProfile('---\ndescription: test\nsift:\n  budget: 5\n---\nGo', 'test.agent.md', config),
  );
});

test('local profiles override a pinned shared source and unrelated profiles stay inactive', async () => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'sift-profiles-'));
  const local = join(directory, 'local');
  const shared = join(directory, 'shared');

  try {
    for (const root of [local, shared]) {
      await mkdir(join(root, '.github/agents'), {
        recursive: true,
      });
    }
    const profile = (name: string, description: string) =>
      `---\nname: ${name}\ndescription: ${description}\n---\nInvestigate.`;
    await writeFile(join(shared, '.github/agents/lead.agent.md'), profile('lead', 'Lead'));
    await writeFile(join(shared, '.github/agents/a.agent.md'), profile('correctness', 'Shared'));
    await writeFile(join(local, '.github/agents/b.agent.md'), profile('correctness', 'Local'));
    await writeFile(
      join(local, '.github/agents/unrelated.agent.md'),
      'This is not even a Sift profile',
    );
    const cfg = Config.parse({
      ...config,
      sources: {
        shared: {
          repository: 'a/b',
          ref: 'a'.repeat(40),
        },
      },
    });

    // Act
    const profiles = await loadProfiles(cfg, local, shared);

    // Assert
    assert.equal(profiles.size, 2);
    assert.equal(profiles.get('correctness')?.description, 'Local');
    assert.deepEqual(catalogue(profiles, cfg), [
      {
        name: 'correctness',
        description: 'Local',
        globs: [],
      },
    ]);

    // Arrange a duplicate local profile, then verify loading rejects it.
    await writeFile(join(local, '.github/agents/c.agent.md'), profile('correctness', 'Duplicate'));

    await assert.rejects(loadProfiles(cfg, local, shared), /Duplicate profile/);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

test('AGENTS guidance is directory-scoped and symlinks cannot import host instructions', async () => {
  // Arrange
  const directory = await mkdtemp(join(tmpdir(), 'sift-instructions-'));
  const root = join(directory, 'repo');

  try {
    await mkdir(join(root, 'src/nested'), {
      recursive: true,
    });
    await writeFile(join(root, 'AGENTS.md'), 'Root guidance');
    await writeFile(join(root, 'src/AGENTS.md'), 'Source guidance');

    // Act
    const instructions = await loadInstructions(root);

    // Assert
    assert.deepEqual(
      instructionsFor(instructions, 'test/a.ts').map((i) => i.text),
      ['Root guidance'],
    );
    assert.deepEqual(
      instructionsFor(instructions, 'src/nested/a.ts').map((i) => i.text),
      ['Root guidance', 'Source guidance'],
    );

    // Arrange an instruction symlink outside the trusted checkout.
    await writeFile(join(directory, 'private'), 'Should never be imported');
    await symlink(join(directory, 'private'), join(root, 'src/nested/AGENTS.md'));

    await assert.rejects(loadInstructions(root), /escapes trusted checkout/);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});
