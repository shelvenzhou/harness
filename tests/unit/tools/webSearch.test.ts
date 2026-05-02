import { describe, expect, it } from 'vitest';

import { newHandleRef, newThreadId, newToolCallId, newTurnId } from '@harness/core/ids.js';
import { webSearchTool } from '@harness/tools/impl/web.js';
import type { ToolExecutionContext } from '@harness/tools/tool.js';
import {
  SearchError,
  type SearchBackend,
  type SearchOptions,
  type SearchResponse,
} from '@harness/search/types.js';

function ctx(
  searchBackend?: SearchBackend,
  registerHandle: (kind: string, payload: unknown, meta?: Record<string, unknown>) => string = () =>
    newHandleRef(),
): ToolExecutionContext {
  return {
    threadId: newThreadId(),
    turnId: newTurnId(),
    toolCallId: newToolCallId(),
    signal: new AbortController().signal,
    log: () => void 0,
    registerHandle: registerHandle as ToolExecutionContext['registerHandle'],
    services: searchBackend ? { searchBackend } : {},
  };
}

class FakeBackend implements SearchBackend {
  readonly name = 'fake';
  constructor(private readonly resp: SearchResponse | (() => SearchResponse | Promise<never>)) {}
  async search(_q: string, _opts?: SearchOptions): Promise<SearchResponse> {
    if (typeof this.resp === 'function') return this.resp() as Promise<SearchResponse>;
    return this.resp;
  }
}

describe('webSearchTool', () => {
  it('returns unsupported when no backend is wired', async () => {
    const r = await webSearchTool.execute({ query: 'x' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('unsupported');
  });

  it('returns mapped results from the backend', async () => {
    const backend = new FakeBackend({
      query: 'q',
      provider: 'fake',
      results: [
        { title: 'A', url: 'https://a', snippet: 's1' },
        { title: 'B', url: 'https://b', snippet: 's2' },
      ],
    });
    const r = await webSearchTool.execute({ query: 'q' }, ctx(backend));
    expect(r.ok).toBe(true);
    expect(r.output?.provider).toBe('fake');
    expect(r.output?.results).toHaveLength(2);
    expect(r.output?.results[0]?.url).toBe('https://a');
    expect(r.elided).toBeUndefined();
  });

  it('elides when serialized result set exceeds inline cap', async () => {
    const big = Array.from({ length: 20 }, (_, i) => ({
      title: `T${i}`,
      url: `https://example.com/${i}`,
      snippet: 'x'.repeat(400),
    }));
    const backend = new FakeBackend({ query: 'q', provider: 'fake', results: big });
    const handles: string[] = [];
    const r = await webSearchTool.execute(
      { query: 'q', topK: 20 },
      ctx(backend, () => {
        const h = newHandleRef();
        handles.push(h);
        return h;
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.output?.truncated).toBe(true);
    expect(r.elided).toBeDefined();
    expect(handles).toHaveLength(1);
  });

  it('maps SearchError into structured tool_result.error', async () => {
    const backend = new FakeBackend(() => {
      throw new SearchError('rate_limit', 'too fast', 429);
    });
    const r = await webSearchTool.execute({ query: 'q' }, ctx(backend));
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('rate_limit');
    expect(r.error?.retryable).toBe(true);
  });

  it('caps topK at 20 even if requested higher', async () => {
    let seenTopK: number | undefined;
    const backend: SearchBackend = {
      name: 'spy',
      async search(_q, opts) {
        seenTopK = opts?.topK;
        return { query: _q, provider: 'spy', results: [] };
      },
    };
    await webSearchTool.execute({ query: 'q', topK: 999 }, ctx(backend));
    expect(seenTopK).toBe(20);
  });

  it('marks tool as async', () => {
    expect(webSearchTool.async).toBe(true);
  });
});
