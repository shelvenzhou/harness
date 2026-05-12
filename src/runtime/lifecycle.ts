import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Lifecycle / supervisor handshake helpers.
 *
 * The harness process and the external supervisor coordinate via
 * three small files under `<storeRoot>/.lifecycle/`:
 *
 *   ready.json     — written by the harness once its adapter is
 *                    connected and the runtime can take traffic.
 *                    Contains pid + sha + ref + ISO timestamp.
 *                    Deleted by the harness on clean shutdown.
 *                    Supervisor watches this file to confirm the
 *                    new build came up; absence past a deadline
 *                    means rollback.
 *   handoff.json   — written by the supervisor *before* exec'ing
 *                    the new harness build. The new process reads
 *                    + deletes it on boot, then publishes a
 *                    `restart_event` carrying the from/to shas
 *                    and outcome. If absent (e.g. cold boot, or
 *                    manual restart), the harness still publishes
 *                    a restart_event but `fromSha` is empty and
 *                    `outcome:'manual'`.
 *   pid            — the supervisor records its current harness
 *                    child's PID here for the next `deploy`
 *                    command to find.
 *
 * Nothing here imports the runtime — these helpers are usable from
 * both inside the harness (CLI) and outside (scripts/supervisor.cjs).
 */

const execFileAsync = promisify(execFile);

export interface ReadyFileContent {
  pid: number;
  sha?: string;
  ref?: string;
  /** ISO-8601 timestamp the harness wrote the file. */
  startedAt: string;
}

export interface HandoffContent {
  /** SHA the supervisor's *previous* harness child was running. */
  fromSha?: string;
  /** SHA the supervisor is now exec'ing the new harness on. */
  toSha: string;
  /** Symbolic ref / branch the deploy targets. */
  ref?: string;
  /** Operator-facing one-liner the new harness can render. */
  message?: string;
  /** Cutover outcome the supervisor classifies the deploy as. */
  outcome: 'success' | 'rolled_back' | 'manual';
  /** When the supervisor wrote this file. */
  writtenAt: string;
}

const LIFECYCLE_SUBDIR = '.lifecycle';
const READY_FILE = 'ready.json';
const HANDOFF_FILE = 'handoff.json';
const PID_FILE = 'pid';

export function lifecycleDir(storeRoot: string): string {
  return join(storeRoot, LIFECYCLE_SUBDIR);
}

export function readyFilePath(storeRoot: string): string {
  return join(lifecycleDir(storeRoot), READY_FILE);
}

export function handoffFilePath(storeRoot: string): string {
  return join(lifecycleDir(storeRoot), HANDOFF_FILE);
}

export function pidFilePath(storeRoot: string): string {
  return join(lifecycleDir(storeRoot), PID_FILE);
}

/**
 * Atomic write helper. Writes `content` to a sibling `*.tmp` then
 * renames into place — readers either see the previous bytes or
 * the new bytes, never a partial write.
 */
function writeAtomic(path: string, content: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function writeReadyFile(storeRoot: string, info: ReadyFileContent): void {
  writeAtomic(readyFilePath(storeRoot), JSON.stringify(info, null, 2));
}

export function deleteReadyFile(storeRoot: string): void {
  const p = readyFilePath(storeRoot);
  if (existsSync(p)) {
    try {
      rmSync(p);
    } catch {
      /* best-effort */
    }
  }
}

export function readReadyFile(storeRoot: string): ReadyFileContent | undefined {
  const p = readyFilePath(storeRoot);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ReadyFileContent;
  } catch {
    return undefined;
  }
}

export function writeHandoff(storeRoot: string, info: HandoffContent): void {
  writeAtomic(handoffFilePath(storeRoot), JSON.stringify(info, null, 2));
}

/**
 * Read the handoff file (if present) and delete it. The delete is
 * deliberate: the handoff is consumed exactly once by the next
 * boot. If the new process crashes before consuming it, the
 * supervisor will write a fresh one for the rollback / retry.
 */
export function consumeHandoff(storeRoot: string): HandoffContent | undefined {
  const p = handoffFilePath(storeRoot);
  if (!existsSync(p)) return undefined;
  let parsed: HandoffContent | undefined;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8')) as HandoffContent;
  } catch {
    parsed = undefined;
  }
  try {
    rmSync(p);
  } catch {
    /* best-effort */
  }
  return parsed;
}

export function writePidFile(storeRoot: string, pid: number): void {
  writeAtomic(pidFilePath(storeRoot), String(pid));
}

export function readPidFile(storeRoot: string): number | undefined {
  const p = pidFilePath(storeRoot);
  if (!existsSync(p)) return undefined;
  try {
    const v = Number(readFileSync(p, 'utf8').trim());
    return Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

export function deletePidFile(storeRoot: string): void {
  const p = pidFilePath(storeRoot);
  if (existsSync(p)) {
    try {
      rmSync(p);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Resolve the current git HEAD sha for `cwd`. Returns undefined if
 * the directory is not a git repo, git is missing, or anything
 * else goes wrong — lifecycle metadata is best-effort and never
 * blocks the harness from starting.
 */
export async function gitHeadSha(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Symbolic ref / current branch name. `HEAD` for detached. */
export async function gitHeadRef(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
