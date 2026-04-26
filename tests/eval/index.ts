/**
 * Eval *framework* only.
 *
 * Task definitions live under `tests/eval/tasks/` because they are
 * benchmarks (the thing being tested), not runtime library code. The
 * framework exports here are stable API for anyone wanting to run
 * their own task suite against a runtime.
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
