#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import 'dotenv/config';

import { OpenAIProvider } from '@harness/llm/openaiProvider.js';

import { formatSweepReport, runSweep, type ModelEntry } from './sweep.js';
import { builtinTasks, getTask } from './tasks/index.js';

/**
 * CLI entry point for the multi-model eval sweep.
 *
 * Usage:
 *   pnpm tsx tests/eval/sweepCli.ts             # uses ./sweep.json
 *   HARNESS_SWEEP_CONFIG=path/to/cfg.json pnpm tsx tests/eval/sweepCli.ts
 *
 * Config shape (JSON):
 *   {
 *     "systemPrompt": "...",                  // optional, default ''
 *     "perTaskTimeoutMs": 60000,              // optional
 *     "tasks": ["echo-greeting", ...] | "all", // default "all"
 *     "models": [
 *       {
 *         "label": "gpt-4o-mini",
 *         "apiKey": "${OPENAI_API_KEY}",      // ${VAR} → env substitution
 *         "model": "gpt-4o-mini",
 *         "baseURL": "https://...",           // optional
 *         "defaultMaxTokens": 256             // optional
 *       },
 *       ...
 *     ]
 *   }
 *
 * Env-var substitution: any string of the form "${VAR}" in a config value
 * is replaced with process.env.VAR. Useful for keeping API keys in .env
 * rather than committing them.
 */

interface RawModelConfig {
  label: string;
  apiKey: string;
  model?: string;
  baseURL?: string;
  defaultMaxTokens?: number;
}

interface RawConfig {
  systemPrompt?: string;
  perTaskTimeoutMs?: number;
  tasks?: string[] | 'all';
  models: RawModelConfig[];
}

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`sweep config: env var ${name} is not set`);
    }
    return v;
  });
}

function expandConfig(cfg: RawConfig): RawConfig {
  return {
    ...cfg,
    models: cfg.models.map((m) => ({
      ...m,
      apiKey: expandEnv(m.apiKey),
      ...(m.baseURL !== undefined ? { baseURL: expandEnv(m.baseURL) } : {}),
      ...(m.model !== undefined ? { model: expandEnv(m.model) } : {}),
    })),
  };
}

function modelEntry(m: RawModelConfig): ModelEntry {
  return {
    label: m.label,
    makeProvider: () =>
      new OpenAIProvider({
        apiKey: m.apiKey,
        ...(m.model !== undefined ? { model: m.model } : {}),
        ...(m.baseURL !== undefined ? { baseURL: m.baseURL } : {}),
        ...(m.defaultMaxTokens !== undefined
          ? { defaultMaxTokens: m.defaultMaxTokens }
          : {}),
      }),
  };
}

async function main(): Promise<void> {
  const cfgPath = process.env['HARNESS_SWEEP_CONFIG'] ?? path.resolve('sweep.json');
  let raw: RawConfig;
  try {
    raw = JSON.parse(await readFile(cfgPath, 'utf8')) as RawConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`sweep: cannot read config at ${cfgPath}: ${msg}`);
    process.exit(2);
  }

  const cfg = expandConfig(raw);
  const taskFilter = cfg.tasks ?? 'all';
  const tasks =
    taskFilter === 'all'
      ? builtinTasks
      : taskFilter
          .map((id) => {
            const t = getTask(id);
            if (!t) throw new Error(`sweep: unknown task ${id}`);
            return t;
          });

  const models = cfg.models.map(modelEntry);

  // eslint-disable-next-line no-console
  console.error(
    `sweep: running ${tasks.length} task(s) × ${models.length} model(s)…`,
  );

  const result = await runSweep(tasks, models, {
    ...(cfg.systemPrompt !== undefined ? { systemPrompt: cfg.systemPrompt } : {}),
    ...(cfg.perTaskTimeoutMs !== undefined
      ? { perTaskTimeoutMs: cfg.perTaskTimeoutMs }
      : {}),
  });

  const report = formatSweepReport(result);
  // Markdown report on stdout — pipe to a file or paste into a doc.
  // Raw JSON is dumped on stderr after the table for further analysis.
  // eslint-disable-next-line no-console
  console.log(report);
  // eslint-disable-next-line no-console
  console.error('\n--- raw cells (JSON) ---');
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(result.cells, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('sweep: failed', err);
  process.exit(1);
});
