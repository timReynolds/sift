import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPATIBILITY } from './contracts.ts';
import { hostCommand } from './workspaces.ts';

// Release checksums retrieved from GitHub's v1.14.0 assets and kept with the pin.
const RELEASES: Record<
  string,
  {
    archive: string;
    sha256: string;
  }
> = {
  'darwin-arm64': {
    archive: 'github-mcp-server_Darwin_arm64.tar.gz',
    sha256: 'e3baa88424ecc24ae504a1c98c128823fc2c2edbe9dd64e1456f39edea701140',
  },
  'darwin-x64': {
    archive: 'github-mcp-server_Darwin_x86_64.tar.gz',
    sha256: '82c84d005eaef04755295e1bf0118766f59ef39196bf8142e58b5aca9e16c6ac',
  },
  'linux-arm64': {
    archive: 'github-mcp-server_Linux_arm64.tar.gz',
    sha256: 'dd06beb81e62c42afa2d4217d86be79ca588a083f63da38ca3cbef0b7785e88d',
  },
  'linux-x64': {
    archive: 'github-mcp-server_Linux_x86_64.tar.gz',
    sha256: '2fcad56bb164b6c4918fdd9f1d5572257bf4e1f14b7eb1119d015b079818fd38',
  },
};
export async function installGitHubMcp(directory: string, signal?: AbortSignal): Promise<string> {
  const release = RELEASES[`${process.platform}-${process.arch}`];
  if (!release) {
    throw new Error(
      'Supported runners are Linux/macOS x64/arm64; provide an explicitly installed MCP binary on other platforms',
    );
  }
  const response = await fetch(
    `https://github.com/github/github-mcp-server/releases/download/v${COMPATIBILITY.githubMcp}/${release.archive}`,
    {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub MCP download failed (${response.status})`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== release.sha256) {
    throw new Error('GitHub MCP release checksum mismatch');
  }
  await mkdir(directory, {
    recursive: true,
  });
  const path = join(directory, release.archive);
  await writeFile(path, archive);
  await hostCommand('tar', ['-xzf', path, '-C', directory, 'github-mcp-server'], {
    env: {
      PATH: process.env.PATH,
    },
    signal,
  });
  const binary = join(directory, 'github-mcp-server');
  await chmod(binary, 0o755);
  return binary;
}
