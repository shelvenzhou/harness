import { bootstrap } from '@harness/runtime/bootstrap.js';
import type { LlmProvider } from '@harness/llm/provider.js';
import type { TokenBudget } from '@harness/runtime/agentRunner.js';

import { runEval } from './runner.js';
import type { EvalResult, EvalTask } from './types.js';

/**
 * Multi-model sweep: run a fixed task suite against N model providers
 * and collect a structured comparison.
 *
 * The sweep does not know about OpenAIProvider or any specific
 * provider — it takes a list of (label, providerFactory) entries.
 * This keeps the framework testable with scripted providers and lets
 * the CLI script wire whatever provider the user wants. Each task
 * gets a fresh runtime per model so state doesn't leak across cells.
 */

export interface ModelEntry {
  /** Free-form identifier, used in reports. */
  label: string;
  /** Called once per task. Should return a NEW provider instance. */
  makeProvider: () => LlmProvider;
  /** Optional system-prompt override for this model. Falls back to the sweep-level prompt. */
  systemPrompt?: string;
}

export interface SweepRunOptions {
  /** Default system prompt used when a model entry doesn't override. */
  systemPrompt?: string;
  /** Per-task wall-clock budget (ms). Default 60s. */
  perTaskTimeoutMs?: number;
  /** Hard-wall token budget passed to each runtime. */
  tokenBudget?: TokenBudget;
}

export interface SweepCellResult {
  modelLabel: string;
  taskId: string;
  status: EvalResult['status'];
  reason?: string;
  samplingCount: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  wallMs: number;
  toolNames: string[];
}

export interface SweepModelTotals {
  pass: number;
  fail: number;
  timeout: number;
  error: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalWallMs: number;
}

export interface SweepResult {
  cells: SweepCellResult[];
  byModel: Record<string, SweepModelTotals>;
}

export async function runSweep(
  tasks: readonly EvalTask[],
  models: readonly ModelEntry[],
  opts: SweepRunOptions = {},
): Promise<SweepResult> {
  const cells: SweepCellResult[] = [];
  const byModel: Record<string, SweepModelTotals> = {};

  for (const model of models) {
    byModel[model.label] = {
      pass: 0,
      fail: 0,
      timeout: 0,
      error: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalWallMs: 0,
    };

    for (const task of tasks) {
      const runtime = await bootstrap({
        provider: model.makeProvider(),
        systemPrompt: model.systemPrompt ?? opts.systemPrompt ?? '',
        ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
      });

      const result = await runEval(task, runtime, {
        timeoutMs: opts.perTaskTimeoutMs ?? 60_000,
      });

      const cell: SweepCellResult = {
        modelLabel: model.label,
        taskId: task.id,
        status: result.status,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        samplingCount: result.observed.samplingCount,
        promptTokens: result.observed.promptTokens,
        completionTokens: result.observed.completionTokens,
        cachedPromptTokens: result.observed.cachedPromptTokens,
        wallMs: result.observed.wallMs,
        toolNames: result.observed.toolCalls.map((t) => t.name),
      };
      cells.push(cell);

      const totals = byModel[model.label]!;
      totals[result.status] += 1;
      totals.totalPromptTokens += cell.promptTokens;
      totals.totalCompletionTokens += cell.completionTokens;
      totals.totalWallMs += cell.wallMs;
    }
  }

  return { cells, byModel };
}

/**
 * Render a sweep result as two markdown tables: a per-task matrix
 * (rows = models, cols = tasks, cell = pass/fail) and a per-model
 * summary (totals + token cost).
 */
export function formatSweepReport(result: SweepResult): string {
  const taskIds = uniqueOrdered(result.cells.map((c) => c.taskId));
  const modelLabels = uniqueOrdered(result.cells.map((c) => c.modelLabel));

  const headerCells = ['model', ...taskIds];
  const lines: string[] = [];
  lines.push(`| ${headerCells.join(' | ')} |`);
  lines.push(`| ${headerCells.map(() => '---').join(' | ')} |`);

  for (const model of modelLabels) {
    const row: string[] = [model];
    for (const taskId of taskIds) {
      const cell = result.cells.find(
        (c) => c.modelLabel === model && c.taskId === taskId,
      );
      row.push(formatCell(cell));
    }
    lines.push(`| ${row.join(' | ')} |`);
  }

  lines.push('');
  lines.push('| model | pass | fail | timeout | error | prompt tok | completion tok | wall ms |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const model of modelLabels) {
    const t = result.byModel[model]!;
    lines.push(
      `| ${model} | ${t.pass} | ${t.fail} | ${t.timeout} | ${t.error} | ${t.totalPromptTokens} | ${t.totalCompletionTokens} | ${t.totalWallMs} |`,
    );
  }

  return lines.join('\n');
}

function formatCell(cell: SweepCellResult | undefined): string {
  if (!cell) return '-';
  const symbol =
    cell.status === 'pass'
      ? '✓'
      : cell.status === 'fail'
        ? '✗'
        : cell.status === 'timeout'
          ? '⌛'
          : '!';
  // Tool names are the load-bearing detail for agentic-awareness tasks.
  const tools = cell.toolNames.length > 0 ? ` [${cell.toolNames.join(',')}]` : '';
  return `${symbol}${tools}`;
}

function uniqueOrdered<T>(xs: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
