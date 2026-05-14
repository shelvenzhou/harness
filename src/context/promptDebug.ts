import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { SamplingRequest } from '@harness/llm/provider.js';

/**
 * Prompt reconstruction — dumps the exact SamplingRequest going to the
 * provider as text + JSON, for offline inspection. First diagnostic tool
 * to reach for when the model misbehaves.
 */

export interface PromptDumpOptions {
  root: string;
  label?: string;
}

export function renderPromptText(request: SamplingRequest): string {
  const lines: string[] = [];
  lines.push('# system');
  lines.push(request.prefix.systemPrompt);
  // Pinned memory + compacted summary now appear as cache-tagged tail
  // items and get rendered in the # tail section below — keeping them
  // out of the prefix preserves the provider's prompt-prefix cache.
  lines.push('');
  lines.push(`# tools (${request.prefix.tools.length})`);
  for (const t of request.prefix.tools) lines.push(`- ${t.name}: ${t.description.split('\n')[0]}`);
  lines.push('');
  lines.push('# tail');
  for (const item of request.tail) {
    lines.push(`--- ${item.role}${item.cacheTag ? ` (cacheTag=${item.cacheTag})` : ''}`);
    for (const c of item.content) {
      switch (c.kind) {
        case 'text':
          lines.push(c.text);
          break;
        case 'tool_use':
          lines.push(`[tool_use ${c.name}] ${JSON.stringify(c.args)}`);
          break;
        case 'tool_result':
          lines.push(
            `[tool_result ok=${c.ok}] ${c.error ?? ''} ${JSON.stringify(c.output ?? null)}`,
          );
          break;
        case 'reasoning':
          lines.push(`[reasoning] ${c.text}`);
          break;
        case 'provider_state':
          lines.push(`[provider_state ${c.providerId}] ${JSON.stringify(c.items)}`);
          break;
        case 'elided':
          lines.push(`[elided handle=${c.handle} ${c.originKind}] ${c.summary ?? ''}`);
          break;
      }
    }
  }
  return lines.join('\n');
}

export async function dumpPrompt(
  request: SamplingRequest,
  opts: PromptDumpOptions,
): Promise<{ textPath: string; jsonPath: string }> {
  if (!existsSync(opts.root)) await mkdir(opts.root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = opts.label ? `-${opts.label}` : '';
  const textPath = join(opts.root, `${stamp}${suffix}.txt`);
  const jsonPath = join(opts.root, `${stamp}${suffix}.json`);
  await writeFile(textPath, renderPromptText(request), 'utf8');
  await writeFile(jsonPath, JSON.stringify(request, null, 2), 'utf8');
  return { textPath, jsonPath };
}
