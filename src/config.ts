import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import {
  canonical,
  digest,
  Model,
  Policy,
  Reasoning,
  RepoPath,
  Sha,
  StableName,
} from './contracts.ts';

const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const McpCommon = {
  tools: z
    .array(z.string().min(1))
    .min(1)
    .refine((values) => values.every((v) => !v.includes('*')), 'Explicit tools required'),
  methods: z.record(z.string(), z.array(z.string().min(1)).min(1)).default({}),
};
export const McpServer = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(EnvName, EnvName).default({}),
      ...McpCommon,
    })
    .strict(),
  z
    .object({
      type: z.literal('http'),
      url: z.url().refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        );
      }, 'MCP URL must use HTTPS and contain no credentials or query string'),
      headers: z.record(z.string(), EnvName).default({}),
      ...McpCommon,
    })
    .strict(),
]);
export type McpServer = z.infer<typeof McpServer>;

export const AgentOverride = z
  .object({
    model: Model.optional(),
    reasoning: Reasoning.optional(),
    tools: z.array(z.string()).optional(),
  })
  .strict();
export const Config = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).default('Sift'),
    mention: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .default('sift'),
    lead: StableName.default('lead'),
    profiles: z.array(StableName).min(1),
    sources: z
      .object({
        local: z.array(RepoPath).default(['.agents/sift']),
        shared: z
          .object({
            repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
            ref: Sha,
            path: RepoPath.default('.agents/sift'),
          })
          .strict()
          .optional(),
      })
      .strict()
      .prefault({}),
    model: Model,
    reasoning: Reasoning.default('high'),
    agents: z.record(StableName, AgentOverride).default({}),
    mcp: z.record(StableName, McpServer).default({}),
    policy: Policy.prefault({}),
    persistence: z
      .discriminatedUnion('mode', [
        z
          .object({
            mode: z.literal('local'),
          })
          .strict(),
        z
          .object({
            mode: z.literal('gcs'),
            bucket: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/),
            prefix: RepoPath.default('sift'),
          })
          .strict(),
      ])
      .default({
        mode: 'local',
      }),
    execution: z
      .object({
        concurrency: z.number().int().min(1).max(32).default(4),
        timeoutSeconds: z.number().int().min(1).max(21600).default(1800),
        commandTimeoutSeconds: z.number().int().min(1).max(1800).default(300),
        modelTimeoutSeconds: z.number().int().min(1).max(1800).default(180),
        containerImage: z
          .string()
          .regex(/^[^\s]+@sha256:[a-f0-9]{64}$/, 'Pin the investigation container by digest')
          .optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.profiles).size !== value.profiles.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['profiles'],
        message: 'Duplicate profile name',
      });
    }
    if (value.profiles.includes(value.lead)) {
      ctx.addIssue({
        code: 'custom',
        path: ['profiles'],
        message: 'Lead cannot select itself as a specialist',
      });
    }
    for (const name of Object.keys(value.agents)) {
      if (name !== value.lead && !value.profiles.includes(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['agents', name],
          message: 'Override must name an available agent',
        });
      }
    }
  });
export type Config = z.infer<typeof Config>;

export function parseYaml(text: string): unknown {
  const document = parseDocument(text, {
    uniqueKeys: true,
  });
  if (document.errors.length) {
    throw new Error(`Invalid YAML: ${document.errors.map((e) => e.message).join('; ')}`);
  }
  return document.toJS({
    maxAliasCount: 100,
  });
}

export function parseConfig(text: string): Config {
  return Config.parse(parseYaml(text));
}

/** Only call with a file from a trusted checkout or an explicitly supplied runner path. */
export async function loadConfig(path: string): Promise<Config> {
  return parseConfig(await readFile(path, 'utf8'));
}

export function configIdentity(config: Config, trustedRevision: string): string {
  Sha.parse(trustedRevision);
  return digest(
    canonical({
      config,
      trustedRevision,
    }),
  );
}

/** Values are resolved at the operational boundary, never returned in persisted config. */
export function resolveEnv(
  refs: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(refs).map(([key, reference]) => {
      EnvName.parse(reference);
      const value = env[reference];
      if (!value) {
        throw new Error(`Missing environment variable ${reference}`);
      }
      return [key, value];
    }),
  );
}
