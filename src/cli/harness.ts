#!/usr/bin/env node
import { parseArgs } from 'node:util';

import 'dotenv/config';

import type { LlmProvider } from '@harness/llm/provider.js';
import { OpenAIProvider } from '@harness/llm/openaiProvider.js';
import { JsonlMemoryStore } from '@harness/memory/jsonlMemoryStore.js';
import { Mem0Store } from '@harness/memory/mem0Store.js';
import type { MemoryStore } from '@harness/memory/types.js';
import { bootstrap } from '@harness/runtime/bootstrap.js';
import { GoogleSearchBackend } from '@harness/search/googleSearch.js';
import { TavilySearchBackend } from '@harness/search/tavilySearch.js';
import type { SearchBackend } from '@harness/search/types.js';
import { TerminalAdapter } from '@harness/adapters/terminal.js';
import {
  JsonlDiagSink,
  StderrDiagSink,
  type DiagSink,
} from '@harness/diag/index.js';

/**
 * `harness` CLI. Reads .env for OpenAI credentials; CLI flags override.
 */

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      system: { type: 'string' },
      'store-root': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const providerName = values.provider ?? process.env['HARNESS_PROVIDER'] ?? 'openai';
  const provider = buildProvider({
    name: providerName,
    ...(typeof values.model === 'string' ? { model: values.model } : {}),
    ...(typeof values['base-url'] === 'string' ? { baseURL: values['base-url'] } : {}),
  });

  const systemPrompt =
    typeof values.system === 'string'
      ? values.system
      : (process.env['HARNESS_SYSTEM_PROMPT'] ?? 'You are a helpful agent. Respond concisely.');

  const storeRoot =
    typeof values['store-root'] === 'string'
      ? values['store-root']
      : process.env['HARNESS_STORE_ROOT'];

  const diagSinks = buildDiagSinks();
  const microCompact = buildMicroCompactOptions();
  const memory = buildMemoryStore();
  const searchBackend = buildSearchBackend();
  const compactionTrigger = buildCompactionTrigger();
  const useSubagentCompactor = process.env['HARNESS_COMPACTOR'] === 'subagent';

  const runtime = await bootstrap({
    provider,
    systemPrompt,
    ...(storeRoot !== undefined ? { storeRoot } : {}),
    ...(diagSinks.length > 0 ? { diagSinks } : {}),
    ...(microCompact !== undefined ? { microCompact } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(searchBackend !== undefined ? { searchBackend } : {}),
    ...(compactionTrigger !== undefined ? { compactionTrigger } : {}),
    ...(useSubagentCompactor ? { useSubagentCompactor: true } : {}),
  });

  const adapter = new TerminalAdapter({ store: runtime.store });
  await adapter.start({
    bus: runtime.bus,
    streamBus: runtime.streamBus,
    threadBinding: { kind: 'single', threadId: runtime.rootThreadId },
  });

  process.stdout.write(
    `harness started. provider=${provider.id} thread=${runtime.rootThreadId}. Type your message, /exit to quit.\n`,
  );
}

interface BuildProviderArgs {
  name: string;
  model?: string;
  baseURL?: string;
}

function buildProvider(args: BuildProviderArgs): LlmProvider {
  switch (args.name) {
    case 'openai': {
      const apiKey = process.env['OPENAI_API_KEY'];
      if (!apiKey) {
        throw new Error(
          'OPENAI_API_KEY is required. Copy .env.example to .env and fill it in.',
        );
      }
      const model = args.model ?? process.env['OPENAI_MODEL'];
      const baseURL = args.baseURL ?? process.env['OPENAI_BASE_URL'];
      const maxTokens = envNumber('OPENAI_MAX_TOKENS');
      const temperature = envNumber('OPENAI_TEMPERATURE');
      const reasoning = buildReasoningOptions();
      return new OpenAIProvider({
        apiKey,
        ...(model !== undefined ? { model } : {}),
        ...(baseURL !== undefined ? { baseURL } : {}),
        ...(maxTokens !== undefined ? { defaultMaxTokens: maxTokens } : {}),
        ...(temperature !== undefined ? { defaultTemperature: temperature } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
      });
    }
    default:
      throw new Error(`unknown provider: ${args.name}`);
  }
}

/**
 * Diagnostics are on by default. Disable with HARNESS_DIAG=off.
 *
 *   HARNESS_DIAG=off              disable everything
 *   HARNESS_DIAG_DIR=./diag       JSONL sink root (default .harness/diag)
 *   HARNESS_DIAG_STDERR=off       disable the stderr summary sink
 *   HARNESS_DIAG_STDERR=verbose   include replies / reasoning in stderr
 */
function buildDiagSinks(): DiagSink[] {
  if (process.env['HARNESS_DIAG'] === 'off') return [];
  const sinks: DiagSink[] = [];
  const dir = process.env['HARNESS_DIAG_DIR'] ?? '.harness/diag';
  if (dir !== 'off') sinks.push(new JsonlDiagSink({ root: dir }));
  const stderr = process.env['HARNESS_DIAG_STDERR'];
  if (stderr !== 'off') {
    sinks.push(
      new StderrDiagSink({
        level: stderr === 'verbose' ? 'verbose' : 'summary',
      }),
    );
  }
  return sinks;
}

/**
 * Read the OpenAI Responses-API reasoning controls from env. Both
 * fields are optional; when the user sets nothing, OpenAIProvider
 * defaults to `summary='auto'` so reasoning streams without further
 * config.
 *
 *   OPENAI_REASONING_EFFORT   none | minimal | low | medium | high | xhigh
 *   OPENAI_REASONING_SUMMARY  auto | concise | detailed | off
 */
function buildReasoningOptions():
  | { effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; summary?: 'auto' | 'concise' | 'detailed' | null }
  | undefined {
  const effortRaw = process.env['OPENAI_REASONING_EFFORT']?.toLowerCase();
  const summaryRaw = process.env['OPENAI_REASONING_SUMMARY']?.toLowerCase();
  if (effortRaw === undefined && summaryRaw === undefined) return undefined;
  const validEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  const out: { effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; summary?: 'auto' | 'concise' | 'detailed' | null } = {};
  if (effortRaw && validEfforts.has(effortRaw)) {
    out.effort = effortRaw as 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  }
  if (summaryRaw === 'off') {
    out.summary = null;
  } else if (summaryRaw === 'auto' || summaryRaw === 'concise' || summaryRaw === 'detailed') {
    out.summary = summaryRaw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function envNumber(key: string): number | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function buildCompactionTrigger(): { thresholdTokens: number; cooldownSamples?: number } | undefined {
  const threshold = envNumber('HARNESS_COMPACTION_THRESHOLD_TOKENS');
  if (threshold === undefined) return undefined;
  const cooldown = envNumber('HARNESS_COMPACTION_COOLDOWN_SAMPLES');
  return {
    thresholdTokens: threshold,
    ...(cooldown !== undefined ? { cooldownSamples: cooldown } : {}),
  };
}

function buildSearchBackend(): SearchBackend | undefined {
  const explicit = process.env['HARNESS_SEARCH_PROVIDER']?.toLowerCase();
  const tavilyKey = process.env['TAVILY_API_KEY'];
  const googleKey = process.env['GOOGLE_SEARCH_API_KEY'];
  const googleCx = process.env['GOOGLE_SEARCH_CX'];

  const tryTavily = (): SearchBackend | undefined => {
    if (!tavilyKey) return undefined;
    return new TavilySearchBackend({
      apiKey: tavilyKey,
      ...(process.env['TAVILY_BASE_URL'] ? { baseURL: process.env['TAVILY_BASE_URL'] } : {}),
      ...(process.env['TAVILY_SEARCH_DEPTH'] === 'advanced' ? { searchDepth: 'advanced' } : {}),
      ...(process.env['TAVILY_INCLUDE_ANSWER'] === '1' ? { includeAnswer: true } : {}),
    });
  };
  const tryGoogle = (): SearchBackend | undefined => {
    if (!googleKey || !googleCx) return undefined;
    return new GoogleSearchBackend({
      apiKey: googleKey,
      cx: googleCx,
      ...(process.env['GOOGLE_SEARCH_BASE_URL']
        ? { baseURL: process.env['GOOGLE_SEARCH_BASE_URL'] }
        : {}),
    });
  };

  if (explicit === 'tavily') return tryTavily();
  if (explicit === 'google') return tryGoogle();
  return tryTavily() ?? tryGoogle();
}

function buildMemoryStore(): MemoryStore | undefined {
  const apiKey = process.env['MEM0_API_KEY'];
  if (apiKey) {
    return new Mem0Store({
      apiKey,
      ...(process.env['MEM0_BASE_URL'] ? { baseURL: process.env['MEM0_BASE_URL'] } : {}),
      ...(process.env['MEM0_USER_ID'] ? { defaultUserId: process.env['MEM0_USER_ID'] } : {}),
    });
  }
  const path = process.env['HARNESS_MEMORY_FILE'];
  if (path) return new JsonlMemoryStore({ path });
  return undefined;
}

function buildMicroCompactOptions():
  | false
  | { keepRecent?: number; triggerEvery?: number; minBytes?: number }
  | undefined {
  if (process.env['HARNESS_MICRO_COMPACT'] === 'off') return false;
  const keepRecent = envNumber('HARNESS_MICRO_COMPACT_KEEP_RECENT');
  const triggerEvery = envNumber('HARNESS_MICRO_COMPACT_TRIGGER_EVERY');
  const minBytes = envNumber('HARNESS_MICRO_COMPACT_MIN_BYTES');
  if (keepRecent === undefined && triggerEvery === undefined && minBytes === undefined) {
    return undefined;
  }
  return {
    ...(keepRecent !== undefined ? { keepRecent } : {}),
    ...(triggerEvery !== undefined ? { triggerEvery } : {}),
    ...(minBytes !== undefined ? { minBytes } : {}),
  };
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: harness [--provider openai] [--model <id>] [--base-url <url>] [--system <prompt>] [--store-root <dir>]',
      '',
      'Environment (also loaded from .env):',
      '  OPENAI_API_KEY       required',
      '  OPENAI_MODEL         default gpt-4o-mini',
      '  OPENAI_BASE_URL      override endpoint (OpenAI-compatible)',
      '  OPENAI_MAX_TOKENS    default 32768',
      '  OPENAI_TEMPERATURE   default 0.7',
      '  OPENAI_REASONING_EFFORT   none|minimal|low|medium|high|xhigh (model default if unset)',
      '  OPENAI_REASONING_SUMMARY  auto|concise|detailed|off (default auto — streams thinking)',
      '  HARNESS_PROVIDER     default openai',
      '  HARNESS_SYSTEM_PROMPT',
      '  HARNESS_STORE_ROOT   persist session events to this directory',
      '  HARNESS_DIAG         off to disable diagnostics',
      '  HARNESS_DIAG_DIR     JSONL + prompt-dump root (default .harness/diag)',
      '  HARNESS_DIAG_STDERR  off | summary (default) | verbose',
      '  HARNESS_MICRO_COMPACT  off to disable hot-path micro-compaction',
      '  HARNESS_MICRO_COMPACT_KEEP_RECENT     default 20',
      '  HARNESS_MICRO_COMPACT_TRIGGER_EVERY   default 10',
      '  HARNESS_MICRO_COMPACT_MIN_BYTES       default 256',
      '  HARNESS_MEMORY_FILE  path to JSONL memory log (cross-session memory; off if unset)',
      '  MEM0_API_KEY         enable mem0 backend (overrides HARNESS_MEMORY_FILE if both set)',
      '  MEM0_BASE_URL        self-hosted mem0 server (omit for cloud)',
      '  MEM0_USER_ID         fallback userId for mem0 (default \'harness\')',
      '  HARNESS_COMPACTION_THRESHOLD_TOKENS  enable cold-path compaction at this token mark',
      '  HARNESS_COMPACTION_COOLDOWN_SAMPLES  samplings to skip after firing (default 5)',
      '  HARNESS_COMPACTOR=subagent           use provider-backed compactor (else StaticCompactor)',
      '  HARNESS_SEARCH_PROVIDER   force web_search backend (google | tavily)',
      '  GOOGLE_SEARCH_API_KEY     enable Google Programmable Search (with GOOGLE_SEARCH_CX)',
      '  GOOGLE_SEARCH_CX          Google CSE id',
      '  TAVILY_API_KEY            enable Tavily search backend',
      '  TAVILY_SEARCH_DEPTH       basic | advanced (default basic)',
      '  TAVILY_INCLUDE_ANSWER     1 to request a synthesized one-line answer',
      '',
      'Interactive commands:',
      '  /exit, /quit         leave the REPL',
      '  /interrupt           cancel the running turn',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
