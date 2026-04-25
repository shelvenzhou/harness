import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { InMemoryStore } from './inMemoryStore.js';
import type {
  MemoryCapabilities,
  MemoryEntry,
  MemoryGetOptions,
  MemoryIngestInput,
  MemoryListOptions,
  MemorySearchHit,
  MemorySearchOptions,
  MemorySetOptions,
  MemoryStore,
} from './types.js';

/**
 * JSONL-backed persistent memory.
 *
 * Composition: we keep an `InMemoryStore` as the in-memory truth and
 * append a **write-ahead log** (one JSON line per mutation) to a file.
 * On construction we replay the file to rebuild state.
 *
 * Crash safety: each mutation is `appendFile` + flush. Lines smaller
 * than PIPE_BUF (4 KB on Linux) are atomic; entries that exceed it are
 * still safe because we replay strictly with `JSON.parse` and skip
 * malformed trailing lines on load.
 *
 * **Single writer assumption**: this backend does not lock the file.
 * Two harness processes pointed at the same path will interleave writes
 * and corrupt each other's state. For multi-process sharing use mem0
 * (or a real DB).
 */

export interface JsonlMemoryStoreOptions {
  /** Path to the JSONL log file. Created if missing, with parent dirs. */
  path: string;
}

type LogEntry =
  | { op: 'set'; key: string; value: unknown; opts: MemorySetOptions; ts: string }
  | {
      op: 'update';
      key: string;
      patch: Partial<Pick<MemoryEntry, 'value' | 'content' | 'pinned' | 'tags' | 'source'>>;
      opts: MemoryGetOptions;
      ts: string;
    }
  | { op: 'delete'; key: string; opts: MemoryGetOptions; ts: string }
  | { op: 'ingest'; input: MemoryIngestInput; ids: string[]; ts: string };

export class JsonlMemoryStore implements MemoryStore {
  readonly capabilities: MemoryCapabilities = {
    semanticSearch: false,
    ingestion: false,
    persistent: true,
    crossProcess: false,
  };

  private readonly path: string;
  private readonly mem = new InMemoryStore();
  private ready: Promise<void>;
  /** Serialise appends so concurrent writes within the same process keep order. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: JsonlMemoryStoreOptions) {
    this.path = opts.path;
    this.ready = this.replay();
  }

  private async replay(): Promise<void> {
    const dir = dirname(this.path);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    if (!existsSync(this.path)) return;
    const raw = await readFile(this.path, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: LogEntry;
      try {
        entry = JSON.parse(trimmed) as LogEntry;
      } catch {
        // Tolerate a torn trailing line from a prior crash.
        continue;
      }
      await this.applyLogEntry(entry);
    }
  }

  private async applyLogEntry(entry: LogEntry): Promise<void> {
    switch (entry.op) {
      case 'set':
        await this.mem.set(entry.key, entry.value, entry.opts);
        return;
      case 'update':
        await this.mem.update(entry.key, entry.patch, entry.opts);
        return;
      case 'delete':
        await this.mem.delete(entry.key, entry.opts);
        return;
      case 'ingest':
        // For ingest we re-run the in-memory ingest (which mints fresh
        // ids); to keep ids stable across replays we'd need richer
        // persistence. This backend isn't ingestion-strong anyway —
        // the LLM-extraction case belongs to mem0.
        await this.mem.ingest(entry.input);
        return;
    }
  }

  private appendLog(entry: LogEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => appendFile(this.path, line, 'utf-8'));
    return this.writeChain;
  }

  // ─── MemoryStore impl ────────────────────────────────────────────────

  async get(key: string, opts: MemoryGetOptions = {}): Promise<MemoryEntry | undefined> {
    await this.ready;
    return this.mem.get(key, opts);
  }

  async set(key: string, value: unknown, opts: MemorySetOptions = {}): Promise<MemoryEntry> {
    await this.ready;
    const entry = await this.mem.set(key, value, opts);
    await this.appendLog({ op: 'set', key, value, opts, ts: new Date().toISOString() });
    return entry;
  }

  async update(
    key: string,
    patch: Partial<Pick<MemoryEntry, 'value' | 'content' | 'pinned' | 'tags' | 'source'>>,
    opts: MemoryGetOptions = {},
  ): Promise<MemoryEntry | undefined> {
    await this.ready;
    const updated = await this.mem.update(key, patch, opts);
    if (updated) {
      await this.appendLog({ op: 'update', key, patch, opts, ts: new Date().toISOString() });
    }
    return updated;
  }

  async delete(key: string, opts: MemoryGetOptions = {}): Promise<boolean> {
    await this.ready;
    const ok = await this.mem.delete(key, opts);
    if (ok) {
      await this.appendLog({ op: 'delete', key, opts, ts: new Date().toISOString() });
    }
    return ok;
  }

  async ingest(input: MemoryIngestInput): Promise<MemoryEntry[]> {
    await this.ready;
    const out = await this.mem.ingest(input);
    await this.appendLog({
      op: 'ingest',
      input,
      ids: out.map((e) => e.id),
      ts: new Date().toISOString(),
    });
    return out;
  }

  async list(opts?: MemoryListOptions): Promise<MemoryEntry[]> {
    await this.ready;
    return this.mem.list(opts);
  }

  async search(query: string, opts?: MemorySearchOptions): Promise<MemorySearchHit[]> {
    await this.ready;
    return this.mem.search(query, opts);
  }

  async pinned(opts?: MemoryGetOptions): Promise<MemoryEntry[]> {
    await this.ready;
    return this.mem.pinned(opts);
  }

  async close(): Promise<void> {
    await this.writeChain.catch(() => undefined);
    await this.mem.close();
  }
}
