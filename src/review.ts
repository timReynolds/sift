import {
  Anchor,
  canonical,
  digest,
  Finding,
  PRIORITY_RANK,
  type FindingRecord,
  type Policy,
  type Publication,
  type ReviewState,
  type Verdict,
} from './contracts.ts';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { ChangedFile, GitHubComment, GitHubThread, PullContext } from './github.ts';

export type FindingDecision = {
  candidateId: string;
  decision: 'accepted' | 'rejected';
  reason: string;
  issueKey?: string;
  validation?: string;
  existingFindingId?: string;
};

/** The lead decides relevance, evidence and semantic identity; the host enforces the finding contract. */
export function recordDecision(state: ReviewState, decision: FindingDecision): void {
  if (!decision.reason.trim()) {
    throw new Error('A decision requires a reason');
  }
  const candidate = state.candidates[decision.candidateId];
  if (!candidate) {
    throw new Error(`Unknown candidate ${decision.candidateId}`);
  }
  const finding = Finding.parse(candidate);
  let rejection = decision.decision === 'rejected' ? decision.reason : undefined;
  if (!finding.introducedOrExposed) {
    rejection = 'Pre-existing issue unrelated to the PR';
  }
  if (finding.confidence === 'unsupported') {
    rejection = 'Unsupported claim';
  }
  if (rejection) {
    state.candidateDecisions[decision.candidateId] = {
      decision: 'rejected',
      reason: rejection,
    };
    return;
  }
  if (!decision.validation?.trim()) {
    throw new Error('Accepted findings need a concise validation record');
  }
  if (
    finding.anchor.revision !==
    (finding.anchor.side === 'RIGHT' ? state.revision?.head : state.revision?.mergeBase)
  ) {
    throw new Error(
      'Candidate evidence belongs to an earlier comparison; investigate it again or reject it as superseded with a reason',
    );
  }
  const issueKey = (decision.issueKey ?? finding.issueKey)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (!issueKey) {
    throw new Error('An accepted finding needs an underlying issue key');
  }
  const id = decision.existingFindingId ?? `f-${digest(issueKey).slice(0, 24)}`;
  if (decision.existingFindingId && !state.findings[id]) {
    throw new Error('Cannot match an unknown earlier finding');
  }
  const existing = state.findings[id];
  if (existing?.status === 'dismissed') {
    state.candidateDecisions[decision.candidateId] = {
      decision: 'rejected',
      reason: `Previously dismissed: ${existing.reason}`,
      findingId: id,
    };
    return;
  }
  finding.id = id;
  finding.issueKey = issueKey;
  if (
    existing &&
    existing.checkedRevision === state.revision?.head &&
    existing.status === 'still_valid'
  ) {
    existing.finding.specialists = [
      ...new Set([...existing.finding.specialists, ...finding.specialists]),
    ];
    existing.finding.evidence = [
      ...new Map(
        [...existing.finding.evidence, ...finding.evidence].map((e) => [canonical(e), e]),
      ).values(),
    ];
    if (finding.confidence === 'verified' && existing.finding.confidence !== 'verified') {
      existing.finding.confidence = 'verified';
      existing.finding.priority = finding.priority;
    } else if (
      finding.confidence === existing.finding.confidence &&
      PRIORITY_RANK[finding.priority] < PRIORITY_RANK[existing.finding.priority]
    ) {
      existing.finding.priority = finding.priority;
    }
    state.candidateDecisions[decision.candidateId] = {
      decision: 'rejected',
      reason: `Merged duplicate of ${id}: ${decision.reason}`,
      findingId: id,
    };
    return;
  }
  state.findings[id] = {
    finding,
    decision: 'accepted',
    reason: `${decision.reason}\nValidation: ${decision.validation}`,
    status: 'still_valid',
    checkedRevision: state.revision?.head,
    ...(existing?.github
      ? {
          github: existing.github,
        }
      : {}),
  };
  state.candidateDecisions[decision.candidateId] = {
    decision: 'accepted',
    reason: decision.reason,
    findingId: id,
  };
}

export function coverageGaps(state: ReviewState, profiles: string[]): string[] {
  const gaps = [...state.gaps];
  if (!state.scope) {
    gaps.push('Lead has not chosen review scope');
  }
  if (!state.coverage?.complete || state.coverage.head !== state.revision?.head) {
    gaps.push('Lead coverage is incomplete for the current revision');
  }
  for (const name of profiles) {
    const selection = state.selected[name];
    if (!selection) {
      gaps.push(`No selection decision for ${name}`);
    } else if (selection.error || selection.status === 'failed') {
      gaps.push(`${name}: ${selection.error ?? 'investigation failed'}`);
    } else if (selection.selected && selection.status !== 'completed') {
      gaps.push(`${name}: investigation ${selection.status}`);
    }
  }
  for (const id of Object.keys(state.candidates)) {
    if (!state.candidateDecisions[id]) {
      gaps.push(`Candidate ${id} has no lead decision`);
    }
  }
  for (const [key, message] of Object.entries(state.importedMessages)) {
    if (!message.answered && !message.replyBody && !message.disposition) {
      gaps.push(`Human message ${key} needs a response or disposition`);
    }
  }
  for (const [id, record] of Object.entries(state.findings)) {
    if (
      record.decision === 'accepted' &&
      (record.status === 'needs_investigation' ||
        (record.status === 'still_valid' && record.checkedRevision !== state.revision?.head))
    ) {
      gaps.push(`Outstanding finding ${id} needs rechecking`);
    }
  }
  return [...new Set(gaps)];
}

export function verdictFor(state: ReviewState, policy: Policy, profiles: string[]): Verdict {
  const active = Object.values(state.findings).filter(
    (record) =>
      record.decision === 'accepted' &&
      ['still_valid', 'needs_investigation'].includes(record.status),
  );
  const blockers = active.filter(
    (record) =>
      record.finding.confidence === 'verified' &&
      PRIORITY_RANK[record.finding.priority] <= PRIORITY_RANK[policy.blockThrough],
  );
  if (blockers.length && policy.mode === 'enforcing') {
    return 'REQUEST_CHANGES';
  }
  if (active.length || coverageGaps(state, profiles).length) {
    return 'COMMENT';
  }
  return 'APPROVE';
}

/** Only actual diff lines are valid anchors. Missing/truncated patches take the summary path. */
export function anchorValid(finding: Finding, context: PullContext): boolean {
  if (!Anchor.safeParse(finding.anchor).success) {
    return false;
  }
  const anchor = finding.anchor;
  if (
    anchor.revision !==
    (anchor.side === 'RIGHT' ? context.revision.head : context.revision.mergeBase)
  ) {
    return false;
  }
  const file = context.files.find(
    (file) =>
      file.filename === anchor.path ||
      (anchor.side === 'LEFT' && file.previous_filename === anchor.path),
  );
  if (!file?.patch) {
    return false;
  }
  const lines = patchLines(file);
  const side = anchor.side === 'RIGHT' ? lines.right : lines.left;
  for (let line = anchor.startLine ?? anchor.line; line <= anchor.line; line++) {
    if (!side.has(line)) {
      return false;
    }
  }
  return true;
}

export function patchLines(file: ChangedFile): {
  left: Set<number>;
  right: Set<number>;
} {
  const left = new Set<number>();
  const right = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of file.patch?.split('\n') ?? []) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\')) {
      continue;
    }
    if (line.startsWith('+')) {
      right.add(newLine++);
    } else if (line.startsWith('-')) {
      left.add(oldLine++);
    } else if (line.startsWith(' ')) {
      left.add(oldLine++);
      right.add(newLine++);
    } else {
      inHunk = false;
    }
  }
  return {
    left,
    right,
  };
}

export const findingMarker = (id: string) => `<!-- sift:finding:${id} -->`;
export const batchMarker = (id: string) => `<!-- sift:batch:${id} -->`;
const Recovery = z.object({
  version: z.literal(1),
  head: z.string(),
  findings: z.array(
    z.object({
      finding: Finding,
      reason: z.string(),
      status: z.string(),
      dismissal: z
        .object({
          by: z.string(),
          sourceId: z.string(),
          reason: z.string(),
        })
        .optional(),
    }),
  ),
});
export function publicationBody(state: ReviewState, plan: Publication): string {
  const data = Recovery.parse({
    version: 1,
    head: plan.head,
    findings: Object.values(state.findings).filter((record) => record.decision === 'accepted'),
  });
  const recovery = gzipSync(Buffer.from(JSON.stringify(data))).toString('base64url');
  const body = `${batchMarker(plan.id)}\n${plan.summary}\n\n<!-- sift:review-data:${recovery} -->`;
  if (body.length > 65000) {
    throw new Error(
      'Review recovery record exceeds GitHub body capacity; findings remain saved locally and must not be silently dropped',
    );
  }
  return body;
}
export function codeLink(finding: Finding, context: PullContext): string {
  const path = finding.anchor.path.split('/').map(encodeURIComponent).join('/');
  const lines = `L${finding.anchor.startLine ?? finding.anchor.line}${finding.anchor.startLine ? `-L${finding.anchor.line}` : ''}`;
  return `https://github.com/${context.repository.owner}/${context.repository.name}/blob/${finding.anchor.revision}/${path}#${lines}`;
}

export function findingBody(record: FindingRecord): string {
  const finding = record.finding;
  const evidence = finding.evidence
    .map((item) => `- ${item.detail}${item.result ? ` (${item.result})` : ''}`)
    .join('\n');
  const replacement = finding.suggestion?.replacement;
  const fence = '`'.repeat(
    Math.max(3, ...[...(replacement ?? '').matchAll(/`+/g)].map((match) => match[0].length + 1)),
  );
  const suggestion =
    finding.suggestion?.complete && finding.anchor.side === 'RIGHT'
      ? `\n\n${fence}suggestion\n${replacement}\n${fence}`
      : '';
  // The recovery record contains public findings and evidence, never transcripts or hidden reasoning.
  const metadata = Buffer.from(
    JSON.stringify({
      version: 1,
      finding,
    }),
  ).toString('base64url');
  return `${findingMarker(finding.id)}\n**[${finding.priority}] ${finding.title}**\n\n${finding.explanation}\n\nImpact: ${finding.impact}${finding.scenario ? `\n\nScenario: ${finding.scenario}` : ''}\n\nEvidence:\n${evidence}${suggestion}\n\n<!-- sift:data:${metadata} -->`;
}

export function recoverFindings(state: ReviewState, context: PullContext): void {
  // Recover summary-only and deferred findings too: inline threads are not the entire review.
  const latest = new Map<
    string,
    {
      record: z.infer<typeof Recovery>['findings'][number];
      reviewId: number;
    }
  >();
  const knownReviews = new Set(
    Object.values(state.publications).map((publication) => publication.reviewId),
  );
  for (const review of [...context.reviews].sort((a, b) => a.id - b.id)) {
    if (
      review.author.toLowerCase() !== context.botLogin.toLowerCase() ||
      !review.body.includes('<!-- sift:batch:')
    ) {
      continue;
    }
    const encoded = /<!-- sift:review-data:([A-Za-z0-9_-]+) -->/.exec(review.body)?.[1];
    if (!encoded) {
      state.gaps.push(
        `Sift review ${review.id} has no recovery record; inspect its summary before declaring coverage`,
      );
      continue;
    }
    try {
      const data = Recovery.parse(
        JSON.parse(
          gunzipSync(Buffer.from(encoded, 'base64url'), {
            maxOutputLength: 10 * 1024 * 1024,
          }).toString(),
        ),
      );
      for (const record of data.findings) {
        latest.set(record.finding.id, {
          record,
          reviewId: review.id,
        });
      }
    } catch {
      state.gaps.push(`Sift review ${review.id} has invalid recovery metadata`);
    }
  }
  for (const [id, { record, reviewId }] of latest) {
    if (
      !state.findings[id] ||
      !knownReviews.has(reviewId) ||
      (record.status === 'dismissed' && record.dismissal)
    ) {
      if (state.findings[id]?.status === 'dismissed') {
        continue;
      }
      const github = state.findings[id]?.github;
      state.findings[id] = {
        ...record,
        decision: 'accepted',
        status:
          record.status === 'dismissed' && record.dismissal ? 'dismissed' : 'needs_investigation',
        ...(github
          ? {
              github,
            }
          : {}),
        reason:
          record.status === 'dismissed'
            ? record.reason
            : `Recovered from GitHub; recheck required. ${record.reason}`,
      };
    }
  }
  const roots: Array<{
    root: GitHubComment | undefined;
    thread?: GitHubThread;
  }> = context.threads
    .filter((thread) => thread.owned)
    .map((thread) => ({
      root: thread.comments[0],
      thread,
    }));
  for (const comment of context.inlineComments ?? []) {
    if (
      !comment.replyTo &&
      !roots.some((item) => item.root?.id === comment.id) &&
      comment.author.toLowerCase() === context.botLogin.toLowerCase() &&
      comment.body.includes('<!-- sift:finding:')
    ) {
      roots.push({
        root: comment,
      });
    }
  }
  for (const { root, thread } of roots) {
    if (!root || root.author.toLowerCase() !== context.botLogin.toLowerCase()) {
      continue;
    }
    const marker = /<!-- sift:finding:([a-zA-Z0-9_-]+) -->/.exec(root.body)?.[1];
    const encoded = /<!-- sift:data:([A-Za-z0-9_-]+) -->/.exec(root.body)?.[1];
    if (!marker || !encoded) {
      state.gaps.push(`Sift comment ${root.id} has no recoverable finding metadata`);
      continue;
    }
    try {
      const data = JSON.parse(Buffer.from(encoded, 'base64url').toString());
      if (data.version !== 1) {
        throw new Error('Unsupported finding metadata');
      }
      const finding = Finding.parse(data.finding);
      if (finding.id !== marker) {
        throw new Error('Marker identity mismatch');
      }
      if (!state.findings[marker]) {
        state.findings[marker] = {
          finding,
          decision: 'accepted',
          reason: 'Recovered from GitHub; recheck required',
          status: 'needs_investigation',
        };
      }
      state.findings[marker]!.github = {
        commentId: root.id,
        ...(thread
          ? {
              threadId: thread.id,
            }
          : {}),
        ...(root.reviewId
          ? {
              reviewId: root.reviewId,
            }
          : {}),
        url: root.url,
      };
    } catch {
      state.gaps.push(`Sift comment ${root.id} contains invalid recovery metadata`);
    }
  }
  state.gaps = [...new Set(state.gaps)];
}

export function reviewPlan(
  state: ReviewState,
  context: PullContext,
  policy: Policy,
  profiles: string[],
  conclusion: string,
): Publication {
  const verdict = verdictFor(state, policy, profiles);
  const active = Object.values(state.findings).filter(
    (record) => record.decision === 'accepted' && record.status === 'still_valid',
  );
  const eligible = active
    .filter(
      (record) => PRIORITY_RANK[record.finding.priority] <= PRIORITY_RANK[policy.publishThrough],
    )
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.finding.priority] - PRIORITY_RANK[b.finding.priority] ||
        a.finding.id.localeCompare(b.finding.id),
    );
  const anchored = eligible.filter((record) => anchorValid(record.finding, context));
  const findings = anchored.slice(0, policy.maxInlineComments).map((record) => record.finding.id);
  const unanchored = eligible
    .filter((record) => !anchorValid(record.finding, context))
    .map((record) => record.finding.id);
  const deferred = active
    .filter(
      (record) => !findings.includes(record.finding.id) && !unanchored.includes(record.finding.id),
    )
    .map((record) => record.finding.id);
  const gaps = coverageGaps(state, profiles);
  const details = [...unanchored, ...deferred].map((id) => {
    const finding = state.findings[id]!.finding;
    return `- [${finding.priority}] ${finding.title} — [${finding.anchor.path}](${codeLink(finding, context)}): ${finding.explanation}${unanchored.includes(id) ? ' (No valid inline anchor.)' : ' (Deferred by publication threshold or comment limit.)'}`;
  });
  const summary = `${conclusion}\n\nReviewed ${context.revision.head} against ${context.revision.baseRef} (${context.revision.base}; merge base ${context.revision.mergeBase}).\nVerdict: ${verdict}.${gaps.length ? `\n\nIncomplete coverage:\n${gaps.map((gap) => `- ${gap}`).join('\n')}` : ''}${details.length ? `\n\nAdditional findings:\n${details.join('\n')}` : ''}`;
  const id = `b-${digest(
    canonical({
      head: context.revision.head,
      base: context.revision.base,
      verdict,
      findings,
      unanchored,
      deferred,
      summary,
    }),
  ).slice(0, 24)}`;
  return {
    id,
    head: context.revision.head,
    base: context.revision.base,
    verdict,
    summary,
    findings,
    unanchored,
    deferred,
    posted: {},
    status: 'planned',
  };
}
