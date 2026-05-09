import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import type {
  LlmCapabilities,
  LlmProvider,
  ProjectedItem,
  SamplingDelta,
  SamplingRequest,
} from './provider.js';
import type {
  ProviderQuotaWindow,
  ProviderUsagePatch,
  ProviderUsageRegistry,
} from './providerUsageRegistry.js';

/**
 * `CodingAgentProvider` — wraps a coding-agent CLI (Claude Code, codex)
 * as an `LlmProvider`. From the harness runtime's perspective each
 * `sample()` is one full "send a prompt, read the agent's reply"
 * round-trip; the CLI's internal edit/test loop is opaque.
 *
 * See design-docs/11-self-update.md §R2 for the full contract. The
 * key points:
 *
 *   - One `sample()` invocation = one CLI process.
 *   - The provider extracts the *last* user message from
 *     `request.tail` as the prompt. The harness runner only ever
 *     sends one new user message per sampling cycle, so this matches
 *     the natural shape.
 *   - The CLI's stream-json events are translated:
 *       system/init → captures `session_id` (no SamplingDelta)
 *       assistant text → consumed only on the *final* `result` event
 *       result/success → `text_delta` (the final answer) +
 *                        `end{stopReason:'end_turn'}`
 *       result/error → `end{stopReason:'error'}`
 *     The agent's intermediate `tool_use` / `tool_result` events are
 *     dropped — they are the CLI's internal business and would
 *     pollute the parent's projection.
 *   - `providerSessionId` is captured from `system/init` on the
 *     first run and exposed via `lastSessionId` so `SubagentPool`
 *     can attach it to `subtask_complete`. When the caller passes
 *     `providerSessionId` in the constructor, the CLI is invoked
 *     with `--resume <id>` so the same internal conversation
 *     continues without re-paying context tokens.
 *
 * Quota-exhaustion / `usage()` are M2 / M3 work — out of scope here.
 */

export type CodingAgentKind = 'cc' | 'codex';

export interface CodingAgentProviderOptions {
  kind: CodingAgentKind;
  /** Working directory for the child process (typically a sibling git worktree). */
  cwd: string;
  /** CLI binary path. Defaults to `claude` / `codex`. */
  binaryPath?: string;
  /** Optional model override (-m / --model). */
  model?: string;
  /**
   * Resume token forwarded to the CLI. For cc this becomes
   * `--resume <id>` so the agent continues its prior internal
   * conversation; the CLI may issue a fresh `session_id` as it
   * resumes (cc rotates the id), and the new one is captured on
   * the next `system/init` event.
   */
  providerSessionId?: string;
  /** Extra environment variables to merge with `process.env`. */
  env?: Record<string, string>;
  /** Extra positional / flag arguments appended to the CLI command. */
  extraArgs?: string[];
  /** Hard cap for the child process (defensive backstop on top of pool budgets). */
  hardTimeoutMs?: number;
  /**
   * Optional registry the provider pushes account-level snapshots
   * into (last session id, per-run token / cost stats, model). The
   * `usage` tool reads from the registry so the orchestrator can
   * see `cc` / `codex` state without spawning a query child.
   */
  usageRegistry?: ProviderUsageRegistry;
}

const DEFAULT_BINARY: Record<CodingAgentKind, string> = {
  cc: 'claude',
  codex: 'codex',
};

const DEFAULT_HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const SIGKILL_GRACE_MS = 2_000;

/** First chunk: a single JSON line. Subsequent: 0+ NDJSON lines. */
function splitNdjson(buf: string): { records: string[]; rest: string } {
  const records: string[] = [];
  let rest = buf;
  let nl = rest.indexOf('\n');
  while (nl !== -1) {
    const line = rest.slice(0, nl).trim();
    if (line.length > 0) records.push(line);
    rest = rest.slice(nl + 1);
    nl = rest.indexOf('\n');
  }
  return { records, rest };
}

interface CcSystemInit {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  cwd?: string;
  model?: string;
}

interface CcRateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info?: {
    status?: string;
    resetsAt?: number;
    /** Provider tag: 'five_hour' (cc session) | 'seven_day' (cc week) | … */
    rateLimitType?: string;
    utilization?: number;
    surpassedThreshold?: number;
    isUsingOverage?: boolean;
  };
}

interface CcResult {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | string;
  is_error: boolean;
  duration_ms?: number;
  num_turns?: number;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    [k: string]: unknown;
  };
}

interface CcStreamEvent {
  type: string;
  [k: string]: unknown;
}

function lastUserText(tail: ProjectedItem[]): string {
  for (let i = tail.length - 1; i >= 0; i--) {
    const item = tail[i];
    if (!item || item.role !== 'user') continue;
    const txt = item.content
      .filter((c): c is { kind: 'text'; text: string } => c.kind === 'text')
      .map((c) => c.text)
      .join('\n');
    if (txt.length > 0) return txt;
  }
  return '';
}

export class CodingAgentProvider implements LlmProvider {
  readonly id: string;
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    // From the harness runner's POV the child never emits harness tool calls.
    nativeToolUse: false,
    nativeReasoning: false,
    // The CLI manages its own context; we don't budget on it from here.
    maxContextTokens: 200_000,
  };

  private readonly opts: CodingAgentProviderOptions;
  private readonly binary: string;
  /**
   * Most recent provider session id observed from the CLI (captured
   * on `system/init` and refreshed if `result` carries one too).
   * `SubagentPool` reads this at child-exit time to populate
   * `subtask_complete.providerSessionId`. Initialised from the
   * resume token so callers that pre-set it still see something
   * useful even if the CLI fails before emitting `system/init`.
   */
  lastSessionId?: string;

  constructor(opts: CodingAgentProviderOptions) {
    this.opts = opts;
    this.binary = opts.binaryPath ?? DEFAULT_BINARY[opts.kind];
    this.id = opts.kind;
    if (opts.providerSessionId !== undefined) {
      this.lastSessionId = opts.providerSessionId;
    }
  }

  async *sample(request: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    const prompt = lastUserText(request.tail);
    if (prompt.length === 0) {
      // Defensive: nothing to ask the agent. End the turn cleanly so
      // the runner does not loop.
      yield { kind: 'end', stopReason: 'end_turn' };
      return;
    }

    const args = this.buildArgs(prompt, request);
    const env = { ...process.env, ...(this.opts.env ?? {}) };

    const child = spawn(this.binary, args, {
      cwd: this.opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const events = pumpStream(child, signal, this.opts.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS);

    let finalText: string | undefined;
    let endEmitted = false;
    let stderrBuf = '';

    child.stderr.on('data', (chunk: Buffer) => {
      // Keep last 4KB only — stderr can be chatty.
      stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-4096);
    });

    try {
      for await (const ev of events) {
        if (signal.aborted) {
          break;
        }
        switch (ev.kind) {
          case 'json': {
            const e = ev.value as CcStreamEvent;
            if (e.type === 'system' && (e as unknown as CcSystemInit).subtype === 'init') {
              const init = e as unknown as CcSystemInit;
              if (typeof init.session_id === 'string') {
                this.lastSessionId = init.session_id;
              }
              this.pushUsagePatch({
                ...(typeof init.session_id === 'string'
                  ? { lastSessionId: init.session_id }
                  : {}),
                ...(typeof init.model === 'string' ? { lastModel: init.model } : {}),
              });
              break;
            }
            if (e.type === 'assistant') {
              // Intermediate assistant chatter. The cc CLI emits one
              // assistant event per internal step (often containing
              // tool_use blocks). The harness only wants the agent's
              // FINAL text — that arrives on the `result` event. Drop.
              break;
            }
            if (e.type === 'user') {
              // CLI replays its own internal tool_results back into
              // the conversation. Internal-only; drop.
              break;
            }
            if (e.type === 'rate_limit_event') {
              this.pushUsagePatch(buildRateLimitPatch(e as unknown as CcRateLimitEvent));
              break;
            }
            if (e.type === 'result') {
              const r = e as unknown as CcResult;
              if (typeof r.session_id === 'string') {
                this.lastSessionId = r.session_id;
              }
              if (typeof r.result === 'string' && r.result.length > 0) {
                finalText = r.result;
              }
              this.pushUsagePatch(buildResultPatch(r));
              if (r.is_error) {
                if (finalText !== undefined) {
                  yield { kind: 'text_delta', text: finalText, channel: 'reply' };
                }
                yield { kind: 'end', stopReason: 'error' };
                endEmitted = true;
              } else {
                if (finalText !== undefined) {
                  yield { kind: 'text_delta', text: finalText, channel: 'reply' };
                }
                yield { kind: 'end', stopReason: 'end_turn' };
                endEmitted = true;
              }
              break;
            }
            // Unknown event: ignore.
            break;
          }
          case 'exit': {
            if (!endEmitted) {
              // Process ended before a `result` event — treat as error
              // and surface stderr tail to help diagnose.
              const trimmed = stderrBuf.trim();
              if (trimmed.length > 0) {
                yield {
                  kind: 'text_delta',
                  text: `[${this.opts.kind} exited without result] ${trimmed}`,
                  channel: 'reply',
                };
              }
              yield { kind: 'end', stopReason: 'error' };
              endEmitted = true;
            }
            break;
          }
        }
      }
    } finally {
      // Best-effort: if we exited the loop without the process being
      // dead (e.g. abort), make sure no zombie remains.
      if (child.exitCode === null && child.signalCode === null) {
        killGroup(child, 'SIGTERM');
        setTimeout(() => killGroup(child, 'SIGKILL'), SIGKILL_GRACE_MS).unref();
      }
      if (!endEmitted) {
        yield { kind: 'end', stopReason: 'error' };
      }
    }
  }

  private pushUsagePatch(patch: ProviderUsagePatch): void {
    if (!this.opts.usageRegistry) return;
    if (Object.values(patch).every((v) => v === undefined)) return;
    this.opts.usageRegistry.update(this.id, patch);
  }

  private buildArgs(prompt: string, request: SamplingRequest): string[] {
    if (this.opts.kind === 'cc') {
      const args: string[] = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
      if (this.opts.providerSessionId !== undefined) {
        args.push('--resume', this.opts.providerSessionId);
      }
      if (this.opts.model !== undefined) {
        args.push('--model', this.opts.model);
      }
      // Append the harness role / orchestrator hint as a system-prompt
      // suffix so cc keeps its own default system prompt intact.
      const sys = request.prefix.systemPrompt.trim();
      if (sys.length > 0) {
        args.push('--append-system-prompt', sys);
      }
      if (this.opts.extraArgs && this.opts.extraArgs.length > 0) {
        args.push(...this.opts.extraArgs);
      }
      return args;
    }
    // codex: same shape, different flags. Real codex parity lands in M6
    // — this branch keeps the type honest until then.
    const args: string[] = ['exec', '--json', prompt];
    if (this.opts.providerSessionId !== undefined) {
      args.push('--session', this.opts.providerSessionId);
    }
    if (this.opts.model !== undefined) {
      args.push('--model', this.opts.model);
    }
    if (this.opts.extraArgs && this.opts.extraArgs.length > 0) {
      args.push(...this.opts.extraArgs);
    }
    return args;
  }
}

type PumpEvent =
  | { kind: 'json'; value: unknown }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null };

async function* pumpStream(
  child: CcChild,
  signal: AbortSignal,
  hardTimeoutMs: number,
): AsyncGenerator<PumpEvent> {
  const queue: PumpEvent[] = [];
  let resolveNext: (() => void) | undefined;
  let exited = false;
  let buffer = '';

  const wake = (): void => {
    if (resolveNext) {
      resolveNext();
      resolveNext = undefined;
    }
  };

  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    const { records, rest } = splitNdjson(buffer);
    buffer = rest;
    for (const rec of records) {
      try {
        const value = JSON.parse(rec) as unknown;
        queue.push({ kind: 'json', value });
      } catch {
        // Non-JSON line: ignore. cc's --verbose stream is normally
        // strict NDJSON, but be defensive.
      }
    }
    if (records.length > 0) wake();
  };

  child.stdout.on('data', onData);

  child.on('close', (code, sig) => {
    exited = true;
    queue.push({ kind: 'exit', code, signal: sig });
    wake();
  });
  child.on('error', () => {
    exited = true;
    queue.push({ kind: 'exit', code: null, signal: null });
    wake();
  });

  const onAbort = (): void => {
    killGroup(child, 'SIGTERM');
    setTimeout(() => killGroup(child, 'SIGKILL'), SIGKILL_GRACE_MS).unref();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  const hardTimer = setTimeout(() => {
    killGroup(child, 'SIGTERM');
    setTimeout(() => killGroup(child, 'SIGKILL'), SIGKILL_GRACE_MS).unref();
  }, hardTimeoutMs);
  hardTimer.unref();

  try {
    while (true) {
      const ev = queue.shift();
      if (ev !== undefined) {
        yield ev;
        if (ev.kind === 'exit') return;
        continue;
      }
      if (exited) return;
      await new Promise<void>((res) => {
        resolveNext = res;
      });
    }
  } finally {
    clearTimeout(hardTimer);
    signal.removeEventListener('abort', onAbort);
    child.stdout.removeListener('data', onData);
  }
}

type CcChild = ChildProcessByStdio<null, Readable, Readable>;

function buildRateLimitPatch(ev: CcRateLimitEvent): ProviderUsagePatch {
  const info = ev.rate_limit_info;
  if (!info) return {};
  const utilization = typeof info.utilization === 'number' ? info.utilization : undefined;
  const resetsAt =
    typeof info.resetsAt === 'number'
      ? new Date(info.resetsAt * 1000).toISOString()
      : undefined;
  if (utilization === undefined || resetsAt === undefined) return {};
  const window: ProviderQuotaWindow = {
    utilization,
    resetsAt,
    ...(typeof info.status === 'string' ? { status: info.status } : {}),
    ...(typeof info.surpassedThreshold === 'number'
      ? { surpassedThreshold: info.surpassedThreshold }
      : {}),
    ...(typeof info.isUsingOverage === 'boolean'
      ? { isUsingOverage: info.isUsingOverage }
      : {}),
  };
  // cc's `rateLimitType` is the discriminator. Anything we don't
  // recognise is dropped silently — better to surface no data than
  // mislabel a future window kind.
  switch (info.rateLimitType) {
    case 'five_hour':
      return { fiveHour: window };
    case 'seven_day':
      return { sevenDay: window };
    default:
      return {};
  }
}

function buildResultPatch(r: CcResult): ProviderUsagePatch {
  const patch: ProviderUsagePatch = {};
  if (typeof r.session_id === 'string') patch.lastSessionId = r.session_id;
  if (typeof r.duration_ms === 'number') patch.lastDurationMs = r.duration_ms;
  if (typeof r.num_turns === 'number') patch.lastTurns = r.num_turns;
  if (typeof r.total_cost_usd === 'number') patch.lastCostUsd = r.total_cost_usd;
  if (r.usage && typeof r.usage === 'object') {
    const u = r.usage;
    if (typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number') {
      patch.lastTokens = {
        inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
        outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
        ...(typeof u.cache_read_input_tokens === 'number'
          ? { cacheReadInputTokens: u.cache_read_input_tokens }
          : {}),
        ...(typeof u.cache_creation_input_tokens === 'number'
          ? { cacheCreationInputTokens: u.cache_creation_input_tokens }
          : {}),
      };
    }
  }
  return patch;
}

function killGroup(child: CcChild, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      child.kill(sig);
    } else {
      process.kill(-child.pid, sig);
    }
  } catch {
    /* no-op: child may already be gone */
  }
}
