// The parity test of ADR 0019 and ADR 0125: every command of the registry is a skill of the
// Foedrum plugin, or is marked terminal-only with a reason; every skill is a command of the
// registry, and runs its own command through the terminal with `--via plugin`.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { commands } from '../../src/cli/commands.ts';

const root = join(import.meta.dirname, '..', '..');
const plugin = join(root, 'plugin');
const skills = join(plugin, 'skills');
const skillFile = (name: string): string => join(skills, name, 'SKILL.md');
const skillNames = (): string[] =>
  existsSync(skills)
    ? readdirSync(skills, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];

describe('the plugin and the terminal (ADR 0125)', () => {
  it('has every command of the registry as a skill, or marked terminal-only with a reason', () => {
    const missing = commands
      .filter(
        ({ name, terminalOnly }) => terminalOnly === undefined && !existsSync(skillFile(name)),
      )
      .map(({ name }) => name);
    assert.deepStrictEqual(missing, []);
  });

  it('has no skill for a command marked terminal-only, and every mark gives a reason', () => {
    for (const { name, terminalOnly } of commands) {
      if (terminalOnly === undefined) continue;
      assert.notEqual(terminalOnly.trim(), '', `${name} is marked without a reason`);
      assert.equal(existsSync(skillFile(name)), false, `${name} is marked but has a skill`);
    }
  });

  it('has no skill that is not a command of the registry', () => {
    const names = new Set(commands.map(({ name }) => name));
    assert.deepStrictEqual(
      skillNames().filter((name) => !names.has(name)),
      [],
    );
  });

  it("runs each skill's own command with --via plugin, only when the engineer types it", () => {
    const names = skillNames();
    assert.notDeepEqual(names, []);
    const registry = new Set(commands.map(({ name }) => name));
    for (const name of names) {
      const text = readFileSync(skillFile(name), 'utf8');
      // The frontmatter alone: the lines between the first two `---` lines.
      const [, frontmatter = ''] = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text) ?? [];
      assert.ok(
        frontmatter.split(/\r?\n/).includes('disable-model-invocation: true'),
        `${name} may be invoked by the model`,
      );
      // A command line is an inline code span: a fenced block would go unread here.
      assert.doesNotMatch(text, /^```/m, `${name} has a fenced block`);
      // Every inline code span that names a command of the registry is a command line to run.
      const runs = [...text.matchAll(/`foedrum ([a-z]+)\b[^`]*`/g)].filter(([, command]) =>
        registry.has(command ?? ''),
      );
      assert.ok(
        runs.some(([, command]) => command === name),
        `${name} does not run foedrum ${name}`,
      );
      // Before any `--`, after which every argument is a positional one.
      for (const [span] of runs) {
        const [options = ''] = span.split(' -- ');
        assert.ok(options.includes(' --via plugin'), `${name}: ${span}`);
      }
    }
  });

  it('is the plugin foedrum, listed by the repository as its marketplace', () => {
    const manifest = JSON.parse(
      readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    assert.equal(manifest.name, 'foedrum');
    const marketplace = JSON.parse(
      readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'),
    );
    assert.deepStrictEqual(
      marketplace.plugins.map(({ name, source }: { name: string; source: string }) => [
        name,
        source,
      ]),
      [['foedrum', './plugin']],
    );
  });
});
