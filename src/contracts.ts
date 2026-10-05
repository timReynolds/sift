import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PRODUCT = {
  name: 'Sift',
  marker: 'sift',
  schemaVersion: 1,
} as const;
export const COMPATIBILITY = {
  pi: '1.0.2',
  githubMcp: '1.14.0',
  state: 1,
  artifact: 1,
} as const;

export const Sha = z.string().regex(/^[a-f0-9]{40}$/i, 'Expected a full Git commit SHA');
export const RepoPath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every((part) => part !== '..' && part !== '.' && part !== ''),
    'Expected a repository-relative path without traversal',
  );
export const StableName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const Priority = z.enum(['P0', 'P1', 'P2', 'P3']);
export type Priority = z.infer<typeof Priority>;
export const PRIORITY_RANK: Record<Priority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};
export const Reasoning = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export const Model = z.string().regex(/^[^/\s]+\/[^\s]+$/, 'Use provider/model-id');
export function modelRef(value: string) {
  Model.parse(value);
  const separator = value.indexOf('/');
  return {
    provider: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}

export const Repository = z
  .object({
    id: z.string().regex(/^\d+$/),
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    pullNumber: z.number().int().positive(),
  })
  .strict();
export type Repository = z.infer<typeof Repository>;

export const Revision = z
  .object({
    base: Sha,
    head: Sha,
    mergeBase: Sha,
    baseRef: z.string().min(1),
    headRef: z.string().min(1),
  })
  .strict();
export type Revision = z.infer<typeof Revision>;

export const Anchor = z
  .object({
    path: RepoPath,
    revision: Sha,
    side: z.enum(['LEFT', 'RIGHT']),
    line: z.number().int().positive(),
    startLine: z.number().int().positive().optional(),
  })
  .strict()
  .refine((a) => a.startLine === undefined || a.startLine <= a.line, 'Invalid line range');
export type Anchor = z.infer<typeof Anchor>;

export const Finding = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    issueKey: z.string().min(1).max(500),
    specialists: z.array(StableName).min(1),
    category: z.enum(['correctness', 'security', 'tests', 'infrastructure', 'other']),
    title: z.string().min(1).max(200),
    explanation: z.string().min(1),
    anchor: Anchor,
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(['code', 'reproduction', 'test', 'trace']),
            detail: z.string().min(1),
            command: z.string().optional(),
            result: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    impact: z.string().min(1),
    scenario: z.string().optional(),
    priority: Priority,
    confidence: z.enum(['unsupported', 'plausible', 'verified']),
    introducedOrExposed: z.boolean(),
    suggestion: z
      .object({
        replacement: z.string(),
        complete: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Finding = z.infer<typeof Finding>;

export const Policy = z
  .object({
    mode: z.enum(['enforcing', 'advisory']).default('enforcing'),
    publishThrough: Priority.default('P2'),
    blockThrough: Priority.default('P1'),
    maxInlineComments: z.number().int().positive().default(30),
    drafts: z.enum(['skip', 'review']).default('skip'),
  })
  .strict();
export type Policy = z.infer<typeof Policy>;
export type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export type FindingStatus =
  | 'needs_investigation'
  | 'still_valid'
  | 'fixed'
  | 'disproven'
  | 'superseded'
  | 'dismissed';
export type FindingRecord = {
  finding: Finding;
  decision: 'accepted' | 'rejected';
  reason: string;
  status: FindingStatus;
  checkedRevision?: string;
  dismissal?: {
    by: string;
    sourceId: string;
    reason: string;
  };
  github?: {
    commentId: number;
    threadId?: string;
    reviewId?: number;
    url: string;
  };
};
export type Selection = {
  name: string;
  selected: boolean;
  reason: string;
  status: 'skipped' | 'pending' | 'running' | 'completed' | 'failed';
  conversationId?: number;
  error?: string;
};
export type WorkspaceArtifact = {
  version: 1;
  workspaceId: string;
  specialist: string;
  baseCommit: string;
  object: string;
  sha256: string;
  required: boolean;
};
export type Publication = {
  id: string;
  head: string;
  base: string;
  verdict: Verdict;
  summary: string;
  findings: string[];
  posted: Record<string, number>;
  unanchored: string[];
  deferred: string[];
  status: 'planned' | 'pending' | 'submitted' | 'stale' | 'failed';
  reviewId?: number;
  error?: string;
};
export type ReviewState = {
  version: 1;
  identity?: Repository;
  compatibility?: {
    pi: string;
    githubMcp: string;
    configHash: string;
    trustedRevision: string;
  };
  revision?: Revision;
  scope?: {
    kind: 'full' | 'targeted';
    reason: string;
  };
  selected: Record<string, Selection>;
  candidates: Record<string, Finding>;
  candidateDecisions: Record<
    string,
    {
      decision: 'accepted' | 'rejected';
      reason: string;
      findingId?: string;
    }
  >;
  coverage?: {
    complete: boolean;
    summary: string;
    head: string;
  };
  findings: Record<string, FindingRecord>;
  publications: Record<string, Publication>;
  importedMessages: Record<
    string,
    {
      requestId: string;
      answered: boolean;
      replyId?: number;
      disposition?: string;
      replyBody?: string;
      targetId?: number;
    }
  >;
  reviewedRevisions: Array<{
    revision: Revision;
    coverageComplete: boolean;
    verdict: Verdict;
  }>;
  artifacts: Record<string, WorkspaceArtifact>;
  gaps: string[];
};
export const emptyReviewState = (): ReviewState => ({
  version: 1,
  selected: {},
  candidates: {},
  candidateDecisions: {},
  findings: {},
  publications: {},
  importedMessages: {},
  reviewedRevisions: [],
  artifacts: {},
  gaps: [],
});

/** Stable across owner/repository renames and head revisions. */
export function stateKey(repository: Repository): string {
  const parsed = Repository.parse(repository);
  return `repositories/${parsed.id}/pulls/${parsed.pullNumber}/session.sqlite`;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Canonical JSON for version/configuration identity, independent of YAML key order. */
export function canonical(value: unknown): string {
  if (value === undefined) {
    throw new Error('Undefined is not canonical JSON');
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
