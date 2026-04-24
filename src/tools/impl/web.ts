import { z } from 'zod';

import type { Tool } from '../tool.js';

const FetchArgs = z.object({
  url: z.string(),
  maxOutputBytes: z.number().optional(),
});

export const webFetchTool: Tool<typeof FetchArgs, {
  url: string;
  status: number;
  summary: string;
  handle?: string;
}> = {
  name: 'web_fetch',
  concurrency: 'safe',
  description: [
    'Fetch a URL. STUB in phase 1 — returns placeholder. Body is registered as an elidable handle;',
    'the LLM sees url + status + short summary by default and can restore() the body if needed.',
  ].join(' '),
  schema: FetchArgs,
  async execute(args, ctx) {
    const body = `[stub-web_fetch] would fetch ${args.url}`;
    const handle = ctx.registerHandle('web_body', { url: args.url, body });
    return {
      ok: true,
      output: { url: args.url, status: 0, summary: body, handle },
      elided: {
        handle,
        kind: 'web_body',
        meta: { url: args.url },
      },
    };
  },
};

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
    'Search the web. STUB in phase 1 — returns empty results.',
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
