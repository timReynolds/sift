import { readdir, readFile, realpath, lstat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { AgentOverride, type Config, McpServer, parseYaml } from './config.ts';
import { Model, Reasoning, StableName } from './contracts.ts';

const ToolList = z.union([
  z.array(z.string()),
  z.string().transform((value) =>
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  ),
]);
const Frontmatter = z
  .object({
    name: StableName.optional(),
    description: z.string().min(1),
    model: Model.optional(),
    tools: ToolList.optional(),
    'mcp-servers': z.record(StableName, z.unknown()).optional(),
    sift: z
      .object({
        reasoning: Reasoning.optional(),
        globs: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    target: z.enum(['vscode', 'github-copilot']).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    'disable-model-invocation': z.boolean().optional(),
    'user-invocable': z.boolean().optional(),
    infer: z.boolean().optional(),
  })
  .strict();

export type Profile = {
  name: string;
  description: string;
  instructions: string;
  model: string;
  reasoning: z.infer<typeof Reasoning>;
  tools: string[];
  globs: string[];
  mcp: Record<string, McpServer>;
  source: string;
};

function environmentReference(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('MCP credentials must be environment references');
  }
  const patterns = [
    /^\$([A-Z_][A-Z0-9_]*)$/,
    /^\$\{([A-Z_][A-Z0-9_]*)\}$/,
    /^\$\{\{\s*(?:secrets|vars)\.([A-Z_][A-Z0-9_]*)\s*\}\}$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match?.[1]) {
      return match[1];
    }
  }
  throw new Error(
    'MCP credentials require $ENV_NAME, ${ENV_NAME}, or a secrets/vars reference; literal values and defaults are unsupported',
  );
}

function profileServer(value: unknown): McpServer {
  const raw = z
    .object({
      type: z.enum(['local', 'stdio', 'http']),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      env: z.record(z.string(), z.unknown()).optional(),
      headers: z.record(z.string(), z.unknown()).optional(),
      tools: z.array(z.string()).min(1),
      methods: z.record(z.string(), z.array(z.string())).optional(),
    })
    .strict()
    .parse(value);
  const refs = (values: Record<string, unknown> = {}) =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, environmentReference(v)]));
  return McpServer.parse(
    raw.type === 'http'
      ? {
          type: 'http',
          url: raw.url,
          tools: raw.tools,
          methods: raw.methods,
          headers: refs(raw.headers),
        }
      : {
          type: 'stdio',
          command: raw.command,
          args: raw.args,
          tools: raw.tools,
          methods: raw.methods,
          env: refs(raw.env),
        },
  );
}

export function parseProfile(text: string, source: string, config: Config): Profile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) {
    throw new Error(`Profile ${source} requires YAML frontmatter`);
  }
  const header = Frontmatter.parse(parseYaml(match[1]!));
  const name = StableName.parse(header.name ?? basename(source).replace(/(?:\.agent)?\.md$/, ''));
  const override = AgentOverride.parse(config.agents[name] ?? {});
  const instructions = match[2]!.trim();
  if (!instructions || instructions.length > 30_000) {
    throw new Error(`Profile ${name} instructions must contain 1–30000 characters`);
  }
  return {
    name,
    description: header.description,
    instructions,
    source,
    model: override.model ?? header.model ?? config.model,
    reasoning: override.reasoning ?? header.sift?.reasoning ?? config.reasoning,
    tools: override.tools ?? header.tools ?? ['read', 'edit', 'search', 'execute'],
    globs: header.sift?.globs ?? [],
    mcp: Object.fromEntries(
      Object.entries(header['mcp-servers'] ?? {}).map(([k, v]) => [k, profileServer(v)]),
    ),
  };
}

export async function containedPath(root: string, path: string): Promise<string> {
  const rootReal = await realpath(root);
  const candidate = await realpath(resolve(root, path));
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) {
    throw new Error(`Path escapes trusted checkout: ${path}`);
  }
  return candidate;
}

export async function loadProfiles(
  config: Config,
  trustedRoot: string,
  sharedRoot?: string,
): Promise<Map<string, Profile>> {
  const selected = new Set([config.lead, ...config.profiles]);
  const result = new Map<string, Profile>();
  const scan = async (root: string, directories: string[]) => {
    const level = new Map<string, Profile>();
    for (const directory of directories) {
      let entries;
      try {
        entries = await readdir(await containedPath(root, directory), {
          withFileTypes: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.name.endsWith('.agent.md')) {
          continue;
        }
        const path = await containedPath(root, join(directory, entry.name));
        if (!(await lstat(path)).isFile()) {
          continue;
        }
        // Read the stable name before validating unrelated profiles for other tools.
        const text = await readFile(path, 'utf8');
        const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
        const raw = header ? (parseYaml(header[1]!) as Record<string, unknown>) : {};
        const name =
          typeof raw?.name === 'string' ? raw.name : entry.name.replace(/\.agent\.md$/, '');
        if (!selected.has(name)) {
          continue;
        }
        const profile = parseProfile(text, relative(root, path), config);
        if (level.has(name)) {
          throw new Error(`Duplicate profile ${name} at the same precedence level`);
        }
        level.set(name, profile);
      }
    }
    for (const [name, profile] of level) {
      result.set(name, profile);
    }
  };
  if (config.sources.shared) {
    if (!sharedRoot) {
      throw new Error('Pinned shared profile checkout was not provided');
    }
    await scan(sharedRoot, [config.sources.shared.path]);
  }
  await scan(trustedRoot, config.sources.local);
  for (const name of selected) {
    if (!result.has(name)) {
      throw new Error(`Configured profile ${name} was not found`);
    }
  }
  return result;
}

export function catalogue(profiles: Map<string, Profile>, config: Config) {
  return config.profiles.map((name) => {
    const profile = profiles.get(name);
    if (!profile) {
      throw new Error(`Missing profile ${name}`);
    }
    return {
      name,
      description: profile.description,
      globs: profile.globs,
    };
  });
}

export const CODING_ALIASES: Record<string, string[]> = {
  read: ['read'],
  notebookread: ['read'],
  edit: ['edit', 'write'],
  multiedit: ['edit', 'write'],
  write: ['write'],
  notebookedit: ['edit', 'write'],
  search: ['bash'],
  grep: ['bash'],
  glob: ['bash'],
  execute: ['bash'],
  shell: ['bash'],
  bash: ['bash'],
  powershell: ['bash'],
};
export function codingToolNames(profile: Profile): Set<string> {
  const names = new Set<string>();
  for (const name of profile.tools) {
    for (const tool of name === '*'
      ? ['read', 'write', 'edit', 'bash']
      : (CODING_ALIASES[name.toLowerCase()] ?? [])) {
      names.add(tool);
    }
  }
  return names;
}
