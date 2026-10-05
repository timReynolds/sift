import type { PublicationPort, PublicationSnapshot } from '../src/publication.ts';

export class FakePublicationPort implements PublicationPort {
  writes: string[] = [];
  data: PublicationSnapshot = {
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    open: true,
    botLogin: 'sift[bot]',
    reviews: [],
    comments: [],
    threads: [],
  };
  loseResponse = false;
  refuseApproval = false;
  omitInline = false;
  nextId = 100;

  async snapshot() {
    return structuredClone(this.data);
  }

  async createPending(body: string, head: string) {
    this.writes.push('create');
    this.data.reviews.push({
      id: this.nextId++,
      body,
      author: this.data.botLogin,
      state: 'PENDING',
      commit: head,
      url: 'https://example/review',
    });
  }

  async addInline(body: string) {
    this.writes.push('inline');

    if (this.omitInline) {
      return;
    }

    const id = this.nextId++;
    const comment = {
      id,
      body,
      author: this.data.botLogin,
      bot: true,
      updatedAt: '2026-10-04T00:00:00Z',
      url: `https://example/comments/${id}`,
      reviewId: this.data.reviews.at(-1)!.id,
      threadId: `thread-${id}`,
    };

    this.data.comments.push(comment);
    this.data.threads.push({
      id: comment.threadId,
      resolved: false,
      outdated: false,
      comments: [comment],
      owned: true,
    });

    if (this.loseResponse) {
      throw new Error('Transport lost after GitHub accepted the comment');
    }
  }

  async submit(verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body: string) {
    this.writes.push(verdict);

    if (verdict === 'APPROVE' && this.refuseApproval) {
      throw new Error('Approval not permitted');
    }

    const review = this.data.reviews.at(-1)!;
    review.body = body;
    review.state = {
      APPROVE: 'APPROVED',
      REQUEST_CHANGES: 'CHANGES_REQUESTED',
      COMMENT: 'COMMENTED',
    }[verdict];
  }

  async resolve(threadId: string) {
    this.writes.push('resolve');
    this.data.threads.find((thread) => thread.id === threadId)!.resolved = true;
  }

  async unresolve(threadId: string) {
    this.writes.push('unresolve');
    this.data.threads.find((thread) => thread.id === threadId)!.resolved = false;
  }

  async deletePending() {
    this.writes.push('delete_pending');

    const review = this.data.reviews.find((review) => review.state === 'PENDING');
    this.data.reviews = this.data.reviews.filter((item) => item.id !== review?.id);
    this.data.comments = this.data.comments.filter((item) => item.reviewId !== review?.id);
    this.data.threads = this.data.threads.filter(
      (item) => item.comments[0]?.reviewId !== review?.id,
    );
  }

  async conversationReply(body: string) {
    this.writes.push('conversation_reply');
    this.data.comments.push({
      id: this.nextId++,
      body,
      author: this.data.botLogin,
      bot: true,
      updatedAt: '2026-10-04T01:00:00Z',
      url: 'https://example/conversation-reply',
    });
  }

  async reply(commentId: number, body: string) {
    this.writes.push('reply');
    const target = this.data.threads.find((thread) =>
      thread.comments.some((comment) => comment.id === commentId),
    )!;

    const reply = {
      id: this.nextId++,
      body,
      author: this.data.botLogin,
      bot: true,
      updatedAt: '2026-10-04T01:00:00Z',
      url: 'https://example/reply',
      replyTo: commentId,
      threadId: target.id,
    };

    this.data.comments.push(reply);
    target.comments.push(reply);
  }
}
