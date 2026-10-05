import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { type McpServer, resolveEnv } from './config.ts';
import type { Capability } from './runtime.ts';
import type { Repository } from './contracts.ts';

export type McpCaller = Pick<McpConnection, 'call'>;

export type Scope = Pick<Repository, 'owner' | 'name' | 'pullNumber'> & {
  linkedIssues?: number[];
  ownedThreads?: Set<string>;
};
export const GITHUB_READ_METHODS: Record<string, string[]> = {
  pull_request_read: [
    'get',
    'get_diff',
    'get_status',
    'get_files',
    'get_commits',
    'get_review_comments',
    'get_reviews',
    'get_comments',
    'get_check_runs',
  ],
  issue_read: ['get', 'get_comments', 'get_sub_issues', 'get_parent', 'get_labels'],
  actions_list: [
    'list_workflows',
    'list_workflow_runs',
    'list_workflow_jobs',
    'list_workflow_run_artifacts',
  ],
  actions_get: ['get_workflow', 'get_workflow_run', 'get_workflow_job', 'get_workflow_run_usage'],
};
export const GITHUB_READ_TOOLS = [
  ...Object.keys(GITHUB_READ_METHODS),
  'get_file_contents',
  'search_code',
  'get_commit',
  'list_commits',
  'get_job_logs',
];
export const GITHUB_WRITE_TOOLS = [
  'pull_request_review_write',
  'add_comment_to_pending_review',
  'add_reply_to_pull_request_comment',
  'add_issue_comment',
  'update_issue_comment',
];
export const GITHUB_WRITE_METHODS = {
  pull_request_review_write: [
    'create',
    'submit_pending',
    'delete_pending',
    'resolve_thread',
    'unresolve_thread',
  ],
};

export function scopeGitHubCall(
  name: string,
  input: Record<string, unknown>,
  scope: Scope,
): Record<string, unknown> {
  const args = {
    ...input,
  };
  if (name === 'search_code') {
    const query = String(args.query ?? '');
    if (/\b(?:repo|org|user)\s*:|\bOR\b/i.test(query)) {
      throw new Error('Code search cannot change repository scope');
    }
    return {
      ...args,
      query: `repo:${scope.owner}/${scope.name} ${query}`,
    };
  }
  if (args.owner !== undefined && String(args.owner).toLowerCase() !== scope.owner.toLowerCase()) {
    throw new Error('Cross-repository owner rejected');
  }
  if (args.repo !== undefined && String(args.repo).toLowerCase() !== scope.name.toLowerCase()) {
    throw new Error('Cross-repository name rejected');
  }
  args.owner = scope.owner;
  args.repo = scope.name;
  if (
    name.startsWith('pull_request_') ||
    ['add_comment_to_pending_review', 'add_reply_to_pull_request_comment'].includes(name)
  ) {
    if (args.pullNumber !== undefined && args.pullNumber !== scope.pullNumber) {
      throw new Error('Cross-PR call rejected');
    }
    args.pullNumber = scope.pullNumber;
  }
  if (args.threadId !== undefined && !scope.ownedThreads?.has(String(args.threadId))) {
    throw new Error('Thread is not a verified Sift-owned thread in this PR');
  }
  if (name === 'issue_read') {
    if (
      args.issue_number !== scope.pullNumber &&
      !scope.linkedIssues?.includes(Number(args.issue_number))
    ) {
      throw new Error('Issue is not linked from this PR');
    }
  }
  if (name === 'add_issue_comment') {
    if (args.issue_number !== undefined && args.issue_number !== scope.pullNumber) {
      throw new Error('Cross-PR conversation write rejected');
    }
    args.issue_number = scope.pullNumber;
  }
  if (name === 'get_job_logs') {
    args.return_content = true;
  }
  if ('reaction' in args) {
    throw new Error('Reaction behavior is outside Sift v1');
  }
  return args;
}

export function redactSecrets(value: string, secrets: string[]): string {
  return secrets
    .flatMap((secret) => [secret, secret.replace(/^(?:Bearer|Basic)\s+/i, '')])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
}

export class McpConnection {
  readonly client: Client;
  readonly definition: McpServer;
  readonly tools: Map<string, Tool>;
  readonly #secrets: string[];
  readonly #scope?: Scope;

  private constructor(
    client: Client,
    definition: McpServer,
    tools: Tool[],
    secrets: string[],
    scope?: Scope,
  ) {
    this.client = client;
    this.definition = definition;
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.#secrets = secrets;
    this.#scope = scope;
  }

  static async connect(
    definition: McpServer,
    options: {
      env?: NodeJS.ProcessEnv;
      transport?: Transport;
      scope?: Scope;
      expectedVersion?: string;
    } = {},
  ): Promise<McpConnection> {
    const env = options.env ?? process.env;
    const resolved = resolveEnv(
      definition.type === 'stdio' ? definition.env : definition.headers,
      env,
    );
    const transport =
      options.transport ??
      (definition.type === 'stdio'
        ? new StdioClientTransport({
            command: definition.command,
            args: definition.args,
            env: {
              PATH: env.PATH ?? '/usr/bin:/bin',
              ...resolved,
            },
            stderr: 'ignore',
          })
        : new StreamableHTTPClientTransport(new URL(definition.url), {
            requestInit: {
              headers: resolved,
            },
          }));
    const client = new Client({
      name: 'sift',
      version: '0.1.0',
    });
    try {
      await client.connect(transport);
      if (
        options.expectedVersion &&
        client.getServerVersion()?.version !== options.expectedVersion
      ) {
        throw new Error(`MCP server version must be ${options.expectedVersion}`);
      }
      const tools: Tool[] = [];
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await client.listTools(
          cursor
            ? {
                cursor,
              }
            : undefined,
        );
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) {
          throw new Error('MCP tool pagination repeated a cursor');
        }
        if (cursor) {
          cursors.add(cursor);
        }
      } while (cursor);
      for (const name of definition.tools) {
        const tool = tools.find((item) => item.name === name);
        if (!tool) {
          throw new Error(`Configured MCP tool ${name} is unavailable`);
        }
        const property = z
          .object({ enum: z.array(z.string()).optional() })
          .optional()
          .parse(tool.inputSchema.properties?.method);
        if (property && !definition.methods[name]?.length) {
          throw new Error(`Method allowlist required for ${name}`);
        }
        for (const method of definition.methods[name] ?? []) {
          if (!property?.enum?.includes(method)) {
            throw new Error(`Configured method ${name}:${method} is unavailable`);
          }
        }
      }
      return new McpConnection(client, definition, tools, Object.values(resolved), options.scope);
    } catch (error) {
      await client.close().catch(() => {});
      throw new Error(
        redactSecrets(
          error instanceof Error ? error.message : String(error),
          Object.values(resolved),
        ),
      );
    }
  }

  async call(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    if (!this.definition.tools.includes(name)) {
      throw new Error(`MCP tool ${name} is not allowed`);
    }
    const allowedMethods = this.definition.methods[name];
    if (allowedMethods && !allowedMethods.includes(String(input.method))) {
      throw new Error(`MCP method ${name}:${String(input.method)} is not allowed`);
    }
    const args = this.#scope ? scopeGitHubCall(name, input, this.#scope) : input;
    try {
      const receipt = await this.client.callTool(
        {
          name,
          arguments: args,
        },
        undefined,
        {
          signal,
          timeout: 120_000,
        },
      );
      const safe = CallToolResultSchema.parse(
        JSON.parse(redactSecrets(JSON.stringify(receipt), this.#secrets)),
      );
      if (safe.isError) {
        throw new Error(`MCP ${name} failed: ${JSON.stringify(safe.content)}`);
      }
      return safe;
    } catch (error) {
      throw new Error(
        redactSecrets(error instanceof Error ? error.message : String(error), this.#secrets),
      );
    }
  }

  /** Models only receive read tools; operational publication uses the host connection directly. */
  capability(namespace: string): Capability {
    if (!/^[a-z][a-z0-9_]*$/.test(namespace)) {
      throw new Error('Invalid MCP namespace');
    }
    const tools = this.definition.tools.map((name) => {
      const tool = this.tools.get(name)!;
      if (tool.annotations?.readOnlyHint !== true) {
        throw new Error(`Model-facing MCP tool ${name} must be read-only`);
      }
      const schema = structuredClone(tool.inputSchema);
      if (this.definition.methods[name] && schema.properties?.method) {
        schema.properties.method = {
          ...schema.properties.method,
          enum: this.definition.methods[name],
        };
      }
      return defineTool({
        name: `${namespace}__${name}`,
        description: tool.description ?? name,
        parameters: Type.Unsafe<Record<string, unknown>>(schema),
        replay: 'safe',
        execute: async (args, _api, context) => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify(await this.call(name, args, context.abortSignal)),
            },
          ],
        }),
      });
    });
    return {
      extension: defineExtension({
        name: `sift.mcp.${namespace}`,
        tools,
      }),
      tools,
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
