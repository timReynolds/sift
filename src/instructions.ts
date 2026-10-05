import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { containedPath } from './profiles.ts';
import { RepoPath } from './contracts.ts';

export type ScopedInstructions = {
  directory: string;
  text: string;
};
const EXCLUDED = new Set(['.git', '.sift']);

export async function loadInstructions(root: string): Promise<ScopedInstructions[]> {
  const result: ScopedInstructions[] = [];
  const visit = async (directory: string) => {
    const entries = await readdir(directory, {
      withFileTypes: true,
    });
    if (entries.some((entry) => entry.name === 'AGENTS.md')) {
      const path = await containedPath(root, join(relative(root, directory), 'AGENTS.md'));
      result.push({
        directory: relative(root, directory).split(sep).join('/'),
        text: await readFile(path, 'utf8'),
      });
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !EXCLUDED.has(entry.name)) {
        await visit(join(directory, entry.name));
      }
    }
  };
  await visit(root);
  return result;
}

export function instructionsFor(
  instructions: ScopedInstructions[],
  path: string,
): ScopedInstructions[] {
  RepoPath.parse(path);
  return instructions
    .filter((item) => !item.directory || path.startsWith(item.directory + '/'))
    .sort(
      (a, b) =>
        a.directory.split('/').length - b.directory.split('/').length ||
        a.directory.localeCompare(b.directory),
    );
}

export function renderInstructions(instructions: ScopedInstructions[]): string {
  return instructions
    .map(
      (item) =>
        `Repository guidance for ${item.directory || '.'}/ and descendants (deeper guidance takes precedence only in its scope):\n${item.text}`,
    )
    .join('\n\n');
}
