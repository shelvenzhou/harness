import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { HarnessEvent } from '@harness/core/events.js';
import {
  newEventId,
  newThreadId,
  newTurnId,
} from '@harness/core/ids.js';
import { JsonlDiagSink, StderrDiagSink } from '@harness/diag/index.js';
import type { SamplingRequest } from '@harness/llm/provider.js';

describe('JsonlDiagSink', () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('writes prompt dumps and appends trace lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-diag-'));
    cleanups.push(root);
    const sink = new JsonlDiagSink({ root });
    const threadId = newThreadId();
    const turnId = newTurnId();

    const request: SamplingRequest = {
      prefix: { systemPrompt: 'sys', tools: [] },
      tail: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    };
    const path = await sink.onPrompt(
      { threadId, turnId, samplingIndex: 1 },
      request,
      { projectedItems: 1, elidedCount: 0, estimatedTokens: 2, pinnedHandles: 0 },
    );
    expect(path).toBeDefined();
    const txt = await readFile(path!, 'utf8');
    expect(txt).toContain('# system');

    const ev: HarnessEvent = {
      id: newEventId(),
      threadId,
      kind: 'sampling_complete',
      createdAt: new Date().toISOString(),
      payload: {
        samplingIndex: 1,
        providerId: 'mock',
        promptTokens: 10,
        cachedPromptTokens: 0,
        completionTokens: 5,
        wallMs: 50,
        toolCallCount: 0,
        projection: { projectedItems: 1, elidedCount: 0, estimatedTokens: 2, pinnedHandles: 0 },
      },
    } as HarnessEvent;
    await sink.onEvent(ev);

    const trace = await readFile(join(root, threadId, 'trace.jsonl'), 'utf8');
    expect(trace.split('\n').filter(Boolean)).toHaveLength(1);
    const parsed = JSON.parse(trace.trim());
    expect(parsed.kind).toBe('sampling_complete');
  });
});

describe('StderrDiagSink', () => {
  it('prints a concise summary line per sampling_complete without throwing', async () => {
    const sink = new StderrDiagSink({ level: 'summary' });
    const request: SamplingRequest = {
      prefix: { systemPrompt: 'sys', tools: [] },
      tail: [],
    };
    // onPrompt + onEvent — should not throw in any branch.
    await sink.onPrompt(
      { threadId: newThreadId(), turnId: newTurnId(), samplingIndex: 1 },
      request,
      { projectedItems: 0, elidedCount: 0, estimatedTokens: 0, pinnedHandles: 0 },
    );
    sink.onEvent({
      id: newEventId(),
      threadId: newThreadId(),
      kind: 'sampling_complete',
      createdAt: new Date().toISOString(),
      payload: {
        samplingIndex: 1,
        providerId: 'x',
        promptTokens: 0,
        cachedPromptTokens: 0,
        completionTokens: 0,
        wallMs: 10,
        toolCallCount: 0,
        projection: { projectedItems: 0, elidedCount: 0, estimatedTokens: 0, pinnedHandles: 0 },
      },
    } as HarnessEvent);
    await sink.close();
    expect(true).toBe(true);
  });

  it('prints turn_complete reason when summary is absent', async () => {
    const sink = new StderrDiagSink({ level: 'summary' });
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      sink.onEvent({
        id: newEventId(),
        threadId: newThreadId(),
        kind: 'turn_complete',
        createdAt: new Date().toISOString(),
        payload: {
          status: 'interrupted',
          reason: 'budget:maxTokens',
        },
      } as HarnessEvent);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(writes.join('')).toContain('turn_complete interrupted reason=budget:maxTokens');
  });
});
