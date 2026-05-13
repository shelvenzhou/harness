#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, no-console */
'use strict';

/**
 * Harness supervisor — lives *outside* the harness process so a hung
 * or panicked harness can't take its own restart loop down. See
 * design-docs/11-self-update.md §R3.
 *
 * Modes:
 *   start [<ref>]       — boot the harness on <ref> (or current HEAD),
 *                         write the supervisor's pid bookkeeping, and
 *                         wait for the child to exit. SIGINT / SIGTERM
 *                         on the supervisor are forwarded.
 *   deploy <ref>        — replace the running harness with a build on
 *                         <ref>. Verifies build + tests on the new ref
 *                         BEFORE killing the old harness, so a broken
 *                         tree leaves the live harness untouched. On
 *                         success, sends SIGTERM to the old harness,
 *                         waits for its ready file to vanish (= clean
 *                         exit), writes a handoff file, then exec's
 *                         the new harness. The new process reads the
 *                         handoff and publishes a `restart_event` to
 *                         the root thread on boot.
 *   status              — print pid + ready state for the current
 *                         harness, if any.
 *
 * Environment:
 *   HARNESS_STORE_ROOT          required (location of .lifecycle/)
 *   HARNESS_REPO_ROOT           defaults to cwd
 *   HARNESS_START_CMD           defaults to `pnpm dev` (used by start)
 *   HARNESS_BUILD_CMD           defaults to `pnpm build`
 *   HARNESS_TEST_CMD            defaults to `pnpm test`
 *   HARNESS_SKIP_TESTS=1        skip pnpm test in deploy
 *   HARNESS_READY_TIMEOUT_MS    defaults to 60000 (1 minute)
 *   HARNESS_SHUTDOWN_TIMEOUT_MS defaults to 30000 (30 seconds)
 */

const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { join, resolve, dirname } = require('node:path');

const execFileAsync = promisify(execFile);

const LIFECYCLE_SUBDIR = '.lifecycle';
const READY_FILE = 'ready.json';
const HANDOFF_FILE = 'handoff.json';
const PID_FILE = 'pid';

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function die(msg, code = 1) {
  console.error(`supervisor: ${msg}`);
  process.exit(code);
}

function info(msg) {
  console.log(`supervisor: ${msg}`);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) die(`${name} is required`);
  return v;
}

function lifecycleDir(storeRoot) {
  return join(storeRoot, LIFECYCLE_SUBDIR);
}
function readyFilePath(storeRoot) {
  return join(lifecycleDir(storeRoot), READY_FILE);
}
function handoffFilePath(storeRoot) {
  return join(lifecycleDir(storeRoot), HANDOFF_FILE);
}
function pidFilePath(storeRoot) {
  return join(lifecycleDir(storeRoot), PID_FILE);
}

function writeAtomic(path, content) {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function readReady(storeRoot) {
  const p = readyFilePath(storeRoot);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

function readPid(storeRoot) {
  const p = pidFilePath(storeRoot);
  if (!existsSync(p)) return undefined;
  try {
    const v = Number(readFileSync(p, 'utf8').trim());
    return Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function rmIfPresent(path) {
  try {
    if (existsSync(path)) rmSync(path);
  } catch {
    /* best-effort */
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function git(repoRoot, args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot });
  return stdout.trim();
}

async function currentSha(repoRoot) {
  try {
    return await git(repoRoot, ['rev-parse', 'HEAD']);
  } catch {
    return undefined;
  }
}

async function resolveRefSha(repoRoot, ref) {
  return git(repoRoot, ['rev-parse', '--verify', ref]);
}

function runShell(cmd, opts) {
  // We run the deploy commands via the user's shell so they can use
  // env-based tooling (volta, nvm, fnm) the same way `pnpm` does
  // interactively. stdout / stderr are inherited so the operator
  // sees real-time output.
  return new Promise((resolveFn, rejectFn) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/s', '/c', cmd] : ['-c', cmd];
    const child = spawn(shell, shellArgs, {
      cwd: opts.cwd,
      env: opts.env || process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('close', (code) => {
      if (code === 0) resolveFn();
      else rejectFn(new Error(`${cmd} exited with code ${code}`));
    });
    child.on('error', rejectFn);
  });
}

function spawnHarness({ repoRoot, env, startCmd }) {
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'cmd.exe' : '/bin/sh';
  const shellArgs = isWindows ? ['/s', '/c', startCmd] : ['-c', startCmd];
  const child = spawn(shell, shellArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    detached: !isWindows,
    windowsHide: true,
  });
  return child;
}

async function waitForReady(storeRoot, expectedSha, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = readReady(storeRoot);
    if (ready && pidAlive(ready.pid)) {
      // Match expected SHA when we know it. On a `start` with no
      // explicit ref the supervisor accepts whatever sha the child
      // reports.
      if (!expectedSha || !ready.sha || ready.sha === expectedSha) {
        return ready;
      }
    }
    await sleep(150);
  }
  return undefined;
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(150);
  }
  return !pidAlive(pid);
}

function readonlyEnv(opts) {
  return Object.assign({}, process.env, opts.envOverride || {});
}

async function cmdStart(args) {
  const repoRoot = resolve(process.env.HARNESS_REPO_ROOT || process.cwd());
  const storeRoot = resolve(requireEnv('HARNESS_STORE_ROOT'));
  const startCmd = process.env.HARNESS_START_CMD || 'pnpm dev';
  const readyTimeout = Number(process.env.HARNESS_READY_TIMEOUT_MS || DEFAULT_READY_TIMEOUT_MS);
  const ref = args[0];

  if (ref) {
    info(`checking out ${ref}`);
    await git(repoRoot, ['fetch', 'origin']);
    await git(repoRoot, ['checkout', ref]);
  }

  // Clear stale lifecycle files. A prior crash may have left them.
  rmIfPresent(readyFilePath(storeRoot));
  rmIfPresent(pidFilePath(storeRoot));

  const sha = await currentSha(repoRoot);
  info(`starting harness${sha ? ` on ${sha.slice(0, 7)}` : ''}`);
  const env = readonlyEnv({ envOverride: { HARNESS_STORE_ROOT: storeRoot } });
  const child = spawnHarness({ repoRoot, env, startCmd });
  if (!child.pid) die('failed to spawn harness child');
  writeAtomic(pidFilePath(storeRoot), String(child.pid));

  const forward = (sig) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* gone */
      }
    }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  // Best-effort: surface ready status so the operator knows when to
  // start typing.
  void waitForReady(storeRoot, sha, readyTimeout).then((ready) => {
    if (ready) info(`harness ready (pid=${ready.pid})`);
    else info('harness did not report ready within timeout (continuing to follow child)');
  });

  await new Promise((resolveFn) => {
    child.on('close', (code) => {
      info(`harness exited code=${code}`);
      rmIfPresent(readyFilePath(storeRoot));
      rmIfPresent(pidFilePath(storeRoot));
      process.exit(code ?? 0);
      resolveFn();
    });
  });
}

async function cmdDeploy(args) {
  if (!args.length) die('deploy requires <ref> (branch, tag, or sha)');
  const ref = args[0];
  const repoRoot = resolve(process.env.HARNESS_REPO_ROOT || process.cwd());
  const storeRoot = resolve(requireEnv('HARNESS_STORE_ROOT'));
  const startCmd = process.env.HARNESS_START_CMD || 'pnpm dev';
  const buildCmd = process.env.HARNESS_BUILD_CMD || 'pnpm build';
  const testCmd = process.env.HARNESS_TEST_CMD || 'pnpm test';
  const skipTests = process.env.HARNESS_SKIP_TESTS === '1';
  const readyTimeout = Number(process.env.HARNESS_READY_TIMEOUT_MS || DEFAULT_READY_TIMEOUT_MS);
  const shutdownTimeout = Number(
    process.env.HARNESS_SHUTDOWN_TIMEOUT_MS || DEFAULT_SHUTDOWN_TIMEOUT_MS,
  );

  const oldReady = readReady(storeRoot);
  const oldPid = readPid(storeRoot) ?? oldReady?.pid;
  const oldSha = oldReady?.sha ?? (await currentSha(repoRoot));

  // Build + test happen on the candidate ref BEFORE we kill the
  // running harness. If anything fails we revert and exit non-zero;
  // the live harness keeps serving.
  info(`fetching origin`);
  await git(repoRoot, ['fetch', 'origin']);
  let newSha;
  try {
    newSha = await resolveRefSha(repoRoot, ref);
  } catch (err) {
    die(`unknown ref ${ref}: ${err.message}`);
  }
  info(`checking out ${ref} (${newSha.slice(0, 7)})`);
  await git(repoRoot, ['checkout', '--detach', newSha]);

  const env = readonlyEnv({ envOverride: { HARNESS_STORE_ROOT: storeRoot } });
  try {
    info('running install');
    await runShell('pnpm install --frozen-lockfile', { cwd: repoRoot, env });
    info('running build');
    await runShell(buildCmd, { cwd: repoRoot, env });
    if (!skipTests) {
      info('running tests');
      await runShell(testCmd, { cwd: repoRoot, env });
    } else {
      info('HARNESS_SKIP_TESTS=1 → skipping tests');
    }
  } catch (err) {
    info(`build/test failed: ${err.message}`);
    if (oldSha) {
      info(`reverting checkout to ${oldSha.slice(0, 7)}`);
      try {
        await git(repoRoot, ['checkout', '--detach', oldSha]);
      } catch (revErr) {
        info(`!! revert failed: ${revErr.message}`);
      }
    }
    die(`deploy aborted; live harness left running on ${oldSha?.slice(0, 7) ?? '<unknown>'}`);
  }

  // Build/test green: signal old, wait for clean exit, write handoff,
  // exec new.
  if (oldPid && pidAlive(oldPid)) {
    info(`stopping old harness (pid=${oldPid})`);
    try {
      process.kill(oldPid, 'SIGTERM');
    } catch {
      /* may already be gone */
    }
    const exited = await waitForExit(oldPid, shutdownTimeout);
    if (!exited) {
      info(`SIGTERM grace expired; sending SIGKILL to pid=${oldPid}`);
      try {
        process.kill(oldPid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  } else {
    info('no live harness pid; proceeding to fresh start');
  }
  rmIfPresent(readyFilePath(storeRoot));
  rmIfPresent(pidFilePath(storeRoot));

  // Write the handoff that the new harness consumes on boot.
  const handoff = {
    toSha: newSha,
    ref,
    outcome: 'success',
    writtenAt: new Date().toISOString(),
  };
  if (oldSha) handoff.fromSha = oldSha;
  writeAtomic(handoffFilePath(storeRoot), JSON.stringify(handoff, null, 2));

  info(`starting new harness on ${newSha.slice(0, 7)}`);
  const child = spawnHarness({ repoRoot, env, startCmd });
  if (!child.pid) die('failed to spawn new harness child');
  writeAtomic(pidFilePath(storeRoot), String(child.pid));

  const ready = await waitForReady(storeRoot, newSha, readyTimeout);
  if (!ready) {
    info(`new harness did not report ready within ${readyTimeout}ms`);
    // Best-effort kill the failing child. The operator must intervene
    // — true automatic rollback to the old build is out of scope for
    // this version of the supervisor.
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* */
    }
    die('deploy verification failed: ready file never appeared');
  }
  info(`new harness ready (pid=${ready.pid}) on ${newSha.slice(0, 7)}; exiting supervisor`);
  // Detach so the child outlives this process. The supervisor exits;
  // the operator can re-invoke `start` later if they want a
  // long-running shepherd.
  child.unref();
  process.exit(0);
}

function cmdStatus() {
  const storeRoot = resolve(requireEnv('HARNESS_STORE_ROOT'));
  const ready = readReady(storeRoot);
  const pid = readPid(storeRoot);
  console.log(`storeRoot:   ${storeRoot}`);
  console.log(`pid file:    ${pid ?? '<none>'}`);
  if (ready) {
    console.log(`ready file:  pid=${ready.pid} sha=${ready.sha ?? '<none>'} ref=${ready.ref ?? '<none>'} startedAt=${ready.startedAt}`);
    console.log(`alive:       ${pidAlive(ready.pid)}`);
  } else {
    console.log(`ready file:  <none>`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'start':
      await cmdStart(rest);
      break;
    case 'deploy':
      await cmdDeploy(rest);
      break;
    case 'status':
      cmdStatus();
      break;
    default:
      console.log('usage: supervisor.cjs <start [ref] | deploy <ref> | status>');
      process.exit(cmd === undefined ? 0 : 1);
  }
}

main().catch((err) => die(err.message || String(err), 1));
