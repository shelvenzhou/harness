import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { EventId, ThreadId } from '@harness/core/ids.js';
import type { HarnessEvent, ElidedMeta } from '@harness/core/events.js';
import type { Thread } from '@harness/core/thread.js';

import { MemorySessionStore, type AppendInput, type SessionStore } from './sessionStore.js';

/**
 * Thin JSONL backend composed on top of MemorySessionStore.
 *
 * Layout:
 *   <root>/<threadId>/meta.json          — Thread record (rewritten on update)
 *   <root>/<threadId>/events.jsonl       — append-only event log (one JSON per line)
 *
 * Not a production-grade store. Good enough for local dev, resume, and
 * inspecting a session after the fact. Future: swap for SQLite.
 */

export interface JsonlBackendOptions {
  root: string;
}

export class JsonlSessionStore implements SessionStore {
  private mem = new MemorySessionStore();
  private readonly root: string;
  private ready: Promise<void>;

  constructor(opts: JsonlBackendOptions) {
    this.root = opts.root;
    this.ready = this.initialLoad();
  }

  private async initialLoad(): Promise<void> {
    if (!existsSync(this.root)) {
      await mkdir(this.root, { recursive: true });
      return;
    }
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = join(this.root, entry.name, 'meta.json');
      const eventsPath = join(this.root, entry.name, 'events.jsonl');
      if (!existsSync(metaPath)) continue;
      const thread = JSON.parse(await readFile(metaPath, 'utf8')) as Thread;
      await this.mem.createThread({
        id: thread.id,
        rootTraceparent: thread.rootTraceparent,
        ...(thread.title !== undefined ? { title: thread.title } : {}),
        ...(thread.parentThreadId !== undefined ? { parentThreadId: thread.parentThreadId } : {}),
        ...(thread.latestCheckpointAtEventId !== undefined
          ? { latestCheckpointAtEventId: thread.latestCheckpointAtEventId }
          : {}),
        status: thread.status,
      });
      if (existsSync(eventsPath)) {
        const lines = (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean);
        for (const line of lines) {
          const ev = JSON.parse(line) as HarnessEvent;
          await this.mem.append({
            ...ev,
            id: ev.id,
            createdAt: ev.createdAt,
          } as AppendInput);
        }
      }
    }
  }

  async createThread(input: Parameters<SessionStore['createThread']>[0]): Promise<Thread> {
    await this.ready;
    const thread = await this.mem.createThread(input);
    await this.writeMeta(thread);
    return thread;
  }

  async getThread(threadId: ThreadId): Promise<Thread | undefined> {
    await this.ready;
    return this.mem.getThread(threadId);
  }

  async listThreads(): Promise<Thread[]> {
    await this.ready;
    return this.mem.listThreads();
  }

  async updateThread(
    threadId: ThreadId,
    patch: Parameters<SessionStore['updateThread']>[1],
  ): Promise<Thread> {
    await this.ready;
    const thread = await this.mem.updateThread(threadId, patch);
    await this.writeMeta(thread);
    return thread;
  }

  async append(input: AppendInput): Promise<HarnessEvent> {
    await this.ready;
    const event = await this.mem.append(input);
    await appendEvent(this.root, event);
    return event;
  }

  async readAll(threadId: ThreadId): Promise<HarnessEvent[]> {
    await this.ready;
    return this.mem.readAll(threadId);
  }

  async readSince(threadId: ThreadId, afterEventId?: EventId): Promise<HarnessEvent[]> {
    await this.ready;
    return this.mem.readSince(threadId, afterEventId);
  }

  async getEvent(threadId: ThreadId, eventId: EventId): Promise<HarnessEvent | undefined> {
    await this.ready;
    return this.mem.getEvent(threadId, eventId);
  }

  async attachElision(threadId: ThreadId, eventId: EventId, elided: ElidedMeta): Promise<void> {
    await this.ready;
    await this.mem.attachElision(threadId, eventId, elided);
    // Elision changes the canonical event payload; we don't rewrite the
    // JSONL (append-only). The memory view is the truth going forward, and
    // a load+replay would reapply elision from the tool result payload
    // itself. For phase 1 this is acceptable.
  }

  async close(): Promise<void> {
    await this.mem.close();
  }

  private async writeMeta(thread: Thread): Promise<void> {
    const dir = join(this.root, thread.id);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'meta.json'), JSON.stringify(thread, null, 2), 'utf8');
  }
}

async function appendEvent(root: string, event: HarnessEvent): Promise<void> {
  const path = join(root, event.threadId, 'events.jsonl');
  if (!existsSync(dirname(path))) {
    await mkdir(dirname(path), { recursive: true });
  }
  await appendFile(path, JSON.stringify(event) + '\n', 'utf8');
}
