import { appendFile } from 'node:fs/promises';
import type { ReviewResult } from './engine.ts';
import { PersistedRunFailure } from './persistence.ts';

export async function writeOutputs(
  result: ReviewResult | Error,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const failed = result instanceof Error;
  const values: Record<string, unknown> = failed
    ? {
        status: 'failed',
        'operational-status': 'failed',
        'persistence-status':
          result instanceof PersistedRunFailure ? result.persistence : 'not-attempted',
        'publication-status': 'not-confirmed',
      }
    : result.status === 'skipped'
      ? {
          status: 'skipped',
          'operational-status': 'successful',
          'persistence-status': 'not-attempted',
          'publication-status': 'not-attempted',
          reason: result.reason,
        }
      : {
          status: result.status,
          'operational-status': 'successful',
          'reviewed-revision': result.revision,
          verdict: result.verdict,
          'publication-status': result.publication,
          'persistence-status': result.persistence,
          'selected-agents': result.selected,
          'skipped-agents': result.skipped,
          'failed-agents': result.failed,
          findings: result.findings,
          usage: result.usage,
          'coverage-gaps': result.gaps,
        };
  if (env.GITHUB_OUTPUT) {
    await appendFile(
      env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(
          ([key, value]) =>
            `${key}=${typeof value === 'string' ? value.replaceAll('\n', ' ') : JSON.stringify(value)}\n`,
        )
        .join(''),
    );
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const lines = failed
      ? [
          `Sift operational failure. Persistence: ${values['persistence-status']}. No review success is implied.`,
        ]
      : result.status === 'skipped'
        ? [`Sift skipped: ${result.reason}`]
        : [
            `Sift reviewed \`${result.revision}\`.`,
            `Verdict: **${result.verdict}**. Publication: **${result.publication}**. Persistence: **${result.persistence}**.`,
            `Selected: ${result.selected.join(', ') || 'none'}. Skipped: ${result.skipped.map((agent) => agent.name).join(', ') || 'none'}. Failed: ${result.failed.map((agent) => agent.name).join(', ') || 'none'}.`,
            `Accepted active findings: ${Object.entries(result.findings)
              .map(([priority, count]) => `${priority}: ${count}`)
              .join(', ')}. Coverage gaps: ${result.gaps.length}.`,
            `Measured cumulative session usage: ${JSON.stringify(result.usage)}.`,
          ];
    await appendFile(env.GITHUB_STEP_SUMMARY, `${lines.join('\n\n')}\n`);
  }
}
