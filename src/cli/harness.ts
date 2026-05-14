#!/usr/bin/env node
import { parseArgs } from 'node:util';

import 'dotenv/config';

import type { LlmProvider } from '@harness/llm/provider.js';
import { OpenAIProvider, type OpenAIApiMode } from '@harness/llm/openaiProvider.js';
import { JsonlMemoryStore } from '@harness/memory/jsonlMemoryStore.js';
import { Mem0Store } from '@harness/memory/mem0Store.js';
import type { MemoryStore } from '@harness/memory/types.js';
import { bootstrap, type RuntimeModelInfo } from '@harness/runtime/bootstrap.js';
import type { ProviderFactory } from '@harness/runtime/subagentPool.js';
import { GoogleSearchBackend } from '@harness/search/googleSearch.js';
import { TavilySearchBackend } from '@harness/search/tavilySearch.js';
import type { SearchBackend } from '@harness/search/types.js';
import { TerminalAdapter } from '@harness/adapters/terminal.js';
import { DiscordAdapter } from '@harness/adapters/discord.js';
import type { Adapter, ThreadBinding } from '@harness/adapters/adapter.js';
import {
  JsonlDiagSink,
  StderrDiagSink,
  type DiagSink,
} from '@harness/diag/index.js';

import {
  consumeHandoff,
  deletePidFile,
  deleteReadyFile,
  gitHeadRef,
  gitHeadSha,
  writeReadyFile,
  type HandoffContent,
} from '@harness/runtime/lifecycle.js';
import { newEventId } from '@harness/core/ids.js';
import type { HarnessEvent, RestartEventPayload } from '@harness/core/events.js';

import { loadPrompts } from './prompts.js';

/**
 * `harness` CLI. Reads .env for OpenAI credentials; CLI flags override.
 */

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      'model-key': { type: 'string' },
      'base-url': { type: 'string' },
      'api-mode': { type: 'string' },
      system: { type: 'string' },
      'store-root': { type: 'string' },
      adapter: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const providerName = values.provider ?? process.env['HARNESS_PROVIDER'] ?? 'openai';
  const providerSpec = buildProvider({
    name: providerName,
    ...(typeof values.model === 'string' ? { model: values.model } : {}),
    ...(typeof values['model-key'] === 'string'
      ? { modelKey: values['model-key'] }
      : {}),
    ...(typeof values['base-url'] === 'string' ? { baseURL: values['base-url'] } : {}),
    ...(typeof values['api-mode'] === 'string' ? { apiMode: values['api-mode'] } : {}),
  });
  const provider = providerSpec.provider;
  const providerFactories = buildEnvProviderFactories();
  const providerFactoryModelInfo = buildEnvProviderModelInfo();

  const prompts = loadPrompts();
  const systemPrompt =
    typeof values.system === 'string'
      ? values.system
      : (process.env['HARNESS_SYSTEM_PROMPT'] ??
          prompts.main ??
          'You are a helpful agent. Respond concisely.');

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
  const codingAgents = buildCodingAgentsConfig();

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
    ...(codingAgents !== undefined ? { codingAgents } : {}),
    ...(Object.keys(providerFactories).length > 0 ? { providerFactories } : {}),
    ...(providerSpec.modelInfo !== undefined ? { runtimeModelInfo: providerSpec.modelInfo } : {}),
    ...(Object.keys(providerFactoryModelInfo).length > 0 ? { providerFactoryModelInfo } : {}),
    ...(prompts.pinned.length > 0 ? { pinnedMemory: prompts.pinned } : {}),
    ...(Object.keys(prompts.byRole).length > 0 ? { rolePrompts: prompts.byRole } : {}),
  });

  if (prompts.dir !== undefined) {
    const summary: string[] = [];
    if (prompts.main !== undefined) summary.push('main');
    if (prompts.pinned.length > 0) summary.push(`${prompts.pinned.length} playbook(s)`);
    const roleCount = Object.keys(prompts.byRole).length;
    if (roleCount > 0) summary.push(`${roleCount} role(s)`);
    if (summary.length > 0) {
      process.stdout.write(`harness prompts: ${summary.join(', ')} from ${prompts.dir}\n`);
    }
  }

  const adapterName =
    typeof values.adapter === 'string'
      ? values.adapter
      : (process.env['HARNESS_ADAPTER'] ?? 'terminal');

  let adapter: Adapter;
  let threadBinding: ThreadBinding;
  if (adapterName === 'discord') {
    const token = process.env['DISCORD_BOT_TOKEN'];
    const channelId = process.env['DISCORD_CHANNEL_ID'];
    if (!token) {
      throw new Error('DiscordAdapter requires DISCORD_BOT_TOKEN env var');
    }
    const devGuildId = process.env['DISCORD_DEV_GUILD_ID'];
    adapter = new DiscordAdapter({
      store: runtime.store,
      token,
      ...(channelId ? { channelId } : {}),
      ...(devGuildId ? { devGuildId } : {}),
    });
    if (channelId) {
      threadBinding = { kind: 'single', threadId: runtime.rootThreadId };
    } else {
      threadBinding = {
        kind: 'per-channel',
        resolve: async (externalChannelId) => {
          const title = `discord:${externalChannelId}`;
          const existing = (await runtime.store.listThreads()).find(
            (t) => t.title === title,
          );
          if (existing) {
            await runtime.adoptRootThread(existing.id);
            return existing.id;
          }
          return runtime.createRootThread({ title });
        },
      };
    }
  } else if (adapterName === 'terminal') {
    adapter = new TerminalAdapter({ store: runtime.store });
    threadBinding = { kind: 'single', threadId: runtime.rootThreadId };
  } else {
    throw new Error(`unknown adapter: ${adapterName}`);
  }

  await adapter.start({
    bus: runtime.bus,
    streamBus: runtime.streamBus,
    threadBinding,
    router: {
      createThread: (input) => runtime.createRootThread(input),
      adoptThread: (threadId) => runtime.adoptRootThread(threadId),
    },
  });

  // Lifecycle handshake with the supervisor (M5). Skipped when there
  // is no `storeRoot` — the lifecycle helpers all live under
  // `<storeRoot>/.lifecycle/` so an in-memory store has nowhere to
  // put them. The supervisor refuses to run without a store root, so
  // this is symmetric.
  if (storeRoot !== undefined) {
    const handoff = consumeHandoff(storeRoot);
    const toSha = await gitHeadSha(process.cwd());
    const ref = await gitHeadRef(process.cwd());
    await publishRestartEvent({
      runtime,
      ...(handoff !== undefined ? { handoff } : {}),
      ...(toSha !== undefined ? { toSha } : {}),
      ...(ref !== undefined ? { ref } : {}),
    });
    writeReadyFile(storeRoot, {
      pid: process.pid,
      ...(toSha !== undefined ? { sha: toSha } : {}),
      ...(ref !== undefined ? { ref } : {}),
      startedAt: new Date().toISOString(),
    });
    installShutdownHooks(storeRoot);
  }

  process.stdout.write(
    `harness started. provider=${provider.id} adapter=${adapter.id} thread=${runtime.rootThreadId}.\n`,
  );
}

async function publishRestartEvent(args: {
  runtime: Awaited<ReturnType<typeof bootstrap>>;
  handoff?: HandoffContent;
  toSha?: string;
  ref?: string;
}): Promise<void> {
  // Pick the to-sha / ref to record. Handoff wins when present (the
  // supervisor knows what it deployed); otherwise fall back to the
  // freshly-resolved git state.
  const toSha = args.handoff?.toSha ?? args.toSha;
  const ref = args.handoff?.ref ?? args.ref;
  if (toSha === undefined) return; // not a git checkout — skip rendering
  const payload: RestartEventPayload = {
    toSha,
    outcome: args.handoff?.outcome ?? 'manual',
    startedAt: new Date().toISOString(),
    ...(args.handoff?.fromSha !== undefined ? { fromSha: args.handoff.fromSha } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(args.handoff?.message !== undefined ? { message: args.handoff.message } : {}),
  };
  const ev: HarnessEvent = {
    id: newEventId(),
    threadId: args.runtime.rootThreadId,
    kind: 'restart_event',
    payload,
    createdAt: new Date().toISOString(),
  } as HarnessEvent;
  await args.runtime.store.append(ev);
  args.runtime.bus.publish(ev);
}

function installShutdownHooks(storeRoot: string): void {
  // Best-effort cleanup. The supervisor uses absence of the ready
  // file as the "old harness has exited cleanly" signal; deleting
  // it on SIGTERM is the contract.
  let shuttingDown = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    deleteReadyFile(storeRoot);
    deletePidFile(storeRoot);
    // Re-raise so the default exit semantics still apply.
    process.kill(process.pid, sig);
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
}

interface BuildProviderArgs {
  name: string;
  model?: string;
  modelKey?: string;
  baseURL?: string;
  apiMode?: string;
}

function buildProvider(args: BuildProviderArgs): BuildProviderResult {
  switch (args.name) {
    case 'openai': {
      return buildOpenAIProvider({
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.modelKey !== undefined ? { modelKey: args.modelKey } : {}),
        ...(args.baseURL !== undefined ? { baseURL: args.baseURL } : {}),
        ...(args.apiMode !== undefined ? { apiMode: args.apiMode } : {}),
      });
    }
    default:
      throw new Error(`unknown provider: ${args.name}`);
  }
}

interface BuildProviderResult {
  provider: LlmProvider;
  modelInfo?: RuntimeModelInfo;
}

interface OpenAIProviderBuildArgs {
  model?: string;
  modelKey?: string;
  baseURL?: string;
  apiMode?: string;
}

interface EnvModelConfig {
  provider: 'openai';
  model: string;
  apiMode?: OpenAIApiMode;
  baseURL?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  temperature?: number;
  reasoning?: ReturnType<typeof buildReasoningOptions>;
  chatMaxTokensParam?: 'max_completion_tokens' | 'max_tokens';
}

function buildOpenAIProvider(args: OpenAIProviderBuildArgs = {}): BuildProviderResult {
  const selectedKey = args.modelKey ?? process.env['HARNESS_MAIN_MODEL'];
  const aliasConfig = selectedKey ? readEnvModelConfigs()[selectedKey] : undefined;

  // Resolve the base config: a matching alias takes precedence, otherwise
  // start from the global OPENAI_* env (with HARNESS_MAIN_MODEL treated as
  // a raw model id when it doesn't name an alias).
  let config: EnvModelConfig;
  let alias: string | undefined;
  if (aliasConfig) {
    config = { ...aliasConfig };
    alias = selectedKey;
  } else {
    config = {
      provider: 'openai',
      model: selectedKey ?? process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini',
    };
    const envApiMode = parseApiMode(process.env['OPENAI_API_MODE']);
    const envBaseURL = process.env['OPENAI_BASE_URL'];
    if (envApiMode !== undefined) config.apiMode = envApiMode;
    if (envBaseURL !== undefined) config.baseURL = envBaseURL;
  }

  // CLI flags overlay the resolved config so --base-url / --api-mode /
  // --model can tweak a single field without dropping the rest of the
  // alias (apiKeyEnv, reasoning, etc.).
  if (args.model !== undefined) config.model = args.model;
  if (args.baseURL !== undefined) config.baseURL = args.baseURL;
  const cliApiMode = parseApiMode(args.apiMode);
  if (cliApiMode !== undefined) config.apiMode = cliApiMode;

  return openAIProviderResultFromConfig(config, alias);
}

function openAIProviderFromConfig(config: EnvModelConfig): OpenAIProvider {
  const apiKey = process.env[config.apiKeyEnv ?? 'OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error(
      `${config.apiKeyEnv ?? 'OPENAI_API_KEY'} is required. Copy .env.example to .env and fill it in.`,
    );
  }
  const maxTokens = config.maxTokens ?? envNumber('OPENAI_MAX_TOKENS');
  const temperature = config.temperature ?? envNumber('OPENAI_TEMPERATURE');
  const reasoning = config.reasoning ?? buildReasoningOptions();
  const chatMaxTokensParam =
    config.chatMaxTokensParam ?? parseChatMaxTokensParam(process.env['OPENAI_CHAT_MAX_TOKENS_PARAM']);
  return new OpenAIProvider({
    apiKey,
    model: config.model,
    ...(config.apiMode !== undefined ? { apiMode: config.apiMode } : {}),
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
    ...(maxTokens !== undefined ? { defaultMaxTokens: maxTokens } : {}),
    ...(temperature !== undefined ? { defaultTemperature: temperature } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(chatMaxTokensParam !== undefined ? { chatMaxTokensParam } : {}),
  });
}

function openAIProviderResultFromConfig(
  config: EnvModelConfig,
  alias: string | undefined,
): BuildProviderResult {
  return {
    provider: openAIProviderFromConfig(config),
    modelInfo: modelInfoFromConfig(config, alias),
  };
}

function buildEnvProviderFactories(): Record<string, ProviderFactory> {
  const out: Record<string, ProviderFactory> = {};
  for (const [key, config] of Object.entries(readEnvModelConfigs())) {
    out[key] = () => openAIProviderFromConfig(config);
  }
  return out;
}

function buildEnvProviderModelInfo(): Record<string, RuntimeModelInfo> {
  const out: Record<string, RuntimeModelInfo> = {};
  for (const [key, config] of Object.entries(readEnvModelConfigs())) {
    out[key] = modelInfoFromConfig(config, key);
  }
  return out;
}

function modelInfoFromConfig(config: EnvModelConfig, alias: string | undefined): RuntimeModelInfo {
  return {
    provider: config.provider,
    model: config.model,
    ...(alias !== undefined ? { alias } : {}),
    ...(config.apiMode !== undefined ? { apiMode: config.apiMode } : {}),
    ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
  };
}

function readEnvModelConfigs(): Record<string, EnvModelConfig> {
  const out: Record<string, EnvModelConfig> = {};
  const aliases = (process.env['HARNESS_MODEL_ALIASES'] ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  for (const alias of aliases) {
    const envKey = `HARNESS_MODEL_${envSuffix(alias)}`;
    const raw = process.env[envKey];
    if (!raw) continue;
    const parts = raw.split('|').map((v) => v.trim());
    const provider = parts[0];
    const model = parts[1];
    if (provider !== 'openai' || !model) continue;
    const apiMode = parseApiMode(parts[2]);
    const baseURL = parts[3] || undefined;
    const apiKeyEnv = parts[4] || undefined;
    const suffix = envSuffix(alias);
    const reasoning = buildReasoningOptions(`OPENAI_REASONING_EFFORT_${suffix}`, `OPENAI_REASONING_SUMMARY_${suffix}`);
    const chatMaxTokensParam = parseChatMaxTokensParam(
      process.env[`OPENAI_CHAT_MAX_TOKENS_PARAM_${suffix}`],
    );
    const maxTokens = envNumber(`OPENAI_MAX_TOKENS_${suffix}`);
    const temperature = envNumber(`OPENAI_TEMPERATURE_${suffix}`);
    const config: EnvModelConfig = {
      provider: 'openai',
      model,
    };
    if (apiMode !== undefined) config.apiMode = apiMode;
    if (baseURL !== undefined) config.baseURL = baseURL;
    if (apiKeyEnv !== undefined) config.apiKeyEnv = apiKeyEnv;
    if (maxTokens !== undefined) config.maxTokens = maxTokens;
    if (temperature !== undefined) config.temperature = temperature;
    if (reasoning !== undefined) config.reasoning = reasoning;
    if (chatMaxTokensParam !== undefined) config.chatMaxTokensParam = chatMaxTokensParam;
    out[alias] = config;
  }
  return out;
}

function envSuffix(alias: string): string {
  return alias.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function parseApiMode(raw: string | undefined): OpenAIApiMode | undefined {
  const v = raw?.toLowerCase();
  if (v === 'responses' || v === 'chat_completions') return v;
  return undefined;
}

function parseChatMaxTokensParam(
  raw: string | undefined,
): 'max_completion_tokens' | 'max_tokens' | undefined {
  if (raw === 'max_completion_tokens' || raw === 'max_tokens') return raw;
  return undefined;
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
function buildReasoningOptions(
  effortKey = 'OPENAI_REASONING_EFFORT',
  summaryKey = 'OPENAI_REASONING_SUMMARY',
):
  | { effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; summary?: 'auto' | 'concise' | 'detailed' | null }
  | undefined {
  const effortRaw = process.env[effortKey]?.toLowerCase();
  const summaryRaw = process.env[summaryKey]?.toLowerCase();
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

/**
 * Read `HARNESS_CODING_AGENTS` and translate it into the `codingAgents`
 * bootstrap option. Comma-separated list of {`cc`, `codex`}. Each named
 * agent gets a default-options factory registration; agents not listed
 * fall back to the bootstrap default (`cc: true`, `codex: false`).
 *
 * Unset or empty → return undefined so bootstrap's defaults apply.
 * Examples:
 *   HARNESS_CODING_AGENTS=cc,codex   → enable both
 *   HARNESS_CODING_AGENTS=codex      → enable codex only (disable cc)
 */
function buildCodingAgentsConfig(): { cc?: boolean; codex?: boolean } | undefined {
  const raw = process.env['HARNESS_CODING_AGENTS'];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const wanted = new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  return {
    cc: wanted.has('cc'),
    codex: wanted.has('codex'),
  };
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
      'Usage: harness [--provider openai] [--model <id>] [--base-url <url>] [--system <prompt>] [--store-root <dir>] [--adapter terminal|discord]',
      '',
      'Environment (also loaded from .env):',
      '  OPENAI_API_KEY       required',
      '  OPENAI_MODEL         default gpt-4o-mini',
      '  OPENAI_BASE_URL      override endpoint for selected OpenAI API mode',
      '  OPENAI_API_MODE      responses (default) | chat_completions',
      '  OPENAI_CHAT_MAX_TOKENS_PARAM  max_completion_tokens (default) | max_tokens',
      '  OPENAI_MAX_TOKENS    default 32768',
      '  OPENAI_TEMPERATURE   optional; suppressed for GPT-5/o-series models',
      '  OPENAI_REASONING_EFFORT   none|minimal|low|medium|high|xhigh (model default if unset)',
      '  OPENAI_REASONING_SUMMARY  auto|concise|detailed|off (default auto — streams thinking)',
      '  HARNESS_PROVIDER     default openai',
      '  HARNESS_MAIN_MODEL   alias from HARNESS_MODEL_ALIASES, or raw model id',
      '  HARNESS_MODEL_ALIASES comma-separated aliases usable by spawn.provider',
      '  HARNESS_MODEL_<ALIAS> openai|model|responses|baseURL|apiKeyEnv',
      '                         api mode may also be chat_completions',
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
      '  HARNESS_ADAPTER           terminal (default) | discord',
      '  DISCORD_BOT_TOKEN         required when --adapter discord',
      '  DISCORD_CHANNEL_ID        optional; if unset, @bot binds each channel to its own session',
      '  DISCORD_DEV_GUILD_ID      optional; register slash commands to this guild for instant propagation',
      '',
      'Interactive commands:',
      '  /exit, /quit         leave the REPL',
      '  /interrupt           cancel the running turn',
      '  /status              show current thread + recent threads',
      '  /new                 start a fresh thread (auto-interrupts active turn)',
      '  /resume <idx|prefix> switch to an existing thread (use /status to list)',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
