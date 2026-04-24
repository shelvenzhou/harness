import type { HarnessEvent } from '@harness/core/events.js';
import type { SamplingRequest } from '@harness/llm/provider.js';
import type { ThreadId, TurnId } from '@harness/core/ids.js';

import type { DiagSink } from './types.js';

/**
 * Stderr diag sink — one concise line per interesting event.
 *
 * Writes to stderr so it doesn't mix with the REPL's stdout. Two verbosity
 * levels:
 *   - 'summary' (default): sampling_complete, tool_call, tool_result, turn_complete.
 *   - 'verbose': adds reply/preamble/reasoning (truncated).
 */
export interface StderrDiagSinkOptions {
  level?: 'summary' | 'verbose';
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export class StderrDiagSink implements DiagSink {
  readonly id = 'stderr';
  private readonly level: NonNullable<StderrDiagSinkOptions['level']>;

  constructor(opts: StderrDiagSinkOptions = {}) {
    this.level = opts.level ?? 'summary';
  }

  async onPrompt(
    ctx: { threadId: ThreadId; turnId: TurnId; samplingIndex: number },
    _request: SamplingRequest,
    stats: {
      projectedItems: number;
      elidedCount: number;
      estimatedTokens: number;
      pinnedHandles: number;
    },
  ): Promise<string | undefined> {
    process.stderr.write(
      `${DIM}[diag] → sample #${ctx.samplingIndex} turn=${ctx.turnId} items=${stats.projectedItems} est=${stats.estimatedTokens}tok elided=${stats.elidedCount} pinned=${stats.pinnedHandles}${RESET}\n`,
    );
    return undefined;
  }

  onEvent(event: HarnessEvent): void {
    switch (event.kind) {
      case 'sampling_complete': {
        const p = event.payload;
        process.stderr.write(
          `${DIM}[diag] ← sample #${p.samplingIndex} ${p.wallMs}ms` +
            (p.ttftMs !== undefined ? ` ttft=${p.ttftMs}ms` : '') +
            ` prompt=${p.promptTokens} cached=${p.cachedPromptTokens} completion=${p.completionTokens} tools=${p.toolCallCount} stop=${p.stopReason ?? '?'}${RESET}\n`,
        );
        break;
      }
      case 'tool_call': {
        const p = event.payload;
        process.stderr.write(
          `${DIM}[diag] tool_call ${p.name} id=${p.toolCallId} args=${preview(p.args)}${RESET}\n`,
        );
        break;
      }
      case 'tool_result': {
        const p = event.payload;
        process.stderr.write(
          `${DIM}[diag] tool_result id=${p.toolCallId} ok=${p.ok}${
            p.error ? ` err=${p.error.kind}:${p.error.message}` : ''
          }${event.elided ? ` elided=${event.elided.handle}` : ''}${RESET}\n`,
        );
        break;
      }
      case 'turn_complete': {
        const p = event.payload;
        process.stderr.write(
          `${DIM}[diag] turn_complete ${p.status}${p.summary ? ` "${p.summary}"` : ''}${RESET}\n`,
        );
        break;
      }
      case 'compaction_event': {
        const p = event.payload;
        process.stderr.write(
          `${DIM}[diag] compaction ${p.reason} ${p.tokensBefore}→${p.tokensAfter} tok in ${p.durationMs}ms${RESET}\n`,
        );
        break;
      }
      case 'reply':
      case 'preamble':
      case 'reasoning': {
        if (this.level !== 'verbose') break;
        const p = event.payload as { text: string };
        process.stderr.write(`${DIM}[diag] ${event.kind}: ${truncate(p.text, 120)}${RESET}\n`);
        break;
      }
      case 'interrupt': {
        const p = event.payload;
        process.stderr.write(`${DIM}[diag] interrupt${p.reason ? ` (${p.reason})` : ''}${RESET}\n`);
        break;
      }
      default:
        break;
    }
  }

  async close(): Promise<void> {
    // nothing to close
  }
}

function preview(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return truncate(s, 80);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
