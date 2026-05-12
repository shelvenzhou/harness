import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * `prompts/` directory loader.
 *
 * Convention over configuration: a single directory holds three kinds
 * of plain-Markdown files, each picked up by filename. The runtime
 * never sees this directory — the CLI reads the files and hands
 * strings to `bootstrap` via the existing options. Files are the
 * source of truth (in git, diffable, reviewable in PRs); pinned
 * memory / system-prompt strings are the runtime's view.
 *
 *   main.md                  → root agent system prompt
 *   playbook-<name>.md       → one entry in pinnedMemory
 *   role-<name>.md           → suffix for spawn({ role: <name>, … })
 *
 * Anything else in the directory is ignored. A missing directory is
 * not an error — the CLI's hardcoded fallbacks apply.
 */

export interface LoadedPrompts {
  /** Resolved directory (absent when nothing was found). */
  dir?: string;
  /** Contents of `main.md` if present. */
  main?: string;
  /**
   * Contents of every `playbook-*.md` in alphabetic order, each
   * already trimmed. Suitable for direct injection into
   * `bootstrap.pinnedMemory`.
   */
  pinned: string[];
  /**
   * `role -> contents` for every `role-<name>.md`. Keys are the part
   * after `role-` (lowercased verbatim — no normalisation), e.g.
   * `role-designer.md` lands as key `designer`.
   */
  byRole: Record<string, string>;
}

export interface LoadPromptsOptions {
  /**
   * Explicit directory to read. When omitted, `loadPrompts` checks
   * `HARNESS_PROMPTS_DIR` (absolute or cwd-relative), then a
   * `prompts/` sibling of `process.cwd()`. The first existing one
   * wins.
   */
  dir?: string;
}

export function loadPrompts(opts: LoadPromptsOptions = {}): LoadedPrompts {
  const resolved = resolvePromptsDir(opts.dir);
  if (resolved === undefined) {
    return { pinned: [], byRole: {} };
  }
  return readPromptsDir(resolved);
}

function resolvePromptsDir(explicit?: string): string | undefined {
  const candidates: string[] = [];
  if (explicit !== undefined) candidates.push(resolve(explicit));
  const envDir = process.env['HARNESS_PROMPTS_DIR'];
  if (typeof envDir === 'string' && envDir.length > 0) {
    candidates.push(resolve(envDir));
  }
  candidates.push(resolve(process.cwd(), 'prompts'));
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c;
  }
  return undefined;
}

function readPromptsDir(dir: string): LoadedPrompts {
  const out: LoadedPrompts = { dir, pinned: [], byRole: {} };
  const entries = readdirSync(dir).sort();
  const playbooks: Array<{ name: string; content: string }> = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const full = join(dir, name);
    let body: string;
    try {
      body = readFileSync(full, 'utf8').trim();
    } catch {
      continue;
    }
    if (body.length === 0) continue;
    if (name === 'main.md') {
      out.main = body;
      continue;
    }
    const playbookMatch = /^playbook-(.+)\.md$/.exec(name);
    if (playbookMatch) {
      playbooks.push({ name, content: body });
      continue;
    }
    const roleMatch = /^role-(.+)\.md$/.exec(name);
    if (roleMatch) {
      const role = roleMatch[1];
      if (role !== undefined) out.byRole[role] = body;
      continue;
    }
    // Other .md files ignored — README.md etc. is allowed.
  }
  out.pinned = playbooks.map((p) => p.content);
  return out;
}
