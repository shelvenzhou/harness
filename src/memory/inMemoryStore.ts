import { randomUUID } from 'node:crypto';

import type {
  MemoryCapabilities,
  MemoryEntry,
  MemoryGetOptions,
  MemoryIngestInput,
  MemoryListOptions,
  MemoryNamespace,
  MemorySearchHit,
  MemorySearchOptions,
  MemorySetOptions,
  MemoryStore,
} from './types.js';

/**
 * Reference backend: in-process, non-persistent. Useful for tests, the
 * REPL when no storage root is configured, and as the canonical
 * behaviour spec other backends should match (modulo the capabilities
 * they enable).
 *
 * Search is keyword/substring only — no embeddings.
 *
 * `ingest()` concatenates the message list into one entry tagged
 * `extracted` (no LLM extraction; mem0 does the real work).
 */
export class InMemoryStore implements MemoryStore {
  readonly capabilities: MemoryCapabilities = {
    semanticSearch: false,
    ingestion: false,
    persistent: false,
    crossProcess: false,
  };

  private readonly entries = new Map<string, MemoryEntry>();

  async get(key: string, opts: MemoryGetOptions = {}): Promise<MemoryEntry | undefined> {
    const id = composeId(key, opts);
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (!matchesNamespace(e, opts)) return undefined;
    return clone(e);
  }

  async set(key: string, value: unknown, opts: MemorySetOptions = {}): Promise<MemoryEntry> {
    const id = composeId(key, opts);
    const now = new Date().toISOString();
    const existing = this.entries.get(id);
    const ns = normaliseNamespace(opts);
    const entry: MemoryEntry = {
      id,
      key,
      content: stringify(value),
      value,
      scope: opts.scope ?? 'global',
      namespace: ns,
      pinned: opts.pinned ?? existing?.pinned ?? false,
      tags: opts.tags ?? existing?.tags ?? [],
      source: opts.source ?? existing?.source ?? 'user',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.entries.set(id, entry);
    return clone(entry);
  }

  async update(
    key: string,
    patch: Partial<Pick<MemoryEntry, 'value' | 'content' | 'pinned' | 'tags' | 'source'>>,
    opts: MemoryGetOptions = {},
  ): Promise<MemoryEntry | undefined> {
    const id = composeId(key, opts);
    const existing = this.entries.get(id);
    if (!existing) return undefined;
    const next: MemoryEntry = {
      ...existing,
      ...(patch.value !== undefined ? { value: patch.value, content: stringify(patch.value) } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.entries.set(id, next);
    return clone(next);
  }

  async delete(key: string, opts: MemoryGetOptions = {}): Promise<boolean> {
    return this.entries.delete(composeId(key, opts));
  }

  async ingest(input: MemoryIngestInput): Promise<MemoryEntry[]> {
    // No LLM extraction in this backend. Persist the raw transcript as
    // a single entry so the memory tool can at least round-trip.
    const text = input.messages.map((m) => `${m.role}: ${m.content}`).join('\n');
    const id = randomUUID();
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id,
      content: text,
      scope: input.scope ?? 'global',
      namespace: normaliseNamespace(input),
      pinned: input.pinned ?? false,
      tags: input.tags ?? [],
      source: 'extracted',
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(id, entry);
    return [clone(entry)];
  }

  async list(opts: MemoryListOptions = {}): Promise<MemoryEntry[]> {
    const prefix = opts.prefix;
    const tag = opts.tag;
    let out = [...this.entries.values()].filter((e) => matchesNamespace(e, opts));
    if (prefix !== undefined) out = out.filter((e) => e.key?.startsWith(prefix) ?? false);
    if (tag !== undefined) out = out.filter((e) => e.tags.includes(tag));
    if (opts.pinnedOnly) out = out.filter((e) => e.pinned);
    if (opts.limit !== undefined) out = out.slice(0, opts.limit);
    return out.map(clone);
  }

  async search(query: string, opts: MemorySearchOptions = {}): Promise<MemorySearchHit[]> {
    const q = query.toLowerCase();
    const candidates = [...this.entries.values()].filter((e) => matchesNamespace(e, opts));
    const hits: MemorySearchHit[] = [];
    for (const e of candidates) {
      if (opts.tag && !e.tags.includes(opts.tag)) continue;
      const k = (e.key ?? '').toLowerCase();
      const c = e.content.toLowerCase();
      if (k === q || c === q) hits.push({ entry: clone(e), score: 1.0, reason: 'exact' });
      else if (k.startsWith(q)) hits.push({ entry: clone(e), score: 0.8, reason: 'prefix' });
      else if (c.includes(q)) hits.push({ entry: clone(e), score: 0.5, reason: 'substring' });
    }
    hits.sort((a, b) => b.score - a.score);
    if (opts.topK !== undefined) return hits.slice(0, opts.topK);
    return hits;
  }

  async pinned(opts: MemoryGetOptions = {}): Promise<MemoryEntry[]> {
    return this.list({ ...opts, pinnedOnly: true });
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function composeId(key: string, opts: MemoryGetOptions | MemorySetOptions): string {
  // Compose a deterministic id from key + namespace so set(...) is upsert.
  const ns = normaliseNamespace(opts);
  return [
    opts.scope ?? 'global',
    ns.userId ?? '_',
    ns.agentId ?? '_',
    ns.threadId ?? '_',
    key,
  ].join('|');
}

function normaliseNamespace(
  opts: MemoryGetOptions | MemorySetOptions | MemoryIngestInput,
): MemoryNamespace {
  return opts.namespace ?? {};
}

function matchesNamespace(entry: MemoryEntry, opts: MemoryGetOptions): boolean {
  const want = opts.namespace ?? {};
  if (opts.scope && entry.scope !== opts.scope) return false;
  if (want.userId !== undefined && entry.namespace.userId !== want.userId) return false;
  if (want.agentId !== undefined && entry.namespace.agentId !== want.agentId) return false;
  if (want.threadId !== undefined && entry.namespace.threadId !== want.threadId) return false;
  return true;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
