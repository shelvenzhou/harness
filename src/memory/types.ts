import type { ThreadId } from '@harness/core/ids.js';

/**
 * Memory subsystem.
 *
 * Designed to span backends with very different shapes:
 *
 *   - **In-process Map** — explicit KV, no persistence, no search.
 *   - **JSONL on disk** — explicit KV with substring search; persistent
 *     across processes on one machine.
 *   - **mem0** — message-list ingestion + LLM-extracted facts + vector
 *     search; cross-process; namespaced by user / agent / run.
 *   - **SQLite + embedding** — local semantic search, deterministic.
 *
 * The interface therefore exposes **two complementary paths** plus a
 * universal search:
 *
 *   1. KV path (`get` / `set` / `update` / `delete`) — explicit,
 *      deterministic, suits "remember my name = shelven".
 *   2. Ingestion path (`ingest`) — pass a slice of conversation;
 *      backends that support fact extraction (mem0) distil it; simpler
 *      backends append the raw text.
 *   3. `search` works against everything regardless of how it landed.
 *
 * Backends declare what they actually support via `capabilities`. Code
 * that depends on, say, semantic search can branch on it instead of
 * silently degrading.
 *
 * **Namespacing** — borrowed from mem0: user / agent / thread are three
 * orthogonal dimensions. `MemoryNamespace` carries them; backends that
 * only model one of them ignore the rest. `scope` is a coarse switch
 * for callers that don't want to deal with namespaces:
 *   - `'global'` (default): no thread filter, no agent filter; the
 *     userId, if set, still applies.
 *   - `'thread'`: scoped to a specific threadId.
 *
 * **Pinning** — an entry with `pinned: true` is included in the stable
 * prefix at sampling time so the model sees it without having to call
 * `memory.get`. Pinning is per-namespace.
 */

export type MemoryScope = 'global' | 'thread';

export type MemorySource = 'user' | 'agent' | 'system' | 'extracted';

export interface MemoryNamespace {
  /** Cross-session identity (a real person or service account). */
  userId?: string;
  /** Logical agent identity (e.g. 'researcher', 'compactor'). */
  agentId?: string;
  /** This thread / run. */
  threadId?: ThreadId;
}

export interface MemoryEntry {
  /** Stable id minted by the backend (uuid for mem0, key for KV stores). */
  id: string;
  /**
   * Optional human-readable key. KV-style backends treat it as the
   * primary lookup; ingestion backends store it as a tag/metadata so
   * `get(key)` can still round-trip.
   */
  key?: string;
  /** Searchable text representation. Always present. */
  content: string;
  /**
   * Original structured value when set via the KV path. Backends that
   * can't preserve structure (e.g. text-only stores) drop this.
   */
  value?: unknown;
  scope: MemoryScope;
  namespace: MemoryNamespace;
  pinned: boolean;
  tags: string[];
  source: MemorySource;
  createdAt: string; // ISO-8601
  updatedAt: string;
}

export interface MemoryCapabilities {
  /** Vector / embedding-based search rather than keyword. */
  semanticSearch: boolean;
  /** `ingest(messages)` runs LLM-driven fact extraction. */
  ingestion: boolean;
  /** Survives process restart. */
  persistent: boolean;
  /** Multiple harness processes can share the same store concurrently. */
  crossProcess: boolean;
}

export interface MemorySetOptions {
  scope?: MemoryScope;
  namespace?: MemoryNamespace;
  pinned?: boolean;
  tags?: string[];
  source?: MemorySource;
}

export interface MemoryGetOptions {
  scope?: MemoryScope;
  namespace?: MemoryNamespace;
}

export interface MemoryListOptions extends MemoryGetOptions {
  prefix?: string;
  tag?: string;
  pinnedOnly?: boolean;
  limit?: number;
}

export interface MemorySearchOptions extends MemoryGetOptions {
  topK?: number;
  tag?: string;
}

export interface MemorySearchHit {
  entry: MemoryEntry;
  /** Higher = better. Each backend defines its own scale. */
  score: number;
  reason?: 'exact' | 'prefix' | 'substring' | 'tag' | 'semantic';
}

export interface MemoryIngestMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface MemoryIngestInput {
  messages: MemoryIngestMessage[];
  scope?: MemoryScope;
  namespace?: MemoryNamespace;
  tags?: string[];
  /** Pin every extracted entry. Useful for "this is the user's name". */
  pinned?: boolean;
}

/**
 * Backend-agnostic memory interface. Every method is async so backends
 * can be I/O-bound (file, SQLite, mem0 HTTP) without leaking details
 * to callers.
 */
export interface MemoryStore {
  readonly capabilities: MemoryCapabilities;

  // ─── KV path ─────────────────────────────────────────────────────────
  get(key: string, opts?: MemoryGetOptions): Promise<MemoryEntry | undefined>;
  set(key: string, value: unknown, opts?: MemorySetOptions): Promise<MemoryEntry>;
  update(
    key: string,
    patch: Partial<Pick<MemoryEntry, 'value' | 'content' | 'pinned' | 'tags' | 'source'>>,
    opts?: MemoryGetOptions,
  ): Promise<MemoryEntry | undefined>;
  delete(key: string, opts?: MemoryGetOptions): Promise<boolean>;

  // ─── Ingestion path (mem0-style) ─────────────────────────────────────
  /**
   * Feed a slice of conversation. Backends with `ingestion: true` run
   * LLM-driven fact extraction and may produce zero or many entries.
   * Backends without ingestion store the raw concatenated text as one
   * entry (or throw — implementer's call; document in the backend).
   */
  ingest(input: MemoryIngestInput): Promise<MemoryEntry[]>;

  // ─── Universal access ────────────────────────────────────────────────
  list(opts?: MemoryListOptions): Promise<MemoryEntry[]>;
  search(query: string, opts?: MemorySearchOptions): Promise<MemorySearchHit[]>;
  /** All pinned entries for the given namespace (prefix-builder uses this). */
  pinned(opts?: MemoryGetOptions): Promise<MemoryEntry[]>;
  close(): Promise<void>;
}
