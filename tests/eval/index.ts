/**
 * Eval framework (under tests/ because the suite is benchmarks, not
 * runtime library code).
 */

export type {
  EvalContext,
  EvalResult,
  EvalTask,
  EvalVerdict,
  ObservedRun,
} from './types.js';
export { runEval } from './runner.js';
export type { RunEvalOptions } from './runner.js';
export { formatSweepReport, runSweep } from './sweep.js';
export type {
  ModelEntry,
  SweepCellResult,
  SweepModelTotals,
  SweepResult,
  SweepRunOptions,
} from './sweep.js';
