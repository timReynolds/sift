import type { Anchor, Repository, Verdict } from './contracts.ts';
import { GitHubReadApi, mcpText, readPullContext } from './github.ts';
import type { McpCaller } from './mcp.ts';
import { InvalidAnchor, type PublicationPort, type PublicationSnapshot } from './publication.ts';

/** The official MCP server handles writes. REST only supplements incomplete read schemas. */
type PublicationOptions = {
  repository: Pick<Repository, 'owner' | 'name' | 'pullNumber'>;
  reader: McpCaller;
  writer: McpCaller;
  api: GitHubReadApi;
  botLogin: string;
  ownedThreads: Set<string>;
  signal?: AbortSignal;
};
export class GitHubPublication implements PublicationPort {
  readonly options: PublicationOptions;
  constructor(options: PublicationOptions) {
    this.options = options;
  }
  async snapshot(): Promise<PublicationSnapshot> {
    const context = await readPullContext({
      ...this.options,
      mcp: this.options.reader,
    });
    this.options.ownedThreads.clear();
    for (const thread of context.threads) {
      if (thread.owned) {
        this.options.ownedThreads.add(thread.id);
      }
    }
    return {
      head: context.revision.head,
      base: context.revision.base,
      open: context.open,
      botLogin: context.botLogin,
      reviews: context.reviews,
      threads: context.threads,
      comments: [
        ...context.comments,
        ...(context.inlineComments ?? context.threads.flatMap((thread) => thread.comments)),
      ],
    };
  }
  private async write(name: string, args: Record<string, unknown>) {
    const { repository, writer, signal } = this.options;
    const receipt = await writer.call(
      name,
      {
        owner: repository.owner,
        repo: repository.name,
        ...args,
      },
      signal,
    );
    mcpText(receipt); // MCP error payloads are failures even when the transport succeeds.
  }
  async createPending(body: string, head: string) {
    await this.write('pull_request_review_write', {
      pullNumber: this.options.repository.pullNumber,
      method: 'create',
      commitID: head,
      body,
    });
  }
  async deletePending() {
    await this.write('pull_request_review_write', {
      pullNumber: this.options.repository.pullNumber,
      method: 'delete_pending',
    });
  }
  async addInline(body: string, anchor: Anchor) {
    try {
      await this.write('add_comment_to_pending_review', {
        pullNumber: this.options.repository.pullNumber,
        body,
        path: anchor.path,
        subjectType: 'LINE',
        line: anchor.line,
        side: anchor.side,
        ...(anchor.startLine && anchor.startLine !== anchor.line
          ? {
              startLine: anchor.startLine,
              startSide: anchor.side,
            }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/422/.test(message) && /(?:line|path|diff|position)/i.test(message)) {
        throw new InvalidAnchor('GitHub rejected the line or path');
      }
      throw error;
    }
  }
  async submit(verdict: Verdict, body: string) {
    await this.write('pull_request_review_write', {
      pullNumber: this.options.repository.pullNumber,
      method: 'submit_pending',
      event: verdict,
      body,
    });
  }
  async resolve(threadId: string) {
    if (!this.options.ownedThreads.has(threadId)) {
      throw new Error('Cannot resolve an unowned thread');
    }
    await this.write('pull_request_review_write', {
      pullNumber: this.options.repository.pullNumber,
      method: 'resolve_thread',
      threadId,
    });
  }
  async reply(commentId: number, body: string) {
    await this.write('add_reply_to_pull_request_comment', {
      pullNumber: this.options.repository.pullNumber,
      commentId,
      body,
    });
  }
  async unresolve(threadId: string) {
    if (!this.options.ownedThreads.has(threadId)) {
      throw new Error('Cannot reopen an unowned thread');
    }
    await this.write('pull_request_review_write', {
      pullNumber: this.options.repository.pullNumber,
      method: 'unresolve_thread',
      threadId,
    });
  }
  async conversationReply(body: string) {
    await this.write('add_issue_comment', {
      issue_number: this.options.repository.pullNumber,
      body,
    });
  }
}
