/**
 * Search backend interface. Mirrors the `MemoryStore` shape: the
 * `web_search` tool is thin glue, and concrete providers (Google,
 * Tavily, …) implement this contract.
 *
 * Tools access a backend via `ctx.services.searchBackend`. The runtime
 * injects whatever the bootstrap layer wired up; if no backend is
 * configured, the tool returns `unsupported` so the model knows search
 * is disabled rather than silently no-oping.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Backend-specific extras (publishedDate, source, score, …). */
  meta?: Record<string, unknown>;
}

export interface SearchOptions {
  /** Cap on returned results. Backends may cap further. Default 10. */
  topK?: number;
  /** Safe-search level; backends map to their own knob. */
  safe?: 'off' | 'moderate' | 'strict';
  /** Abortable. */
  signal?: AbortSignal;
  /** Hard timeout in ms; default 15 000. */
  timeoutMs?: number;
}

export interface SearchResponse {
  query: string;
  provider: string;
  results: SearchResult[];
  /** Optional one-shot answer some backends synthesize (e.g., Tavily). */
  answer?: string;
}

export interface SearchBackend {
  readonly name: string;
  search(query: string, opts?: SearchOptions): Promise<SearchResponse>;
}

export type SearchErrorKind =
  | 'config'
  | 'auth'
  | 'rate_limit'
  | 'http'
  | 'aborted'
  | 'transport'
  | 'parse';

export class SearchError extends Error {
  constructor(
    public readonly kind: SearchErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}
