import type { Anchor, Publication, ReviewState, Verdict } from './contracts.ts';
import type { GitHubComment, GitHubReview, GitHubThread } from './github.ts';
import { batchMarker, findingBody, findingMarker, publicationBody } from './review.ts';

export type PublicationSnapshot = {
  head: string;
  base: string;
  open: boolean;
  botLogin: string;
  reviews: GitHubReview[];
  comments: GitHubComment[];
  threads: GitHubThread[];
};
export type PublicationPort = {
  snapshot(): Promise<PublicationSnapshot>;
  createPending(body: string, head: string): Promise<void>;
  addInline(body: string, anchor: Anchor): Promise<void>;
  submit(verdict: Verdict, body: string): Promise<void>;
  resolve(threadId: string): Promise<void>;
  reply(commentId: number, body: string): Promise<void>;
  conversationReply?(body: string): Promise<void>;
  deletePending?(): Promise<void>;
  unresolve?(threadId: string): Promise<void>;
};
export class InvalidAnchor extends Error {}
export type SaveState = () => Promise<void>;

function current(snapshot: PublicationSnapshot, plan: Publication): void {
  if (!snapshot.open || snapshot.head !== plan.head || snapshot.base !== plan.base) {
    plan.status = 'stale';
    throw new Error('PR changed before publication; stale review suppressed');
  }
}
function ownReview(snapshot: PublicationSnapshot, plan: Publication) {
  return snapshot.reviews.find(
    (review) =>
      review.author.toLowerCase() === snapshot.botLogin.toLowerCase() &&
      review.body.includes(batchMarker(plan.id)),
  );
}
function ownComment(snapshot: PublicationSnapshot, findingId: string) {
  return snapshot.comments.find(
    (comment) =>
      comment.author.toLowerCase() === snapshot.botLogin.toLowerCase() &&
      comment.body.includes(findingMarker(findingId)),
  );
}
function reconcile(state: ReviewState, plan: Publication, snapshot: PublicationSnapshot): void {
  const review = ownReview(snapshot, plan);
  if (review) {
    plan.reviewId = review.id;
  }
  for (const id of plan.findings) {
    const comment = ownComment(snapshot, id);
    if (!comment) {
      continue;
    }
    plan.posted[id] = comment.id;
    const thread = snapshot.threads.find(
      (thread) => thread.owned && thread.comments.some((item) => item.id === comment.id),
    );
    const record = state.findings[id];
    if (record) {
      record.github = {
        commentId: comment.id,
        ...(thread
          ? {
              threadId: thread.id,
            }
          : {}),
        ...(comment.reviewId
          ? {
              reviewId: comment.reviewId,
            }
          : {}),
        url: comment.url,
      };
    }
  }
}
const submittedState: Record<Verdict, string> = {
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
  COMMENT: 'COMMENTED',
};

/** Every write has a persisted intent and an authoritative readback. No non-idempotent write is blindly retried. */
export async function publishReview(
  state: ReviewState,
  plan: Publication,
  port: PublicationPort,
  save: SaveState,
  dryRun = false,
): Promise<Publication> {
  state.publications[plan.id] = plan;
  await save();
  if (dryRun) {
    return plan;
  }
  try {
    let snapshot = await port.snapshot();
    current(snapshot, plan);
    reconcile(state, plan, snapshot);
    let review = ownReview(snapshot, plan);
    if (review && review.state !== 'PENDING') {
      if (
        review.state !== submittedState[plan.verdict] ||
        review.commit !== plan.head ||
        plan.findings.some((id) => !plan.posted[id])
      ) {
        throw new Error(
          'Previously submitted review does not match the expected verdict, revision, or inline comments',
        );
      }
      plan.status = 'submitted';
      await save();
      return plan;
    }
    if (!review) {
      const pending = snapshot.reviews.find(
        (review) =>
          review.author.toLowerCase() === snapshot.botLogin.toLowerCase() &&
          review.state === 'PENDING',
      );
      if (pending) {
        if (!/<!-- sift:batch:b-[a-f0-9]+ -->/.test(pending.body) || !port.deletePending) {
          throw new Error(
            `Pending review ${pending.id} belongs to a different publication; reconcile it before creating another`,
          );
        }
        // Context collection imported the previous pending comments before this replacement.
        // A pending review is private to this bot; replace its obsolete intent, then read back.
        await port.deletePending();
        snapshot = await port.snapshot();
        current(snapshot, plan);
        if (snapshot.reviews.some((item) => item.id === pending.id)) {
          throw new Error('Superseded pending review deletion was not confirmed');
        }
        for (const id of plan.findings) {
          if (!ownComment(snapshot, id)) {
            delete plan.posted[id];
          }
        }
      }
      let writeError: unknown;
      try {
        await port.createPending(publicationBody(state, plan), plan.head);
      } catch (error) {
        writeError = error;
      }
      snapshot = await port.snapshot();
      current(snapshot, plan);
      reconcile(state, plan, snapshot);
      review = ownReview(snapshot, plan);
      if (!review || review.state !== 'PENDING') {
        throw new Error(
          `Pending review was not confirmed${writeError instanceof Error ? `: ${writeError.message}` : ''}`,
        );
      }
    }
    plan.status = 'pending';
    await save();
    for (const id of [...plan.findings]) {
      snapshot = await port.snapshot();
      current(snapshot, plan);
      reconcile(state, plan, snapshot);
      if (plan.posted[id]) {
        continue;
      }
      const record = state.findings[id];
      if (!record || record.status !== 'still_valid' || record.checkedRevision !== plan.head) {
        throw new Error(`Finding ${id} is not validated for this revision`);
      }
      let writeError: unknown;
      try {
        await port.addInline(findingBody(record), record.finding.anchor);
      } catch (error) {
        writeError = error;
      }
      snapshot = await port.snapshot();
      current(snapshot, plan);
      reconcile(state, plan, snapshot);
      if (!plan.posted[id] && writeError instanceof InvalidAnchor) {
        const finding = record.finding;
        const repository = state.identity;
        if (!repository) {
          throw new Error('Cannot create a precise code link without repository identity');
        }
        const url = `https://github.com/${repository.owner}/${repository.name}/blob/${finding.anchor.revision}/${finding.anchor.path.split('/').map(encodeURIComponent).join('/')}#L${finding.anchor.startLine ?? finding.anchor.line}${finding.anchor.startLine ? `-L${finding.anchor.line}` : ''}`;
        plan.findings = plan.findings.filter((item) => item !== id);
        plan.unanchored.push(id);
        plan.summary += `\n\n[${finding.priority}] ${finding.title} — [${finding.anchor.path}](${url}): ${finding.explanation}\nGitHub rejected this inline anchor; the finding remains active.`;
      } else if (!plan.posted[id]) {
        throw new Error(
          `Inline finding ${id} was not confirmed${writeError instanceof Error ? `: ${writeError.message}` : ''}`,
        );
      }
      await save();
    }
    snapshot = await port.snapshot();
    current(snapshot, plan);
    reconcile(state, plan, snapshot);
    if (plan.findings.some((id) => !plan.posted[id])) {
      throw new Error('Expected inline comments are missing before review submission');
    }
    let writeError: unknown;
    try {
      await port.submit(plan.verdict, publicationBody(state, plan));
    } catch (error) {
      writeError = error;
    }
    snapshot = await port.snapshot();
    // A race after the last preflight cannot be made atomic with GitHub; report it explicitly.
    current(snapshot, plan);
    reconcile(state, plan, snapshot);
    review = ownReview(snapshot, plan);
    if (!review || review.state !== submittedState[plan.verdict] || review.commit !== plan.head) {
      throw new Error(
        `${plan.verdict} publication was not confirmed${writeError instanceof Error ? `: ${writeError.message}` : ''}`,
      );
    }
    if (plan.findings.some((id) => !ownComment(snapshot, id))) {
      throw new Error('Submitted review is missing expected inline comments');
    }
    plan.status = 'submitted';
    await save();
    return plan;
  } catch (error) {
    if (plan.status !== 'stale') {
      plan.status = 'failed';
    }
    plan.error = error instanceof Error ? error.message : String(error);
    await save();
    throw error;
  }
}

export async function resolveFinding(
  state: ReviewState,
  findingId: string,
  port: PublicationPort,
  save: SaveState,
  dryRun = false,
): Promise<void> {
  const record = state.findings[findingId];
  if (
    !record ||
    !['fixed', 'disproven', 'superseded', 'dismissed'].includes(record.status) ||
    record.checkedRevision !== state.revision?.head
  ) {
    throw new Error('Finding must be rechecked at the current head before resolution');
  }
  const threadId = record.github?.threadId;
  if (!threadId) {
    throw new Error('Finding has no reconciled GitHub thread');
  }
  const snapshot = await port.snapshot();
  if (snapshot.head !== state.revision?.head || snapshot.base !== state.revision?.base) {
    throw new Error('PR changed before thread resolution');
  }
  const thread = snapshot.threads.find((thread) => thread.id === threadId && thread.owned);
  if (!thread) {
    throw new Error('Only Sift-owned threads can be resolved');
  }
  if (dryRun || thread.resolved) {
    return;
  }
  await save();
  let failure: unknown;
  try {
    await port.resolve(threadId);
  } catch (error) {
    failure = error;
  }
  const confirmed = (await port.snapshot()).threads.find((thread) => thread.id === threadId);
  if (!confirmed?.resolved) {
    throw new Error(
      `Thread resolution was not confirmed${failure instanceof Error ? `: ${failure.message}` : ''}`,
    );
  }
  await save();
}

export async function reopenFinding(
  state: ReviewState,
  findingId: string,
  port: PublicationPort,
  save: SaveState,
  dryRun = false,
): Promise<void> {
  const record = state.findings[findingId];
  const threadId = record?.github?.threadId;
  if (
    !threadId ||
    record?.status !== 'still_valid' ||
    record.checkedRevision !== state.revision?.head
  ) {
    throw new Error('Only a revalidated active finding can reopen its own thread');
  }
  const snapshot = await port.snapshot();
  if (snapshot.head !== state.revision?.head || snapshot.base !== state.revision?.base) {
    throw new Error('PR changed before thread reopening');
  }
  const thread = snapshot.threads.find((thread) => thread.id === threadId && thread.owned);
  if (!thread) {
    throw new Error('Only Sift-owned threads can be reopened');
  }
  if (!thread.resolved || dryRun) {
    return;
  }
  if (!port.unresolve) {
    throw new Error('Active finding remains in a resolved thread; reopening is unsupported');
  }
  await save();
  let failure: unknown;
  try {
    await port.unresolve(threadId);
  } catch (error) {
    failure = error;
  }
  const confirmed = (await port.snapshot()).threads.find((thread) => thread.id === threadId);
  if (!confirmed || confirmed.resolved) {
    throw new Error(
      `Thread reopening was not confirmed${failure instanceof Error ? `: ${failure.message}` : ''}`,
    );
  }
  await save();
}

export async function answerReply(
  state: ReviewState,
  sourceKey: string,
  rootCommentId: number,
  body: string,
  port: PublicationPort,
  save: SaveState,
  dryRun = false,
): Promise<void> {
  const imported = state.importedMessages[sourceKey];
  if (!imported) {
    throw new Error('Reply was not durably imported');
  }
  const marker = `<!-- sift:reply:${Buffer.from(sourceKey).toString('base64url')} -->`;
  const find = (snapshot: PublicationSnapshot) =>
    snapshot.comments.find(
      (comment) =>
        comment.author.toLowerCase() === snapshot.botLogin.toLowerCase() &&
        comment.body.includes(marker),
    );
  let snapshot = await port.snapshot();
  const target = snapshot.threads.find((thread) =>
    thread.comments.some((comment) => comment.id === rootCommentId),
  );
  if (
    !target &&
    !snapshot.comments.some((comment) => comment.id === rootCommentId && !comment.replyTo)
  ) {
    throw new Error('Reply target is not in this PR');
  }
  let existing = find(snapshot);
  if (existing) {
    imported.answered = true;
    imported.replyId = existing.id;
    await save();
    return;
  }
  if (dryRun) {
    return;
  }
  await save();
  let failure: unknown;
  try {
    if (target) {
      await port.reply(target.comments[0]!.id, `${body}\n\n${marker}`);
    } else if (port.conversationReply) {
      await port.conversationReply(`${body}\n\n${marker}`);
    } else {
      throw new Error('Conversation reply publication is unavailable');
    }
  } catch (error) {
    failure = error;
  }
  snapshot = await port.snapshot();
  existing = find(snapshot);
  if (!existing) {
    throw new Error(
      `Reply was not confirmed${failure instanceof Error ? `: ${failure.message}` : ''}`,
    );
  }
  imported.answered = true;
  imported.replyId = existing.id;
  await save();
}
