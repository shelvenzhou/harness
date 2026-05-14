import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeSystemPrompt, loadPrompts } from '@harness/cli/prompts.js';

describe('loadPrompts', () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env['HARNESS_PROMPTS_DIR'];
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env['HARNESS_PROMPTS_DIR'];
    else process.env['HARNESS_PROMPTS_DIR'] = prevEnv;
  });

  it('returns empty result when the explicit directory does not exist and env / cwd fall through', () => {
    delete process.env['HARNESS_PROMPTS_DIR'];
    const missing = join(tmpdir(), `harness-no-such-dir-${Date.now()}-${Math.random()}`);
    const r = loadPrompts({ dir: missing });
    // We deliberately don't assert dir === undefined: process.cwd() may
    // contain a real `prompts/` (the harness's own). What we ARE
    // contracting: nothing crashes, and the structure is well-formed.
    expect(r.playbooks).toEqual(expect.any(Array));
    expect(r.byRole).toEqual(expect.any(Object));
  });

  it('reads main + playbooks + roles by filename convention from an explicit dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-prompts-'));
    const dir = join(root, 'prompts');
    mkdirSync(dir);
    writeFileSync(join(dir, 'main.md'), '# main\nbody');
    writeFileSync(join(dir, 'playbook-self-update.md'), 'self-update body');
    writeFileSync(join(dir, 'playbook-spawn.md'), 'spawn body');
    writeFileSync(join(dir, 'role-designer.md'), 'designer body');
    writeFileSync(join(dir, 'role-reviewer.md'), 'reviewer body');
    writeFileSync(join(dir, 'README.md'), 'not loaded'); // ignored

    const r = loadPrompts({ dir });
    expect(r.dir).toBe(dir);
    expect(r.main).toBe('# main\nbody');
    // Playbooks are emitted in alphabetic order of filename.
    expect(r.playbooks).toEqual([
      { name: 'playbook-self-update.md', content: 'self-update body' },
      { name: 'playbook-spawn.md', content: 'spawn body' },
    ]);
    expect(r.byRole).toEqual({
      designer: 'designer body',
      reviewer: 'reviewer body',
    });
  });

  it('uses HARNESS_PROMPTS_DIR when explicit dir is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-envprompts-'));
    const dir = join(root, 'env-prompts');
    mkdirSync(dir);
    writeFileSync(join(dir, 'main.md'), 'env-driven');
    process.env['HARNESS_PROMPTS_DIR'] = dir;
    const missing = join(root, 'does-not-exist');

    const r = loadPrompts({ dir: missing });
    expect(r.dir).toBe(dir);
    expect(r.main).toBe('env-driven');
  });

  it('skips empty .md files', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-empty-'));
    const dir = join(root, 'prompts');
    mkdirSync(dir);
    writeFileSync(join(dir, 'main.md'), '   \n   ');
    writeFileSync(join(dir, 'playbook-stub.md'), '');
    writeFileSync(join(dir, 'role-blank.md'), '\n\n');

    const r = loadPrompts({ dir });
    expect(r.main).toBeUndefined();
    expect(r.playbooks).toEqual([]);
    expect(r.byRole).toEqual({});
  });

  it('composes playbooks into stable system prompt text', () => {
    const prompt = composeSystemPrompt('base', [
      { name: 'playbook-self-update.md', content: 'self-update body' },
    ]);

    expect(prompt).toContain('base');
    expect(prompt).toContain('# Harness Playbooks');
    expect(prompt).toContain('<harness_playbook name="playbook-self-update.md">');
    expect(prompt).toContain('self-update body');
    expect(prompt).toContain('</harness_playbook>');
  });
});
