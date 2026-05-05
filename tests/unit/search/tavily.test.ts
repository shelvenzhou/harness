import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TavilySearchBackend } from '@harness/search/tavilySearch.js';
import { SearchError } from '@harness/search/types.js';

let server: Server;
let baseURL: string;
let lastBody: Record<string, unknown> | undefined;
let lastAuth: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url !== '/search' || req.method !== 'POST') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      lastAuth = req.headers['authorization'] as string | undefined;
      const query = lastBody['query'] as string;
      if (query === '__auth__') {
        res.statusCode = 401;
        res.end('no');
        return;
      }
      if (query === '__rate__') {
        res.statusCode = 429;
        res.end('slow down');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          query,
          answer: query === '__answer__' ? 'one-line' : undefined,
          results: [
            {
              title: 'Hit',
              url: 'https://example.com/1',
              content: 'a clean snippet',
              score: 0.9,
              published_date: '2024-01-01',
            },
            { title: 'Hit2', url: 'https://example.com/2', content: 'another' },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('TavilySearchBackend', () => {
  it('sends Bearer auth and JSON body, maps content to snippet', async () => {
    const b = new TavilySearchBackend({ apiKey: 'tvly-X', baseURL });
    const r = await b.search('hello', { topK: 4 });
    expect(lastAuth).toBe('Bearer tvly-X');
    expect(lastBody).toMatchObject({
      query: 'hello',
      max_results: 4,
      search_depth: 'basic',
      include_answer: false,
    });
    expect(r.provider).toBe('tavily');
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toMatchObject({
      title: 'Hit',
      url: 'https://example.com/1',
      snippet: 'a clean snippet',
    });
    expect(r.results[0]?.meta?.['score']).toBe(0.9);
  });

  it('surfaces synthesized answer when present', async () => {
    const b = new TavilySearchBackend({ apiKey: 'k', baseURL, includeAnswer: true });
    const r = await b.search('__answer__');
    expect(lastBody?.['include_answer']).toBe(true);
    expect(r.answer).toBe('one-line');
  });

  it('passes search_depth=advanced when configured', async () => {
    const b = new TavilySearchBackend({ apiKey: 'k', baseURL, searchDepth: 'advanced' });
    await b.search('x');
    expect(lastBody?.['search_depth']).toBe('advanced');
  });

  it('throws SearchError(auth) on 401', async () => {
    const b = new TavilySearchBackend({ apiKey: 'k', baseURL });
    await expect(b.search('__auth__')).rejects.toMatchObject({
      name: 'SearchError',
      kind: 'auth',
    });
  });

  it('throws SearchError(rate_limit) on 429', async () => {
    const b = new TavilySearchBackend({ apiKey: 'k', baseURL });
    await expect(b.search('__rate__')).rejects.toBeInstanceOf(SearchError);
  });

  it('rejects empty key', () => {
    expect(() => new TavilySearchBackend({ apiKey: '' })).toThrow(/apiKey/);
  });
});
