import { MemoryClient } from 'mem0ai';

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
 * mem0 backend (https://github.com/mem0ai/mem0).
 *
 * Two deployment modes:
 *   - **Cloud** — `MEM0_API_KEY` against the hosted service (default).
 *   - **Self-hosted** — `MEM0_API_KEY` + `MEM0_BASE_URL` pointed at a
 *     local mem0 server (Docker compose).
 *
 * Mapping our `MemoryStore` interface onto mem0's API:
 *
 *   - `MemoryNamespace.userId`  → mem0 `userId`
 *   - `MemoryNamespace.agentId` → mem0 `agentId`
 *   - `MemoryNamespace.threadId`→ mem0 `runId`
 *   - `MemoryEntry.key`         → metadata `kvKey`
 *   - `MemoryEntry.value`       → metadata `kvValue` (JSON-encoded)
 *   - `MemoryEntry.tags`        → metadata `tags`
 *   - `MemoryEntry.pinned`      → metadata `pinned`
 *   - `MemoryEntry.source`      → metadata `source`
 *
 * KV path uses `infer: false` so mem0 stores text verbatim. Ingestion
 * path uses `infer: true` (default) — that's mem0's actual job.
 *
 * **Default userId.** mem0 requires at least one of userId/agentId/runId
 * on every call. We fall back to `defaultUserId` (constructor option,
 * or `MEM0_USER_ID` env, or `'harness'`) when the caller doesn't
 * supply one.
 */

export interface Mem0StoreOptions {
  apiKey: string;
  /** Base URL for self-hosted servers. Omit for the hosted service. */
  baseURL?: string;
  /** Fallback userId when callers don't pass a namespace. */
  defaultUserId?: string;
}

interface Mem0Memory {
  id: string;
  memory?: string;
  userId?: string;
  agentId?: string | null;
  appId?: string | null;
  runId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  score?: number;
}

export class Mem0Store implements MemoryStore {
  readonly capabilities: MemoryCapabilities = {
    semanticSearch: true,
    ingestion: true,
    persistent: true,
    crossProcess: true,
  };

  private readonly client: MemoryClient;
  private readonly defaultUserId: string;

  constructor(opts: Mem0StoreOptions) {
    this.defaultUserId = opts.defaultUserId ?? 'harness';
    const clientOpts: Record<string, unknown> = { apiKey: opts.apiKey };
    if (opts.baseURL) clientOpts['host'] = opts.baseURL;
    // The SDK type for ClientOptions varies between minor versions; we
    // intentionally pass through a plain record.
    this.client = new MemoryClient(clientOpts as never);
  }

  // ─── KV path ─────────────────────────────────────────────────────────

  async set(key: string, value: unknown, opts: MemorySetOptions = {}): Promise<MemoryEntry> {
    const ns = this.resolveNamespace(opts);
    const content = stringify(value);
    const metadata = {
      kvKey: key,
      kvValue: JSON.stringify(value),
      pinned: opts.pinned ?? false,
      tags: opts.tags ?? [],
      source: opts.source ?? 'agent',
    };
    // If an entry with this key already exists, delete first so mem0
    // doesn't accumulate duplicates. mem0's id is content-derived, not
    // metadata-derived, so re-adding can mint a new id.
    const existing = await this.findByKey(key, ns);
    if (existing) await this.client.delete(existing.id);

    const created = (await this.client.add(
      [{ role: 'user', content }],
      {
        ...this.entityOptions(ns),
        metadata,
        infer: false,
      },
    )) as Mem0Memory[];
    const first = created[0];
    if (!first) {
      throw new Error('mem0.add returned no memories');
    }
    return this.toEntry(first, { key, value, scope: opts.scope ?? 'global' });
  }

  async get(key: string, opts: MemoryGetOptions = {}): Promise<MemoryEntry | undefined> {
    const ns = this.resolveNamespace(opts);
    const found = await this.findByKey(key, ns);
    if (!found) return undefined;
    return this.toEntry(found, { key, scope: opts.scope ?? 'global' });
  }

  async update(
    key: string,
    patch: Partial<Pick<MemoryEntry, 'value' | 'content' | 'pinned' | 'tags' | 'source'>>,
    opts: MemoryGetOptions = {},
  ): Promise<MemoryEntry | undefined> {
    const ns = this.resolveNamespace(opts);
    const existing = await this.findByKey(key, ns);
    if (!existing) return undefined;
    const meta = { ...(existing.metadata ?? {}) };
    if (patch.pinned !== undefined) meta['pinned'] = patch.pinned;
    if (patch.tags !== undefined) meta['tags'] = patch.tags;
    if (patch.source !== undefined) meta['source'] = patch.source;
    if (patch.value !== undefined) meta['kvValue'] = JSON.stringify(patch.value);
    const newText =
      patch.content !== undefined
        ? patch.content
        : patch.value !== undefined
          ? stringify(patch.value)
          : undefined;
    await this.client.update(existing.id, {
      ...(newText !== undefined ? { text: newText } : {}),
      metadata: meta,
    });
    const refreshed = (await this.client.get(existing.id)) as Mem0Memory;
    return this.toEntry(refreshed, { key, scope: opts.scope ?? 'global' });
  }

  async delete(key: string, opts: MemoryGetOptions = {}): Promise<boolean> {
    const ns = this.resolveNamespace(opts);
    const found = await this.findByKey(key, ns);
    if (!found) return false;
    await this.client.delete(found.id);
    return true;
  }

  // ─── Ingestion ───────────────────────────────────────────────────────

  async ingest(input: MemoryIngestInput): Promise<MemoryEntry[]> {
    const ns = this.resolveNamespace(input);
    const created = (await this.client.add(
      input.messages.map((m) => ({
        // mem0 supports 'user' | 'assistant'; map 'system' to 'user'.
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
      {
        ...this.entityOptions(ns),
        metadata: {
          tags: input.tags ?? [],
          pinned: input.pinned ?? false,
          source: 'extracted',
        },
        // Default infer=true — let mem0 do its LLM-driven fact extraction.
      },
    )) as Mem0Memory[];
    return created.map((m) => this.toEntry(m, { scope: input.scope ?? 'global' }));
  }

  // ─── Universal ───────────────────────────────────────────────────────

  async list(opts: MemoryListOptions = {}): Promise<MemoryEntry[]> {
    const ns = this.resolveNamespace(opts);
    const all = await this.fetchAll(ns);
    let entries = all.map((m) => this.toEntry(m, { scope: opts.scope ?? 'global' }));
    if (opts.prefix !== undefined) {
      entries = entries.filter((e) => e.key?.startsWith(opts.prefix!) ?? false);
    }
    if (opts.tag !== undefined) entries = entries.filter((e) => e.tags.includes(opts.tag!));
    if (opts.pinnedOnly) entries = entries.filter((e) => e.pinned);
    if (opts.limit !== undefined) entries = entries.slice(0, opts.limit);
    return entries;
  }

  async search(query: string, opts: MemorySearchOptions = {}): Promise<MemorySearchHit[]> {
    const ns = this.resolveNamespace(opts);
    const result = (await this.client.search(query, {
      ...this.entityOptions(ns),
      ...(opts.topK !== undefined ? { topK: opts.topK } : {}),
    })) as { results: Mem0Memory[] };
    return result.results.map((m) => ({
      entry: this.toEntry(m, { scope: opts.scope ?? 'global' }),
      score: typeof m.score === 'number' ? m.score : 0,
      reason: 'semantic' as const,
    }));
  }

  async pinned(opts: MemoryGetOptions = {}): Promise<MemoryEntry[]> {
    return this.list({ ...opts, pinnedOnly: true });
  }

  async close(): Promise<void> {
    /* mem0 SDK is HTTP-based; no resources to release. */
  }

  // ─── helpers ─────────────────────────────────────────────────────────

  private resolveNamespace(
    opts: { scope?: 'global' | 'thread'; namespace?: MemoryNamespace } | MemoryIngestInput,
  ): MemoryNamespace {
    const ns = opts.namespace ?? {};
    return {
      userId: ns.userId ?? this.defaultUserId,
      ...(ns.agentId !== undefined ? { agentId: ns.agentId } : {}),
      ...(ns.threadId !== undefined ? { threadId: ns.threadId } : {}),
    };
  }

  private entityOptions(ns: MemoryNamespace): Record<string, unknown> {
    return {
      ...(ns.userId !== undefined ? { userId: ns.userId } : {}),
      ...(ns.agentId !== undefined ? { agentId: ns.agentId } : {}),
      ...(ns.threadId !== undefined ? { runId: ns.threadId } : {}),
    };
  }

  private async fetchAll(ns: MemoryNamespace): Promise<Mem0Memory[]> {
    // getAll returns paginated; for phase 1 we pull the first page only.
    // Real production code would loop; we'll add pagination on demand.
    const page = (await this.client.getAll({
      ...this.entityOptions(ns),
      pageSize: 100,
    } as never)) as { results?: Mem0Memory[] } | Mem0Memory[];
    if (Array.isArray(page)) return page;
    return page.results ?? [];
  }

  private async findByKey(key: string, ns: MemoryNamespace): Promise<Mem0Memory | undefined> {
    const all = await this.fetchAll(ns);
    return all.find((m) => (m.metadata as Record<string, unknown> | null)?.['kvKey'] === key);
  }

  private toEntry(
    m: Mem0Memory,
    extras: { key?: string; value?: unknown; scope: 'global' | 'thread' },
  ): MemoryEntry {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    const kvKey = (meta['kvKey'] as string | undefined) ?? extras.key;
    const kvValueRaw = meta['kvValue'] as string | undefined;
    const value =
      extras.value !== undefined
        ? extras.value
        : kvValueRaw !== undefined
          ? safeJsonParse(kvValueRaw)
          : undefined;
    const ns: MemoryNamespace = {
      ...(m.userId ? { userId: m.userId } : {}),
      ...(m.agentId ? { agentId: m.agentId } : {}),
      ...(m.runId ? { threadId: m.runId as never } : {}),
    };
    return {
      id: m.id,
      ...(kvKey !== undefined ? { key: kvKey } : {}),
      content: m.memory ?? '',
      ...(value !== undefined ? { value } : {}),
      scope: extras.scope,
      namespace: ns,
      pinned: meta['pinned'] === true,
      tags: Array.isArray(meta['tags']) ? (meta['tags'] as string[]) : [],
      source: (meta['source'] as MemoryEntry['source']) ?? 'agent',
      createdAt: toIso(m.createdAt),
      updatedAt: toIso(m.updatedAt),
    };
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toIso(value: string | Date | undefined): string {
  if (!value) return new Date().toISOString();
  if (typeof value === 'string') return value;
  return value.toISOString();
}
