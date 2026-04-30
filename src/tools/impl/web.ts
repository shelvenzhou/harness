import { z } from 'zod';

import type { Tool } from '../tool.js';

/**
 * web_fetch — fetch a URL via Node's global fetch (undici).
 *
 * Phase 1 + 2 scope:
 *   - HTTP/HTTPS only (http:/https: scheme).
 *   - Byte cap (default 256KB). Oversize bodies are truncated and elided.
 *   - Timeout via AbortController (default 20s).
 *   - Returns status, content-type, body (maybe truncated), and a handle
 *     to the full captured body so the LLM can restore() it.
 *
 * Future (phase 4): route through the network-proxy policy layer instead
 * of calling fetch directly — same API surface from the tool's POV.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const TAIL_INLINE_BYTES = 4096;

const FetchArgs = z.object({
  url: z.string().describe('Full URL (http:// or https://).'),
  method: z.enum(['GET', 'HEAD']).optional().describe('HTTP method; GET (default) or HEAD.'),
  timeoutMs: z.number().optional().describe('Hard timeout in ms (default 20000).'),
  maxOutputBytes: z.number().optional().describe('Cap captured response bytes (default 262144).'),
});

interface FetchOutput {
  url: string;
  status: number;
  contentType?: string;
  body?: string;
  truncated: boolean;
  originalBytes: number;
  wallMs: number;
}

export const webFetchTool: Tool<typeof FetchArgs, FetchOutput> = {
  name: 'web_fetch',
  concurrency: 'safe',
  async: true,
  description: [
    'Fetch a URL (GET or HEAD). Body is captured with a byte cap; oversize bodies are elided',
    'and saved to a handle (use `restore` to pull the full body). Use for known URLs.',
    "Use web_search when you don't yet have a URL.",
  ].join(' '),
  schema: FetchArgs,
  async execute(args, ctx) {
    const url = args.url;
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const method = args.method ?? 'GET';

    if (!/^https?:\/\//i.test(url)) {
      return {
        ok: false,
        error: { kind: 'bad_url', message: 'web_fetch only supports http:// and https:// URLs' },
      };
    }

    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
    timer.unref();
    const linkAbort = () => timeoutCtl.abort();
    ctx.signal.addEventListener('abort', linkAbort, { once: true });

    const started = Date.now();
    let response: Response;
    try {
      response = await fetch(url, { method, signal: timeoutCtl.signal, redirect: 'follow' });
    } catch (err) {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', linkAbort);
      const aborted = (err as { name?: string }).name === 'AbortError';
      return {
        ok: false,
        error: {
          kind: aborted ? 'aborted' : 'fetch',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const contentType = response.headers.get('content-type') ?? undefined;
    let body: string | undefined;
    let originalBytes = 0;
    let truncated = false;

    if (method === 'GET' && response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let collected = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          originalBytes += value.byteLength;
          if (collected >= maxBytes) {
            truncated = true;
            continue;
          }
          const allowed = Math.max(0, maxBytes - collected);
          if (value.byteLength > allowed) {
            chunks.push(value.subarray(0, allowed));
            collected += allowed;
            truncated = true;
          } else {
            chunks.push(value);
            collected += value.byteLength;
          }
        }
      } catch (err) {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', linkAbort);
        return {
          ok: false,
          error: {
            kind: 'read',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
      body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    }
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', linkAbort);

    const wallMs = Date.now() - started;
    const output: FetchOutput = {
      url,
      status: response.status,
      ...(contentType !== undefined ? { contentType } : {}),
      truncated,
      originalBytes,
      wallMs,
      ...(body !== undefined ? { body } : {}),
    };

    const ok = response.status >= 200 && response.status < 300;
    if (body !== undefined && (truncated || body.length > TAIL_INLINE_BYTES)) {
      const handle = ctx.registerHandle(
        'web_fetch_body',
        { url, body, status: response.status, contentType },
        { url, status: response.status, bytes: originalBytes, wallMs },
      );
      return {
        ok,
        output,
        elided: {
          handle,
          kind: 'web_fetch_body',
          meta: {
            url,
            status: response.status,
            bytes: originalBytes,
            ...(contentType ? { contentType } : {}),
            head: body.slice(0, 512),
          },
        },
        originalBytes,
        bytesSent: Math.min(body.length, 512),
      };
    }

    return { ok, output, originalBytes, bytesSent: body?.length ?? 0 };
  },
};

// ─── web_search stays a stub in phase 2 — needs a search backend. ───

const SearchArgs = z.object({
  query: z.string(),
  topK: z.number().optional(),
});

export const webSearchTool: Tool<typeof SearchArgs, {
  query: string;
  results: Array<{ title: string; url: string; snippet: string }>;
  handle?: string;
}> = {
  name: 'web_search',
  concurrency: 'safe',
  description: [
    'Search the web. STUB — returns empty results until a search backend (Brave/Google/DDG) is wired.',
    'Use for open-ended lookup; use web_fetch when you already know the URL.',
  ].join(' '),
  schema: SearchArgs,
  async execute(args, ctx) {
    const handle = ctx.registerHandle('web_search_results', { query: args.query, results: [] });
    return {
      ok: true,
      output: { query: args.query, results: [], handle },
      elided: {
        handle,
        kind: 'web_search_results',
        meta: { query: args.query, topK: args.topK ?? 10 },
      },
    };
  },
};
