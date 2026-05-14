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

/**
 * Per-spawn trust level. `'default'` keeps the CLI's normal permission
 * prompts and write sandbox — safe for arbitrary cwds. `'bypass'`
 * skips them: cc gets `--permission-mode bypassPermissions` and codex
 * gets `--dangerously-bypass-approvals-and-sandbox`. Use only when the
 * orchestrator created the cwd itself (a sibling worktree it owns).
 */
export type CodingAgentPermissionMode = 'default' | 'bypass';

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
  /**
   * Trust level for the CLI's own permission system. See
   * `CodingAgentPermissionMode`. Default = `'default'`.
   */
  permissionMode?: CodingAgentPermissionMode;
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

/**
 * Codex `exec --json` event shapes (empirically observed against
 * codex-cli 0.128). Codex emits a different top-level event vocabulary
 * from cc, so the pump dispatches per `this.opts.kind`. Internal items
 * (`file_change`, `tool_call`, `tool_output`, `reasoning`, …) are
 * surfaced as harness reasoning trace rather than reply text.
 */
interface CodexThreadStarted {
  type: 'thread.started';
  thread_id?: string;
}
interface CodexTurnCompleted {
  type: 'turn.completed';
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}
interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  status?: string;
  [k: string]: unknown;
}
interface CodexItemEnvelope {
  type: 'item.started' | 'item.completed';
  item?: CodexItem;
}
interface CodexStreamEvent {
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
    let pendingCodexAgentMessage: string | undefined;
    /**
     * Latest "blocked" rate-limit event captured during this run.
     * Tracked separately from `pushUsagePatch` because it drives a
     * different decision: if the run subsequently errors, we want
     * to emit `quota_exhausted` instead of plain `error` so the
     * pool can surface `resetAt` and schedule a `provider_ready`
     * wake.
     */
    let blockedWindowResetAt: string | undefined;

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
            if (this.opts.kind === 'codex') {
              const ce = ev.value as CodexStreamEvent;
              if (ce.type === 'thread.started') {
                const thrId = (ce as unknown as CodexThreadStarted).thread_id;
                if (typeof thrId === 'string') {
                  this.lastSessionId = thrId;
                  this.pushUsagePatch({ lastSessionId: thrId });
                }
                break;
              }
              if (ce.type === 'turn.started') break;
              if (ce.type === 'item.started') {
                const item = (ce as unknown as CodexItemEnvelope).item;
                const trace = formatCodexItemTrace('item.started', item);
                if (trace !== undefined) yield { kind: 'reasoning_delta', text: trace };
                break;
              }
              if (ce.type === 'item.completed') {
                const item = (ce as unknown as CodexItemEnvelope).item;
                if (
                  item !== undefined &&
                  item.type === 'agent_message' &&
                  typeof item.text === 'string'
                ) {
                  if (pendingCodexAgentMessage !== undefined) {
                    yield {
                      kind: 'reasoning_delta',
                      text: `[codex agent_message] ${pendingCodexAgentMessage}\n`,
                    };
                  }
                  // Buffer the latest agent_message; emit at turn.completed.
                  // Mirrors cc's "intermediate assistants are dropped; only
                  // the final reply lands as text_delta".
                  pendingCodexAgentMessage = item.text;
                  finalText = item.text;
                } else {
                  const trace = formatCodexItemTrace('item.completed', item);
                  if (trace !== undefined) yield { kind: 'reasoning_delta', text: trace };
                }
                break;
              }
              if (ce.type === 'turn.completed') {
                const tc = ce as unknown as CodexTurnCompleted;
                if (tc.usage !== undefined) {
                  const inT = tc.usage.input_tokens ?? 0;
                  const cachedT = tc.usage.cached_input_tokens ?? 0;
                  const outT = tc.usage.output_tokens ?? 0;
                  this.pushUsagePatch({
                    lastTokens: {
                      inputTokens: inT,
                      outputTokens: outT,
                      cacheReadInputTokens: cachedT,
                    },
                  });
                  yield {
                    kind: 'usage',
                    tokens: {
                      promptTokens: inT,
                      cachedPromptTokens: cachedT,
                      completionTokens: outT,
                    },
                  };
                }
                if (finalText !== undefined) {
                  yield { kind: 'text_delta', text: finalText, channel: 'reply' };
                }
                yield { kind: 'end', stopReason: 'end_turn' };
                endEmitted = true;
                break;
              }
              // Unknown event: drop
              break;
            }
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
              const rl = e as unknown as CcRateLimitEvent;
              this.pushUsagePatch(buildRateLimitPatch(rl));
              const blocked = isBlockedQuotaEvent(rl);
              if (blocked !== undefined) {
                blockedWindowResetAt = blocked.resetAt;
              }
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
                if (blockedWindowResetAt !== undefined) {
                  yield {
                    kind: 'end',
                    stopReason: 'quota_exhausted',
                    resetAt: blockedWindowResetAt,
                  };
                } else {
                  yield { kind: 'end', stopReason: 'error' };
                }
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
      if (this.opts.permissionMode === 'bypass') {
        // Headless cc invocations cannot answer per-write permission
        // prompts; bypassPermissions short-circuits both the prompt
        // and the in-CLI write sandbox. --add-dir explicitly puts cwd
        // on the allowlist for the bash-sandbox check (some cc
        // versions evaluate it against the launching shell's cwd, not
        // the spawned process's, so passing the cwd directly is
        // belt-and-suspenders).
        args.push('--permission-mode', 'bypassPermissions');
        args.push('--add-dir', this.opts.cwd);
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
    const args: string[] = ['exec', '--json', codexPrompt(prompt, request)];
    if (this.opts.providerSessionId !== undefined) {
      args.push('--session', this.opts.providerSessionId);
    }
    if (this.opts.model !== undefined) {
      args.push('--model', this.opts.model);
    }
    if (this.opts.permissionMode === 'bypass') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (this.opts.extraArgs && this.opts.extraArgs.length > 0) {
      args.push(...this.opts.extraArgs);
    }
    return args;
  }
}

function codexPrompt(prompt: string, request: SamplingRequest): string {
  const sys = request.prefix.systemPrompt.trim();
  if (sys.length === 0) return prompt;
  return `${sys}\n\n# Task\n${prompt}`;
}

function formatCodexItemTrace(
  eventType: 'item.started' | 'item.completed',
  item: CodexItem | undefined,
): string | undefined {
  if (item === undefined) return undefined;
  const itemType = typeof item.type === 'string' ? item.type : 'unknown';
  if (itemType === 'agent_message') return undefined;
  const status = typeof item.status === 'string' ? ` ${item.status}` : '';
  const detail = codexItemDetail(item);
  return `[codex ${eventType} ${itemType}${status}]${detail.length > 0 ? ` ${detail}` : ''}\n`;
}

function codexItemDetail(item: CodexItem): string {
  const direct = ['text', 'title', 'command', 'cmd', 'output', 'diff', 'path']
    .map((key) => item[key])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join('\n');
  if (direct.length > 0) return truncateForTrace(direct);
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === 'id' || key === 'type' || key === 'status') continue;
    copy[key] = value;
  }
  if (Object.keys(copy).length === 0) return '';
  return truncateForTrace(JSON.stringify(copy));
}

function truncateForTrace(text: string): string {
  const max = 2_000;
  return text.length > max ? `${text.slice(0, max)}…` : text;
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

/**
 * Decide whether a `rate_limit_event` represents a *blocked* quota
 * state — the window is closed, the next CLI call is going to fail
 * (or already is). Returns the resetAt ISO string to drive the
 * parent's `wait(provider_ready)` retry, or `undefined` if the
 * event is a non-terminal warning / informational push.
 *
 * Triggers (any one):
 *   - explicit `status: 'blocked'` (or related sentinels)
 *   - `utilization >= 1.0` (the window is full)
 *
 * cc has not been observed to send `'blocked'` literally; the
 * statuses we have seen are `'allowed'` / `'allowed_warning'`. The
 * implementation accepts a small set of likely strings so we don't
 * miss future variants — if cc emits something we don't recognise,
 * the run still terminates with plain `error` and the operator can
 * tell from the message.
 */
function isBlockedQuotaEvent(ev: CcRateLimitEvent): { resetAt: string } | undefined {
  const info = ev.rate_limit_info;
  if (!info) return undefined;
  const blockedStatuses = new Set(['blocked', 'rate_limited', 'limit_reached', 'exceeded']);
  const statusBlocked =
    typeof info.status === 'string' && blockedStatuses.has(info.status);
  const utilBlocked = typeof info.utilization === 'number' && info.utilization >= 1.0;
  if (!statusBlocked && !utilBlocked) return undefined;
  if (typeof info.resetsAt !== 'number') return undefined;
  return { resetAt: new Date(info.resetsAt * 1000).toISOString() };
}

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
