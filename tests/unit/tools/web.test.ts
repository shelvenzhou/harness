import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newHandleRef, newThreadId, newToolCallId, newTurnId } from '@harness/core/ids.js';
import { webFetchTool } from '@harness/tools/impl/web.js';
import type { ToolExecutionContext } from '@harness/tools/tool.js';

function ctx(
  signal = new AbortController().signal,
  registerHandle = () => newHandleRef(),
): ToolExecutionContext {
  return {
    threadId: newThreadId(),
    turnId: newTurnId(),
    toolCallId: newToolCallId(),
    signal,
    log: () => void 0,
    registerHandle,
    services: {},
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/hello') {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('hello');
      return;
    }
    if (req.url === '/big') {
      res.setHeader('content-type', 'application/octet-stream');
      // ~10 KB of bytes.
      res.end(Buffer.alloc(10_240, 0x61));
      return;
    }
    if (req.url === '/404') {
      res.statusCode = 404;
      res.end('nope');
      return;
    }
    if (req.url === '/slow') {
      // Never responds within test window.
      setTimeout(() => res.end('late'), 5_000).unref();
      return;
    }
    res.statusCode = 500;
    res.end('unknown');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('webFetchTool', () => {
  it('returns body, status, contentType on 200', async () => {
    const r = await webFetchTool.execute({ url: `${baseUrl}/hello` }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output?.status).toBe(200);
    expect(r.output?.body).toBe('hello');
    expect(r.output?.contentType).toContain('text/plain');
  });

  it('rejects non-http URLs', async () => {
    const r = await webFetchTool.execute({ url: 'file:///tmp/x' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('bad_url');
  });

  it('truncates large bodies and registers a handle', async () => {
    const handles: string[] = [];
    const r = await webFetchTool.execute(
      { url: `${baseUrl}/big`, maxOutputBytes: 1_024 },
      ctx(undefined, () => {
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

  it('non-2xx returns ok=false but still captures body', async () => {
    const r = await webFetchTool.execute({ url: `${baseUrl}/404` }, ctx());
    expect(r.ok).toBe(false);
    expect(r.output?.status).toBe(404);
    expect(r.output?.body).toBe('nope');
  });

  it('honours timeoutMs', async () => {
    const r = await webFetchTool.execute(
      { url: `${baseUrl}/slow`, timeoutMs: 100 },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('aborted');
  }, 5_000);
});
