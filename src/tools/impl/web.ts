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

// ─── web_search ──────────────────────────────────────────────────────────

import { SearchError, type SearchResponse } from '@harness/search/types.js';

const SEARCH_INLINE_BYTES = 4096;
const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 20;

const SearchArgs = z.object({
  query: z.string().describe('Free-text query.'),
  topK: z.number().optional().describe('Max results (default 8, hard cap 20).'),
  safe: z.enum(['off', 'moderate', 'strict']).optional().describe('Safe-search level.'),
});

interface WebSearchOutput {
  query: string;
  provider: string;
  results: Array<{ title: string; url: string; snippet: string }>;
  answer?: string;
  truncated?: boolean;
}

export const webSearchTool: Tool<typeof SearchArgs, WebSearchOutput> = {
  name: 'web_search',
  concurrency: 'safe',
  async: true,
  description: [
    "Search the web. Returns title/url/snippet triples from the configured backend (Google, Tavily, ...).",
    "Use for open-ended lookup when you don't yet have a URL; use web_fetch when you do.",
  ].join(' '),
  schema: SearchArgs,
  async execute(args, ctx) {
    const backend = ctx.services.searchBackend;
    if (!backend) {
      return {
        ok: false as const,
        error: { kind: 'unsupported', message: 'web_search backend not configured' },
      };
    }
    const topK = Math.max(1, Math.min(args.topK ?? DEFAULT_TOP_K, MAX_TOP_K));

    let resp: SearchResponse;
    try {
      resp = await backend.search(args.query, {
        topK,
        ...(args.safe !== undefined ? { safe: args.safe } : {}),
        signal: ctx.signal,
      });
    } catch (err) {
      if (err instanceof SearchError) {
        return {
          ok: false as const,
          error: {
            kind: err.kind,
            message: err.message,
            retryable: err.kind === 'rate_limit' || err.kind === 'transport',
          },
        };
      }
      return {
        ok: false as const,
        error: { kind: 'search', message: err instanceof Error ? err.message : String(err) },
      };
    }

    const trimmed = resp.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
    }));
    const output: WebSearchOutput = {
      query: resp.query,
      provider: resp.provider,
      results: trimmed,
      ...(resp.answer ? { answer: resp.answer } : {}),
    };

    const inlineBytes = approxJsonBytes(output);
    if (inlineBytes > SEARCH_INLINE_BYTES) {
      const handle = ctx.registerHandle(
        'web_search_results',
        { query: resp.query, provider: resp.provider, results: resp.results, answer: resp.answer },
        { query: resp.query, provider: resp.provider, count: resp.results.length },
      );
      return {
        ok: true,
        output: { ...output, truncated: true },
        elided: {
          handle,
          kind: 'web_search_results',
          meta: {
            query: resp.query,
            provider: resp.provider,
            count: resp.results.length,
          },
        },
      };
    }
    return { ok: true, output };
  },
};

function approxJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}
