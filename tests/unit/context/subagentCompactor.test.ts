import { describe, expect, it } from 'vitest';

import { EventBus } from '@harness/bus/eventBus.js';
import { SubagentCompactor } from '@harness/context/subagentCompactor.js';
import type { Compactor, CompactionRequest } from '@harness/context/compactor.js';
import { newEventId, newThreadId } from '@harness/core/ids.js';
import type { HarnessEvent } from '@harness/core/events.js';
import type {
  LlmCapabilities,
  LlmProvider,
  SamplingDelta,
  SamplingRequest,
} from '@harness/llm/provider.js';
import { MemorySessionStore } from '@harness/store/index.js';

class ScriptedProvider implements LlmProvider {
  readonly id = 'scripted';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: false,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  public lastPrompt?: SamplingRequest;
  constructor(private readonly script: SamplingDelta[]) {}
  async *sample(request: SamplingRequest, _signal: AbortSignal): AsyncIterable<SamplingDelta> {
    this.lastPrompt = request;
    for (const d of this.script) yield d;
    if (!this.script.some((d) => d.kind === 'end')) {
      yield { kind: 'end', stopReason: 'end_turn' };
    }
  }
}

class FailingProvider implements LlmProvider {
  readonly id = 'failing';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: false,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  // Stops without emitting reply text → AgentRunner reports
  // turn_complete{status:'errored'}; the compactor should fall back.
  // eslint-disable-next-line require-yield
  async *sample(_req: SamplingRequest, _signal: AbortSignal): AsyncIterable<SamplingDelta> {
    return;
  }
}

class HangProvider implements LlmProvider {
  readonly id = 'hang';
  readonly capabilities: LlmCapabilities = {
    prefixCache: false,
    cacheEdits: false,
    nativeToolUse: false,
    nativeReasoning: false,
    maxContextTokens: 100_000,
  };
  sample(_req: SamplingRequest, signal: AbortSignal): AsyncIterable<SamplingDelta> {
    return waitForAbort(signal);
  }
}

function waitForAbort(signal: AbortSignal): AsyncIterable<SamplingDelta> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SamplingDelta> {
      let done = false;
      return {
        async next(): Promise<IteratorResult<SamplingDelta>> {
          if (!done) {
            done = true;
            await new Promise<void>((resolve) => {
              const onAbort = (): void => {
                signal.removeEventListener('abort', onAbort);
                resolve();
              };
              if (signal.aborted) resolve();
              else signal.addEventListener('abort', onAbort, { once: true });
            });
          }
          return { done: true, value: undefined as never };
        },
      };
    },
  };
}

async function buildRequest(
  store: MemorySessionStore,
  events: ReadonlyArray<{ kind: HarnessEvent['kind']; payload: unknown }>,
): Promise<CompactionRequest> {
  const tid = newThreadId();
  await store.createThread({ id: tid, rootTraceparent: '00-aaaa-bbbb-00' });
  const persisted: HarnessEvent[] = [];
  for (const e of events) {
    const ev = await store.append({
      threadId: tid,
      kind: e.kind,
      payload: e.payload,
    } as Parameters<MemorySessionStore['append']>[0]);
    persisted.push(ev);
  }
  return { threadId: tid, events: persisted, keepLastUserTurns: 1 };
}

describe('SubagentCompactor', () => {
  it('uses the model reply as the prose summary', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const provider = new ScriptedProvider([
      { kind: 'text_delta', text: 'CONDENSED: ', channel: 'reply' },
      { kind: 'text_delta', text: 'user asked X, agent did Y, open Z.', channel: 'reply' },
      { kind: 'end', stopReason: 'end_turn' },
    ]);

    const compactor = new SubagentCompactor({ bus, store, provider });
    const req = await buildRequest(store, [
      { kind: 'user_turn_start', payload: { text: 'old turn 1' } },
      { kind: 'reply', payload: { text: 'old reply 1' } },
      { kind: 'user_turn_start', payload: { text: 'old turn 2' } },
      { kind: 'reply', payload: { text: 'old reply 2' } },
      { kind: 'user_turn_start', payload: { text: 'most recent turn' } },
    ]);

    const result = await compactor.compact(req);
    expect(result.summary.summary).toBe('CONDENSED: user asked X, agent did Y, open Z.');
    expect(result.summary.recentUserTurns).toHaveLength(1);
    expect(result.summary.recentUserTurns[0]?.text).toBe('most recent turn');
    expect(result.tokensBefore).toBeGreaterThan(0);
  });

  it('serializes prior events into the user prompt', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const provider = new ScriptedProvider([
      { kind: 'text_delta', text: 'ok', channel: 'reply' },
      { kind: 'end', stopReason: 'end_turn' },
    ]);
    const compactor = new SubagentCompactor({ bus, store, provider });

    const req = await buildRequest(store, [
      { kind: 'user_turn_start', payload: { text: 'find foo.txt' } },
      { kind: 'tool_call', payload: { name: 'shell', args: { cmd: 'ls' } } },
      { kind: 'tool_result', payload: { ok: true, output: { stdout: 'foo.txt\n' } } },
      { kind: 'reply', payload: { text: 'found it' } },
      { kind: 'user_turn_start', payload: { text: 'open question' } },
    ]);
    await compactor.compact(req);

    const tail = provider.lastPrompt?.tail ?? [];
    const userText = tail
      .find((i) => i.role === 'user')
      ?.content.find((c): c is { kind: 'text'; text: string } => c.kind === 'text')?.text;
    expect(userText).toContain('[user] find foo.txt');
    expect(userText).toContain('[tool_call shell]');
    expect(userText).toContain('[tool_result ok]');
    expect(userText).toContain('[assistant] found it');
    // The most recent user turn must be excluded — it's preserved verbatim.
    expect(userText).not.toContain('open question');
  });

  it('falls back to StaticCompactor when the subagent fails to produce a reply', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const provider = new FailingProvider();

    const fallbackHits: number[] = [];
    const fallback: Compactor = {
      compact: async (r) => {
        fallbackHits.push(r.events.length);
        return {
          summary: {
            reinject: { systemReinject: '' },
            summary: 'static-fallback',
            recentUserTurns: [],
            ghostSnapshots: [],
            activeHandles: [],
          },
          atEventId: r.events[r.events.length - 1]?.id ?? ('' as never),
          tokensBefore: 0,
          tokensAfter: 0,
          durationMs: 0,
        };
      },
    };
    const compactor = new SubagentCompactor({ bus, store, provider, fallback });
    const req = await buildRequest(store, [
      { kind: 'user_turn_start', payload: { text: 'old' } },
      { kind: 'reply', payload: { text: 'reply' } },
      { kind: 'user_turn_start', payload: { text: 'recent' } },
    ]);

    const result = await compactor.compact(req);
    expect(fallbackHits).toEqual([req.events.length]);
    expect(result.summary.summary).toBe('static-fallback');
  });

  it('falls back when the subagent times out', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const provider = new HangProvider();

    let fallbackCalled = false;
    const compactor = new SubagentCompactor({
      bus,
      store,
      provider,
      timeoutMs: 50,
      fallback: {
        compact: async (r) => {
          fallbackCalled = true;
          return {
            summary: {
              reinject: { systemReinject: '' },
              summary: 'timed-out',
              recentUserTurns: [],
              ghostSnapshots: [],
              activeHandles: [],
            },
            atEventId: r.events[r.events.length - 1]?.id ?? ('' as never),
            tokensBefore: 0,
            tokensAfter: 0,
            durationMs: 0,
          };
        },
      },
    });
    const req = await buildRequest(store, [
      { kind: 'user_turn_start', payload: { text: 'old' } },
      { kind: 'reply', payload: { text: 'r' } },
      { kind: 'user_turn_start', payload: { text: 'recent' } },
    ]);

    const result = await compactor.compact(req);
    expect(fallbackCalled).toBe(true);
    expect(result.summary.summary).toBe('timed-out');
  });

  it('returns an empty summary without invoking the model when nothing needs summarising', async () => {
    const bus = new EventBus();
    const store = new MemorySessionStore();
    const provider = new ScriptedProvider([
      { kind: 'text_delta', text: 'should not be reached', channel: 'reply' },
      { kind: 'end', stopReason: 'end_turn' },
    ]);
    const compactor = new SubagentCompactor({ bus, store, provider });

    const tid = newThreadId();
    await store.createThread({ id: tid, rootTraceparent: '00-aaaa-bbbb-00' });
    const ev = await store.append({
      threadId: tid,
      kind: 'user_turn_start',
      payload: { text: 'only turn' },
    } as Parameters<MemorySessionStore['append']>[0]);
    const req: CompactionRequest = {
      threadId: tid,
      events: [ev],
      keepLastUserTurns: 1,
    };

    const result = await compactor.compact(req);
    expect(result.summary.summary).toBe('(no prior content)');
    expect(provider.lastPrompt).toBeUndefined();
  });
});

// ensure we don't trigger lint about unused id imports
void newEventId;
