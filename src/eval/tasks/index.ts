import type { EvalTask } from '../types.js';
import { echoGreetingTask } from './echoGreeting.js';
import { writeFileTask } from './writeFile.js';

/**
 * Built-in eval tasks. Add new ones here. Eval task IDs must be globally
 * unique (used for filtering, reporting, and CI matrices).
 */
export const builtinTasks: readonly EvalTask[] = [echoGreetingTask, writeFileTask];

export function getTask(id: string): EvalTask | undefined {
  return builtinTasks.find((t) => t.id === id);
}

export { echoGreetingTask, writeFileTask };
