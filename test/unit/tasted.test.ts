// models.jsonc's tasted list: the latest Flight of each brewer, recipe, level and effort, in the
// claude block, which a Brewery's list merges over Foedrum's by that combination (ADR 0416). Pure:
// the schema and serveSetup over the files' text, no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { ModelsConfig } from '../../src/schemas/models.ts';
import { serveInputs } from '../helpers/serve-brewery.ts';

/** The issue's example entry, in Foedrum's effort words. */
const ENTRY = {
  brewer: 'cellarman',
  recipe: 'nip',
  level: 'strong',
  effort: 'larger',
  model: 'claude-opus-5-5',
  passed: 9,
  runs: 10,
  baseline: { passed: 8, runs: 10, model: 'claude-opus-5' },
  tokensPerOrder: 412000,
  date: '2026-11-20',
  report: 'https://github.com/acme/brewery/pull/12',
};

/** A models.jsonc whose claude block holds `tasted`. */
const withTasted = (tasted: readonly unknown[]) => ({
  claude: { models: { strong: 'opus' }, tasted },
});

/** Where `value` fails, as a dotted path, or undefined when it passes. */
const failsAt = (value: unknown): string | undefined => {
  const result = ModelsConfig.safeParse(value);
  return result.success ? undefined : (result.error.issues[0]?.path ?? []).join('.');
};

describe('the tasted list in models.jsonc (ADR 0416)', () => {
  it('holds the latest Flight of a brewer, recipe, level and effort in the claude block, its report link optional', () => {
    const { report: _, ...unlinked } = ENTRY;
    const parsed = ModelsConfig.safeParse(
      withTasted([ENTRY, { ...unlinked, recipe: 'deep-brew' }]),
    );
    assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    assert.deepEqual(parsed.data?.claude.tasted, [ENTRY, { ...unlinked, recipe: 'deep-brew' }]);
  });

  it('is empty when a models.jsonc names no tasting', () => {
    const parsed = ModelsConfig.safeParse({ claude: { models: { strong: 'opus' } } });
    assert.deepEqual(parsed.data?.claude.tasted, []);
  });

  it('refuses two entries of one brewer, recipe, level and effort, naming the combination', () => {
    const result = ModelsConfig.safeParse(
      withTasted([ENTRY, { ...ENTRY, model: 'claude-opus-5' }]),
    );
    assert.equal(result.success, false);
    assert.match(
      result.error?.issues[0]?.message ?? '',
      /cellarman in nip on strong at larger is tasted twice/,
    );
  });

  it('keeps two entries that differ only in their brewer, recipe, level or effort', () => {
    const others = [
      { ...ENTRY, brewer: 'gauger' },
      { ...ENTRY, recipe: 'deep-brew' },
      { ...ENTRY, level: 'extreme' },
      { ...ENTRY, effort: 'full' },
    ];
    for (const other of others) {
      assert.equal(failsAt(withTasted([ENTRY, other])), undefined, JSON.stringify(other));
    }
  });

  it("refuses an effort in Claude Code's words: the combination is Foedrum's level and effort", () => {
    assert.equal(failsAt(withTasted([{ ...ENTRY, effort: 'high' }])), 'claude.tasted.0.effort');
  });

  it('refuses a model that is no model id', () => {
    assert.equal(failsAt(withTasted([{ ...ENTRY, model: 'opus 5' }])), 'claude.tasted.0.model');
  });

  it("refuses a baseline's model that is no model id", () => {
    const baseline = { ...ENTRY.baseline, model: 'opus&calc' };
    assert.equal(failsAt(withTasted([{ ...ENTRY, baseline }])), 'claude.tasted.0.baseline.model');
  });

  it('refuses a count of orders that is not a whole number', () => {
    assert.equal(failsAt(withTasted([{ ...ENTRY, passed: 8.5 }])), 'claude.tasted.0.passed');
  });

  it('refuses a date that is not YYYY-MM-DD', () => {
    assert.equal(
      failsAt(withTasted([{ ...ENTRY, date: '20 November 2026' }])),
      'claude.tasted.0.date',
    );
  });

  it('refuses a report that is not an https link', () => {
    assert.equal(
      failsAt(withTasted([{ ...ENTRY, report: 'http://github.com/acme/brewery/pull/12' }])),
      'claude.tasted.0.report',
    );
  });

  it('refuses a field the entry does not have', () => {
    assert.equal(
      failsAt(withTasted([{ ...ENTRY, verdict: 'candidate better' }])),
      'claude.tasted.0',
    );
  });
});

describe("a Brewery's tasted list merged over Foedrum's (ADR 0416)", () => {
  /** serve's merged tasted list of Foedrum's `defaults` and the Brewery's `own`. */
  const merged = (defaults: readonly unknown[], own: readonly unknown[] | undefined) => {
    const base = serveInputs();
    const models = (tasted: readonly unknown[]) =>
      JSON.stringify({
        claude: { models: { light: 'claude-haiku-5-5' }, efforts: { small: 'low' }, tasted },
      });
    const result = serveSetup({
      ...base,
      files: {
        ...base.files,
        models: own === undefined ? undefined : models(own),
        brewery: {
          ...base.files.brewery,
          defaults: {
            brewers: [],
            models: { path: 'defaults/models.jsonc', text: models(defaults) },
          },
        },
      },
    });
    assert.equal(result.kind, 'ready', result.kind === 'refused' ? result.problems.join('\n') : '');
    return result.kind === 'ready' ? result.setup.models.claude.tasted : assert.fail();
  };

  it("keeps Foedrum's entries when the Brewery has no models.jsonc", () => {
    assert.deepEqual(merged([ENTRY], undefined), [ENTRY]);
  });

  it("puts a Brewery's entry in place of Foedrum's of the same combination, and appends its new ones", () => {
    const gauger = { ...ENTRY, brewer: 'gauger' };
    const ours = { ...ENTRY, model: 'claude-opus-5-6', date: '2026-12-01' };
    const fresh = { ...ENTRY, brewer: 'finer' };
    assert.deepEqual(merged([ENTRY, gauger], [fresh, ours]), [ours, gauger, fresh]);
  });

  it('keeps a default entry that differs from the Brewery entry only in its brewer, recipe, level or effort', () => {
    const others = [
      { ...ENTRY, brewer: 'gauger' },
      { ...ENTRY, recipe: 'deep-brew' },
      { ...ENTRY, level: 'extreme' },
      { ...ENTRY, effort: 'full' },
    ];
    const ours = { ...ENTRY, model: 'claude-opus-5-6' };
    assert.deepEqual(merged(others, [ours]), [...others, ours]);
  });
});
