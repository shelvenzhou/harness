import type { EventBus } from '@harness/bus/eventBus.js';
import type { HarnessEvent, TurnCompletePayload } from '@harness/core/events.js';
import {
  newEventId,
  newThreadId,
  type EventId,
  type ThreadId,
} from '@harness/core/ids.js';
import { newRootTraceparent } from '@harness/core/traceparent.js';
import type { LlmProvider } from '@harness/llm/provider.js';
import type { SessionStore } from '@harness/store/sessionStore.js';
import { ToolExecutor } from '@harness/tools/executor.js';
import { ToolRegistry } from '@harness/tools/registry.js';

import { AgentRunner } from '@harness/runtime/agentRunner.js';

import {
  StaticCompactor,
  type CompactedSummary,
  type Compactor,
  type CompactionRequest,
  type CompactionResult,
  type UserTurnExcerpt,
} from './compactor.js';

/**
 * Subagent-backed cold-path compactor.
 *
 * Runs the configured `LlmProvider` against a fresh, isolated thread
 * with an empty tool registry — the compactor agent's only job is to
 * read a transcript and reply with a faithful prose summary. It is
 * spawned outside the SubagentPool so a compaction running on an idle
 * thread doesn't have to synthesize a parent turn or pollute that
 * thread with a `subtask_complete` event.
 *
 * Strategy:
 *   1. Keep the last K user turns verbatim (same rule as StaticCompactor).
 *   2. Render every other event as a transcript line.
 *   3. Spawn a fresh thread with `parentThreadId = req.threadId` so the
 *      relationship is recorded in the store, seed it with the
 *      transcript prompt, and wait for `turn_complete` on that thread.
 *   4. Take the model's final reply text as the prose summary.
 *
 * Failure handling: any of (a) timeout, (b) `turn_complete` with status
 * != 'completed', (c) thrown exception → fall through to the configured
 * `fallback` compactor (default `StaticCompactor`). The cold-path
 * pipeline keeps moving; a flaky provider can't deadlock compaction.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const TRANSCRIPT_BYTE_CAP = 64 * 1024;

const DEFAULT_SYSTEM_PROMPT = [
  'You are the harness compaction subagent. Your only job is to read a transcript of a long conversation between a user and another agent (with its tool calls and tool results), and produce a faithful prose summary of what happened, what was learned, and what is still open.',
  '',
  'Rules:',
  '- Be concrete. Preserve names, file paths, identifiers, key numbers, decisions.',
  '- Note any unfinished tasks, open questions, or follow-ups.',
  '- Drop redundancies and chit-chat. Compress aggressively but never hallucinate.',
  '- Do NOT use tools. Reply with prose only.',
  "- Do NOT speak to the user; you are summarizing for another agent's future context window.",
].join('\n');

export interface SubagentCompactorOptions {
  bus: EventBus;
  store: SessionStore;
  provider: LlmProvider;
  /** System prompt for the compactor subagent. Default: built-in prompt. */
  systemPrompt?: string;
  /** Wall timeout for the compactor turn. Default 60s. */
  timeoutMs?: number;
  /** Fallback compactor used when the subagent fails. Default StaticCompactor. */
  fallback?: Compactor;
}

export class SubagentCompactor implements Compactor {
  private readonly bus: EventBus;
  private readonly store: SessionStore;
  private readonly provider: LlmProvider;
  private readonly systemPrompt: string;
  private readonly timeoutMs: number;
  private readonly fallback: Compactor;

  constructor(opts: SubagentCompactorOptions) {
    this.bus = opts.bus;
    this.store = opts.store;
    this.provider = opts.provider;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fallback = opts.fallback ?? new StaticCompactor();
  }

  async compact(req: CompactionRequest): Promise<CompactionResult> {
    const t0 = Date.now();
    const tokensBefore = estimateTokens(req.events);

    const { keep, summarisedEvents, atEventId } = partition(req);
    if (summarisedEvents.length === 0) {
      // Nothing to summarise — return a trivial result; matches the
      // shape StaticCompactor would have produced.
      const summary: CompactedSummary = {
        reinject: { systemReinject: '(no extra system reinjection)' },
        summary: '(no prior content)',
        recentUserTurns: keep,
        ghostSnapshots: [],
        activeHandles: [],
      };
      return {
        summary,
        atEventId,
        tokensBefore,
        tokensAfter: estimateTokens([summary]),
        durationMs: Date.now() - t0,
      };
    }

    try {
      const proseSummary = await this.runSubagent(req.threadId, summarisedEvents);
      const summary: CompactedSummary = {
        reinject: { systemReinject: '(no extra system reinjection)' },
        summary: proseSummary,
        recentUserTurns: keep,
        ghostSnapshots: [],
        activeHandles: [],
      };
      return {
        summary,
        atEventId,
        tokensBefore,
        tokensAfter: estimateTokens([summary]),
        durationMs: Date.now() - t0,
      };
    } catch {
      // Any failure → static fallback. We deliberately swallow the
      // error; the cold path is best-effort.
      return this.fallback.compact(req);
    }
  }

  private async runSubagent(
    parentThreadId: ThreadId,
    events: readonly HarnessEvent[],
  ): Promise<string> {
    const childThreadId = newThreadId();
    await this.store.createThread({
      id: childThreadId,
      rootTraceparent: newRootTraceparent(),
      parentThreadId,
      title: 'compactor',
    });

    const runner = new AgentRunner({
      threadId: childThreadId,
      bus: this.bus,
      store: this.store,
      registry: new ToolRegistry(),
      executor: new ToolExecutor(new ToolRegistry()),
      provider: this.provider,
      systemPrompt: this.systemPrompt,
    });
    runner.start();

    const reply = this.awaitTurnComplete(childThreadId);

    const seed: HarnessEvent = {
      id: newEventId(),
      threadId: childThreadId,
      kind: 'user_turn_start',
      payload: { text: renderTranscriptPrompt(events) },
      createdAt: new Date().toISOString(),
    } as HarnessEvent;
    await this.store.append(seed);
    this.bus.publish(seed);

    return reply;
  }

  private awaitTurnComplete(childThreadId: ThreadId): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.unsubscribe();
        reject(new Error(`compactor subagent timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      const sub = this.bus.subscribe(
        (ev) => {
          if (ev.threadId !== childThreadId || ev.kind !== 'turn_complete') return;
          clearTimeout(timer);
          sub.unsubscribe();
          const p = ev.payload as TurnCompletePayload;
          if (p.status !== 'completed' || !p.summary) {
            reject(
              new Error(
                `compactor subagent did not complete cleanly (status=${p.status}, reason=${p.reason ?? ''})`,
              ),
            );
            return;
          }
          resolve(p.summary);
        },
        { kinds: ['turn_complete'] },
      );
    });
  }
}

function partition(req: CompactionRequest): {
  keep: UserTurnExcerpt[];
  summarisedEvents: HarnessEvent[];
  atEventId: EventId;
} {
  const userTurns = req.events.filter(
    (e) => e.kind === 'user_turn_start' || e.kind === 'user_input',
  );
  const keepEvents = userTurns.slice(-req.keepLastUserTurns);
  const keepIds = new Set(keepEvents.map((e) => e.id));
  const summarisedEvents = req.events.filter((e) => !keepIds.has(e.id));
  const keep: UserTurnExcerpt[] = keepEvents.map((e) => ({
    turnId: e.turnId ?? e.id,
    text: (e.payload as { text?: string }).text ?? '',
  }));
  const atEvent = req.events.find((e) => !keepIds.has(e.id));
  const atEventId = (atEvent?.id ??
    req.events[req.events.length - 1]?.id ??
    ('' as EventId)) as EventId;
  return { keep, summarisedEvents, atEventId };
}

function renderTranscriptPrompt(events: readonly HarnessEvent[]): string {
  const lines: string[] = [
    'Summarize the following conversation transcript. Reply with prose only.',
    '',
    '--- transcript ---',
  ];
  let bytes = 0;
  let truncated = false;
  for (const ev of events) {
    const line = renderEvent(ev);
    if (line === undefined) continue;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (bytes + lineBytes > TRANSCRIPT_BYTE_CAP) {
      truncated = true;
      break;
    }
    lines.push(line);
    bytes += lineBytes + 1;
  }
  if (truncated) {
    lines.push('… (older events omitted; transcript was truncated to fit the prompt)');
  }
  lines.push('--- end ---');
  return lines.join('\n');
}

function renderEvent(ev: HarnessEvent): string | undefined {
  switch (ev.kind) {
    case 'user_turn_start':
    case 'user_input':
      return `[user] ${(ev.payload as { text?: string }).text ?? ''}`;
    case 'reply': {
      const p = ev.payload as { text?: string };
      return p.text ? `[assistant] ${p.text}` : undefined;
    }
    case 'tool_call': {
      const p = ev.payload as { name?: string; args?: unknown };
      return `[tool_call ${p.name ?? '?'}] ${truncateJson(p.args)}`;
    }
    case 'tool_result': {
      const p = ev.payload as { ok?: boolean; output?: unknown; error?: { message?: string } };
      const head = p.ok === false ? `error=${p.error?.message ?? 'unknown'}` : 'ok';
      return `[tool_result ${head}] ${truncateJson(p.output)}`;
    }
    case 'subtask_complete': {
      const p = ev.payload as { status?: string; summary?: string };
      return `[subtask ${p.status ?? '?'}] ${p.summary ?? ''}`;
    }
    case 'compaction_event':
      return undefined;
    default:
      return undefined;
  }
}

function truncateJson(value: unknown, max = 400): string {
  if (value === undefined || value === null) return '';
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(${s.length - max} chars truncated)`;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
