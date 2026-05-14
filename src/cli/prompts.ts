import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * `prompts/` directory loader.
 *
 * Convention over configuration: a single directory holds three kinds
 * of plain-Markdown files, each picked up by filename. The runtime
 * never sees this directory — the CLI reads the files and hands
 * strings to `bootstrap` via the existing options. Files are the
 * source of truth (in git, diffable, reviewable in PRs); system
 * prompt text and role suffixes are the runtime's view.
 *
 *   main.md                  → root agent system prompt
 *   playbook-<name>.md       → one stable system-prompt playbook entry
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
   * Every `playbook-*.md` in alphabetic order, each already trimmed.
   * These are static instruction text, so callers should append them
   * to the stable system prompt rather than treating them as pinned
   * conversational memory.
   */
  playbooks: Array<{ name: string; content: string }>;
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
    return { playbooks: [], byRole: {} };
  }
  return readPromptsDir(resolved);
}

export function composeSystemPrompt(base: string, playbooks: LoadedPrompts['playbooks']): string {
  if (playbooks.length === 0) return base;
  const renderedPlaybooks = playbooks
    .map(
      ({ name, content }) =>
        `<harness_playbook name="${escapeAttr(name)}">\n${content}\n</harness_playbook>`,
    )
    .join('\n\n');
  return [
    base.trimEnd(),
    '# Harness Playbooks',
    'The following durable playbooks are instruction-level workflow policy. They are static prompt context, not user memory. When a playbook applies, follow it over generic guidance unless a direct user instruction conflicts.',
    renderedPlaybooks,
  ].join('\n\n');
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
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
  const out: LoadedPrompts = { dir, playbooks: [], byRole: {} };
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
  out.playbooks = playbooks;
  return out;
}
