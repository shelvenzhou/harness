import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GoogleSearchBackend } from '@harness/search/googleSearch.js';
import { SearchError } from '@harness/search/types.js';

let server: Server;
let baseURL: string;
const requestLog: Array<{ url: string; query: Record<string, string | null> }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    requestLog.push({
      url: req.url ?? '',
      query: Object.fromEntries(u.searchParams.entries()),
    });
    if (u.searchParams.get('cx') === 'bad-cx') {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    if (u.searchParams.get('q') === 'rate') {
      res.statusCode = 429;
      res.end('rate');
      return;
    }
    if (u.searchParams.get('q') === 'broken') {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end('{');
      return;
    }
    const start = Number(u.searchParams.get('start') ?? '1');
    const num = Number(u.searchParams.get('num') ?? '10');
    const items = Array.from({ length: num }, (_, i) => ({
      title: `Title ${start + i}`,
      link: `https://example.com/${start + i}`,
      snippet: `Snippet ${start + i}`,
      displayLink: 'example.com',
    }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ items }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${addr.port}/customsearch`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GoogleSearchBackend', () => {
  it('maps items to SearchResult shape', async () => {
    const b = new GoogleSearchBackend({ apiKey: 'k', cx: 'cx', baseURL });
    const r = await b.search('hello', { topK: 3 });
    expect(r.provider).toBe('google');
    expect(r.results).toHaveLength(3);
    expect(r.results[0]).toMatchObject({
      title: 'Title 1',
      url: 'https://example.com/1',
      snippet: 'Snippet 1',
    });
  });

  it('paginates when topK > 10', async () => {
    const b = new GoogleSearchBackend({ apiKey: 'k', cx: 'cx', baseURL });
    const before = requestLog.length;
    const r = await b.search('paginate', { topK: 15 });
    const pages = requestLog.slice(before);
    expect(r.results).toHaveLength(15);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0]?.query['start']).toBe('1');
    expect(pages[1]?.query['start']).toBe('11');
  });

  it('caps topK at 30 (3 pages × 10)', async () => {
    const b = new GoogleSearchBackend({ apiKey: 'k', cx: 'cx', baseURL });
    const r = await b.search('cap', { topK: 100 });
    expect(r.results.length).toBeLessThanOrEqual(30);
  });

  it('passes safe=active by default and safe=off when requested', async () => {
    const b = new GoogleSearchBackend({ apiKey: 'k', cx: 'cx', baseURL });
    const before = requestLog.length;
    await b.search('safe-default', { topK: 1 });
    expect(requestLog[before]?.query['safe']).toBe('active');
    await b.search('safe-off', { topK: 1, safe: 'off' });
    expect(requestLog[before + 1]?.query['safe']).toBe('off');
  });

  it('throws SearchError(auth) on 403', async () => {
    const b = new GoogleSearchBackend({ apiKey: 'k', cx: 'bad-cx', baseURL });
    await expect(b.search('x')).rejects.toMatchObject({
      name: 'SearchError',
      kind: 'auth',
    });
  });

  it('throws SearchError(rate_limit) on 429', async () => {
    const b = new GoogleSearchBackend({ apiKey: 'k', cx: 'cx', baseURL });
    await expect(b.search('rate')).rejects.toBeInstanceOf(SearchError);
    await expect(b.search('rate')).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('rejects empty config', () => {
    expect(() => new GoogleSearchBackend({ apiKey: '', cx: 'cx' })).toThrow(/apiKey/);
    expect(() => new GoogleSearchBackend({ apiKey: 'k', cx: '' })).toThrow(/cx/);
  });
});
