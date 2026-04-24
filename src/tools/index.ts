export * from './tool.js';
export * from './registry.js';
export * from './executor.js';
export * from './impl/index.js';

import { ToolRegistry } from './registry.js';
import {
  memoryTool,
  readTool,
  restoreTool,
  shellTool,
  spawnTool,
  waitTool,
  webFetchTool,
  webSearchTool,
  writeTool,
} from './impl/index.js';

/**
 * Phase-1 default registry: the minimal primitive set.
 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(shellTool);
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(webFetchTool);
  registry.register(webSearchTool);
  registry.register(memoryTool);
  registry.register(restoreTool);
  registry.register(waitTool);
  registry.register(spawnTool);
  return registry;
}
