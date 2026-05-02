import {
  SearchError,
  type SearchBackend,
  type SearchOptions,
  type SearchResponse,
  type SearchResult,
} from './types.js';

/**
 * Google Programmable Search (Custom Search JSON API).
 *
 *   GET https://www.googleapis.com/customsearch/v1
 *     ?key=<API_KEY>&cx=<CX>&q=<query>&num=<1..10>&start=<1..>
 *
 * Each request returns at most 10 items; `topK > 10` paginates up to
 * `MAX_PAGES`. The CSE quota for the free tier is 100 queries/day, so
 * pagination is bounded conservatively.
 */

const DEFAULT_BASE_URL = 'https://www.googleapis.com/customsearch/v1';
const PAGE_SIZE = 10;
const MAX_PAGES = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface GoogleSearchOptions {
  apiKey: string;
  /** Programmable Search Engine ID (the `cx` parameter). */
  cx: string;
  /** Override endpoint (testing / proxying). Defaults to Google's. */
  baseURL?: string;
}

interface GoogleApiItem {
  title?: string;
  link?: string;
  snippet?: string;
  displayLink?: string;
  formattedUrl?: string;
}

interface GoogleApiResponse {
  items?: GoogleApiItem[];
  error?: { code?: number; message?: string };
}

export class GoogleSearchBackend implements SearchBackend {
  readonly name = 'google';

  private readonly apiKey: string;
  private readonly cx: string;
  private readonly baseURL: string;

  constructor(opts: GoogleSearchOptions) {
    if (!opts.apiKey) throw new SearchError('config', 'GoogleSearchBackend: apiKey required');
    if (!opts.cx) throw new SearchError('config', 'GoogleSearchBackend: cx required');
    this.apiKey = opts.apiKey;
    this.cx = opts.cx;
    this.baseURL = opts.baseURL ?? DEFAULT_BASE_URL;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    const topK = Math.max(1, Math.min(opts.topK ?? PAGE_SIZE, PAGE_SIZE * MAX_PAGES));
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const safe = opts.safe === 'off' ? 'off' : 'active';

    const collected: SearchResult[] = [];
    let start = 1;
    while (collected.length < topK) {
      const remaining = topK - collected.length;
      const num = Math.min(PAGE_SIZE, remaining);
      const page = await this.fetchPage(query, num, start, safe, opts.signal, timeoutMs);
      if (page.length === 0) break;
      collected.push(...page);
      if (page.length < num) break;
      start += page.length;
    }

    return { query, provider: this.name, results: collected.slice(0, topK) };
  }

  private async fetchPage(
    query: string,
    num: number,
    start: number,
    safe: 'active' | 'off',
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<SearchResult[]> {
    const url = new URL(this.baseURL);
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('cx', this.cx);
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(num));
    url.searchParams.set('start', String(start));
    url.searchParams.set('safe', safe);

    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
    timer.unref();
    const linkAbort = () => timeoutCtl.abort();
    if (signal) signal.addEventListener('abort', linkAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', signal: timeoutCtl.signal });
    } catch (err) {
      const aborted = (err as { name?: string }).name === 'AbortError';
      throw new SearchError(
        aborted ? 'aborted' : 'transport',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', linkAbort);
    }

    if (response.status === 401 || response.status === 403) {
      throw new SearchError('auth', `google search auth failed (${response.status})`, response.status);
    }
    if (response.status === 429) {
      throw new SearchError('rate_limit', 'google search rate limited', response.status);
    }
    if (!response.ok) {
      const detail = await safeText(response);
      throw new SearchError(
        'http',
        `google search http ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        response.status,
      );
    }

    let body: GoogleApiResponse;
    try {
      body = (await response.json()) as GoogleApiResponse;
    } catch (err) {
      throw new SearchError('parse', err instanceof Error ? err.message : String(err));
    }
    if (body.error) {
      throw new SearchError('http', body.error.message ?? 'google search error', body.error.code);
    }
    const items = body.items ?? [];
    return items.map((it) => ({
      title: it.title ?? '',
      url: it.link ?? '',
      snippet: it.snippet ?? '',
      meta: {
        ...(it.displayLink ? { displayLink: it.displayLink } : {}),
        ...(it.formattedUrl ? { formattedUrl: it.formattedUrl } : {}),
      },
    }));
  }
}

async function safeText(r: Response): Promise<string | undefined> {
  try {
    return await r.text();
  } catch {
    return undefined;
  }
}
