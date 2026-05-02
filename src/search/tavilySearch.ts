import {
  SearchError,
  type SearchBackend,
  type SearchOptions,
  type SearchResponse,
  type SearchResult,
} from './types.js';

/**
 * Tavily search backend.
 *
 *   POST https://api.tavily.com/search
 *     Authorization: Bearer <TAVILY_API_KEY>
 *     Body: { query, max_results, search_depth, include_answer }
 *
 * Tavily is purpose-built for LLM consumption — `content` is a clean
 * snippet rather than the SERP-style fragment Google returns, and the
 * optional `answer` is a synthesized one-liner. We map `content` →
 * `SearchResult.snippet` and surface `answer` on the response when
 * present.
 */

const DEFAULT_BASE_URL = 'https://api.tavily.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESULTS_HARD_CAP = 20;

export interface TavilySearchOptions {
  apiKey: string;
  /** Override endpoint (testing). */
  baseURL?: string;
  /** 'basic' (default) or 'advanced'. */
  searchDepth?: 'basic' | 'advanced';
  /** If true, request a synthesized one-line answer alongside results. */
  includeAnswer?: boolean;
}

interface TavilyApiResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
}

interface TavilyApiResponse {
  query?: string;
  answer?: string;
  results?: TavilyApiResult[];
  detail?: string;
  error?: string;
}

export class TavilySearchBackend implements SearchBackend {
  readonly name = 'tavily';

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly searchDepth: 'basic' | 'advanced';
  private readonly includeAnswer: boolean;

  constructor(opts: TavilySearchOptions) {
    if (!opts.apiKey) throw new SearchError('config', 'TavilySearchBackend: apiKey required');
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL ?? DEFAULT_BASE_URL;
    this.searchDepth = opts.searchDepth ?? 'basic';
    this.includeAnswer = opts.includeAnswer ?? false;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    const maxResults = Math.max(1, Math.min(opts.topK ?? 10, MAX_RESULTS_HARD_CAP));
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const url = `${this.baseURL.replace(/\/$/, '')}/search`;

    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
    timer.unref();
    const linkAbort = () => timeoutCtl.abort();
    if (opts.signal) opts.signal.addEventListener('abort', linkAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        signal: timeoutCtl.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          search_depth: this.searchDepth,
          include_answer: this.includeAnswer,
        }),
      });
    } catch (err) {
      const aborted = (err as { name?: string }).name === 'AbortError';
      throw new SearchError(
        aborted ? 'aborted' : 'transport',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', linkAbort);
    }

    if (response.status === 401 || response.status === 403) {
      throw new SearchError('auth', `tavily auth failed (${response.status})`, response.status);
    }
    if (response.status === 429) {
      throw new SearchError('rate_limit', 'tavily rate limited', response.status);
    }
    if (!response.ok) {
      const detail = await safeText(response);
      throw new SearchError(
        'http',
        `tavily http ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        response.status,
      );
    }

    let body: TavilyApiResponse;
    try {
      body = (await response.json()) as TavilyApiResponse;
    } catch (err) {
      throw new SearchError('parse', err instanceof Error ? err.message : String(err));
    }
    if (body.error) {
      throw new SearchError('http', body.error);
    }

    const results: SearchResult[] = (body.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
      meta: {
        ...(typeof r.score === 'number' ? { score: r.score } : {}),
        ...(r.published_date ? { publishedDate: r.published_date } : {}),
      },
    }));

    return {
      query,
      provider: this.name,
      results,
      ...(body.answer ? { answer: body.answer } : {}),
    };
  }
}

async function safeText(r: Response): Promise<string | undefined> {
  try {
    return await r.text();
  } catch {
    return undefined;
  }
}
