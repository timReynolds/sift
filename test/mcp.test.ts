import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '../src/config.ts';
import { McpConnection, scopeGitHubCall } from '../src/mcp.ts';

const scope = {
  owner: 'acme',
  name: 'app',
  pullNumber: 12,
  linkedIssues: [9],
  ownedThreads: new Set(['owned']),
};

test('MCP enforces installed method schemas, repository scope, read-only exposure and secret redaction', async () => {
  // Arrange
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    {
      name: 'fake-github',
      version: '1.14.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );
  const calls: unknown[] = [];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'pull_request_read',
        description: 'Read PR',
        inputSchema: {
          type: 'object',
          properties: {
            method: {
              type: 'string',
              enum: ['get', 'get_diff'],
            },
            owner: {
              type: 'string',
            },
            repo: {
              type: 'string',
            },
            pullNumber: {
              type: 'number',
            },
          },
          required: ['method'],
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      {
        name: 'write',
        inputSchema: {
          type: 'object',
        },
        annotations: {
          readOnlyHint: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push(request.params);
    return {
      content: [
        {
          type: 'text',
          text: 'server echoed test-secret-value',
        },
      ],
    };
  });
  await server.connect(serverTransport);

  const config = McpServer.parse({
    type: 'stdio',
    command: 'unused',
    env: {
      TOKEN: 'TEST_TOKEN',
    },
    tools: ['pull_request_read'],
    methods: {
      pull_request_read: ['get'],
    },
  });
  const connection = await McpConnection.connect(config, {
    transport: clientTransport,
    scope,
    expectedVersion: '1.14.0',
    env: {
      TEST_TOKEN: 'test-secret-value',
    },
  });

  try {
    // Act
    const result = await connection.call('pull_request_read', {
      method: 'get',
    });

    // Assert
    assert.match(JSON.stringify(result), /\[REDACTED\]/);
    assert(!JSON.stringify(result).includes('test-secret-value'));
    assert.deepEqual(calls[0], {
      name: 'pull_request_read',
      arguments: {
        method: 'get',
        owner: 'acme',
        repo: 'app',
        pullNumber: 12,
      },
    });

    // Disallowed methods, other pull requests, and writes never reach the server.
    await assert.rejects(
      connection.call('pull_request_read', {
        method: 'get_diff',
      }),
      /not allowed/,
    );
    await assert.rejects(
      connection.call('pull_request_read', {
        method: 'get',
        pullNumber: 99,
      }),
      /Cross-PR/,
    );
    await assert.rejects(connection.call('write', {}), /not allowed/);

    assert.equal(calls.length, 1);

    // Act: expose only the configured methods to the model.
    const capability = connection.capability('github');
    const modelSchema = ToolSchema.shape.inputSchema.parse(capability.tools[0]?.parameters);

    // Assert
    assert.equal(capability.tools[0]?.name, 'github__pull_request_read');
    assert.deepEqual(modelSchema.properties?.method, {
      type: 'string',
      enum: ['get'],
    });
    assert.deepEqual(connection.tools.get('pull_request_read')?.inputSchema.properties?.method, {
      type: 'string',
      enum: ['get', 'get_diff'],
    });
  } finally {
    await connection.close();
    await server.close();
  }
});

test('MCP rejects advertised method enums that are not arrays of strings', async () => {
  // Arrange
  const config = McpServer.parse({
    type: 'stdio',
    command: 'unused',
    tools: ['pull_request_read'],
    methods: { pull_request_read: ['get'] },
  });

  for (const advertisedEnum of ['get_diff', [1, 'get']]) {
    // Arrange a server whose enum would otherwise appear to contain the allowed method.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server(
      { name: 'fake-github', version: '1.14.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'pull_request_read',
          inputSchema: {
            type: 'object',
            properties: { method: { type: 'string', enum: advertisedEnum } },
          },
        },
      ],
    }));
    await server.connect(serverTransport);

    try {
      // Act / Assert
      await assert.rejects(McpConnection.connect(config, { transport: clientTransport }), /enum/);
    } finally {
      await clientTransport.close();
      await server.close();
    }
  }
});

test('GitHub scope restricts search, linked issues, reactions, and owned threads', () => {
  // Reject search expressions that could escape the repository.
  for (const query of ['repo:other/app test', 'term OR other', '(repo:other/app)']) {
    assert.throws(() =>
      scopeGitHubCall(
        'search_code',
        {
          query,
        },
        scope,
      ),
    );
  }

  const search = scopeGitHubCall(
    'search_code',
    {
      query: 'findMe',
    },
    scope,
  );

  assert.equal(search.query, 'repo:acme/app findMe');

  // Reject cross-repository calls and threads that belong to a human.
  assert.throws(() =>
    scopeGitHubCall(
      'get_commit',
      {
        repo: 'other',
      },
      scope,
    ),
  );
  assert.throws(() =>
    scopeGitHubCall(
      'pull_request_review_write',
      {
        method: 'resolve_thread',
        threadId: 'human-thread',
      },
      scope,
    ),
  );

  const ownedThread = scopeGitHubCall(
    'pull_request_review_write',
    {
      method: 'resolve_thread',
      threadId: 'owned',
    },
    scope,
  );

  assert.equal(ownedThread.threadId, 'owned');

  // Only issues linked to this pull request are readable.
  assert.throws(() =>
    scopeGitHubCall(
      'issue_read',
      {
        issue_number: 777,
      },
      scope,
    ),
  );

  const linkedIssue = scopeGitHubCall(
    'issue_read',
    {
      issue_number: 9,
    },
    scope,
  );

  assert.equal(linkedIssue.issue_number, 9);

  assert.throws(() =>
    scopeGitHubCall(
      'add_issue_comment',
      {
        reaction: '+1',
      },
      scope,
    ),
  );
});
