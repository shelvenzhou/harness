import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { HarnessEvent } from '@harness/core/events.js';
import type { SamplingRequest } from '@harness/llm/provider.js';
import type { ThreadId, TurnId } from '@harness/core/ids.js';
import { renderPromptText } from '@harness/context/promptDebug.js';

import type { DiagSink } from './types.js';

/**
 * JSONL diag sink.
 *
 * Layout:
 *   <root>/<threadId>/trace.jsonl                  — every bus event + sampling_complete
 *   <root>/<threadId>/prompts/<turnId>-<N>.txt     — human-readable prompt dump
 *   <root>/<threadId>/prompts/<turnId>-<N>.json    — raw SamplingRequest
 *
 * Sinks are meant to be cheap on the hot path: writes are fire-and-forget
 * and lost on crash — this is debug data, not source of truth.
 */
export interface JsonlDiagSinkOptions {
  root: string;
}

export class JsonlDiagSink implements DiagSink {
  readonly id = 'jsonl';
  private readonly root: string;
  private readySet = new Set<ThreadId>();

  constructor(opts: JsonlDiagSinkOptions) {
    this.root = opts.root;
  }

  async onPrompt(
    ctx: { threadId: ThreadId; turnId: TurnId; samplingIndex: number },
    request: SamplingRequest,
    _stats: {
      projectedItems: number;
      elidedCount: number;
      estimatedTokens: number;
      pinnedHandles: number;
    },
  ): Promise<string | undefined> {
    await this.ensureThreadDirs(ctx.threadId);
    const base = `${ctx.turnId}-${pad3(ctx.samplingIndex)}`;
    const txtPath = join(this.root, ctx.threadId, 'prompts', `${base}.txt`);
    const jsonPath = join(this.root, ctx.threadId, 'prompts', `${base}.json`);
    await writeFile(txtPath, renderPromptText(request), 'utf8');
    await writeFile(jsonPath, JSON.stringify(request, null, 2), 'utf8');
    return txtPath;
  }

  async onEvent(event: HarnessEvent): Promise<void> {
    try {
      await this.ensureThreadDirs(event.threadId);
      const path = join(this.root, event.threadId, 'trace.jsonl');
      await appendFile(path, JSON.stringify(event) + '\n', 'utf8');
    } catch {
      // Diagnostic writes must never throw into the runtime.
    }
  }

  async close(): Promise<void> {
    // Nothing to flush; appendFile is sync-enough per call.
  }

  private async ensureThreadDirs(threadId: ThreadId): Promise<void> {
    if (this.readySet.has(threadId)) return;
    const base = join(this.root, threadId);
    const prompts = join(base, 'prompts');
    if (!existsSync(base)) await mkdir(base, { recursive: true });
    if (!existsSync(prompts)) await mkdir(prompts, { recursive: true });
    this.readySet.add(threadId);
  }
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0');
}
