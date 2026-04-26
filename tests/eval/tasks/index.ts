import type { EvalTask } from '../index.js';
import { echoGreetingTask } from './echoGreeting.js';
import { selfVerifyWriteTask } from './selfVerifyWrite.js';
import { spawnVerifyTask } from './spawnVerify.js';
import { usageAwareTask } from './usageAware.js';
import { writeFileTask } from './writeFile.js';

/**
 * Built-in eval tasks. Two flavours:
 *   - Outcome tasks (echo-greeting, write-file) — measure "did the agent
 *     do the thing?" using a deterministic post-hoc check.
 *   - Agentic-awareness tasks (self-verify-write, harness-usage-aware,
 *     harness-spawn-verify) — measure "did the agent spontaneously
 *     reach for harness primitives?" The verifier inspects toolCalls
 *     for read-after-write, `usage`, `spawn` patterns, NOT outcome.
 *
 * Task IDs must be globally unique (used for filtering, reporting,
 * and CI matrices).
 */
export const builtinTasks: readonly EvalTask[] = [
  echoGreetingTask,
  writeFileTask,
  selfVerifyWriteTask,
  usageAwareTask,
  spawnVerifyTask,
];

export function getTask(id: string): EvalTask | undefined {
  return builtinTasks.find((t) => t.id === id);
}

export {
  echoGreetingTask,
  selfVerifyWriteTask,
  spawnVerifyTask,
  usageAwareTask,
  writeFileTask,
};
