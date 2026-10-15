import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BreweryConfig } from '../../src/schemas/brewery-config.ts';
import { readJsonc } from '../../src/schemas/read.ts';

const fixture = join(import.meta.dirname, '..', 'fixtures', 'config', 'foedrum.jsonc');

const checks = {
  build: null,
  typecheck: null,
  lint: 'npm run lint',
  format: null,
  test: 'npm test',
};

const config = (repository: Record<string, unknown>, fields: Record<string, unknown> = {}) => ({
  permissionCeiling: ['Bash(npm *)'],
  repositories: { 'acme/web': { checks, ...repository } },
  ...fields,
});

const accepted = (value: unknown): boolean => BreweryConfig.safeParse(value).success;

describe('BreweryConfig', () => {
  it('accepts the example foedrum.jsonc, with its comments and $schema', () => {
    const result = readJsonc(readFileSync(fixture, 'utf8'), BreweryConfig);
    assert.equal(result.valid, true, result.valid ? '' : result.reason);
  });

  it('fills in the defaults of a repository and the ceiling', () => {
    assert.deepEqual(BreweryConfig.parse({ repositories: { 'acme/web': { checks } } }), {
      permissionCeiling: [],
      repositories: { 'acme/web': { checks, tools: [], houseYeast: 'repo' } },
    });
  });

  it('accepts a Brewery without repositories', () => {
    assert.equal(accepted({ repositories: {} }), true);
  });

  it('accepts a TAP report on standard output or in a file, and a JUnit XML file', () => {
    for (const testReport of [
      { format: 'tap' },
      { format: 'tap', path: 'reports/tests.tap' },
      { format: 'junit', path: 'reports/junit.xml' },
    ]) {
      assert.equal(accepted(config({ testReport })), true, JSON.stringify(testReport));
    }
  });

  it('accepts repository tools within the permission ceiling', () => {
    assert.equal(accepted(config({ tools: ['Bash(npm test*)', 'Bash(npm run lint*)'] })), true);
  });

  const missingCheck = Object.fromEntries(
    Object.entries(checks).filter(([key]) => key !== 'format'),
  );
  const invalid: [string, unknown][] = [
    ['no repositories', { permissionCeiling: [] }],
    ['an unknown field', { repositories: {}, concurrency: 2 }],
    ['a $schema that is not a string', { $schema: 1, repositories: {} }],
    ['a repository key that is not owner/name', { repositories: { web: { checks } } }],
    ['a repository key with a parent segment', { repositories: { 'acme/..': { checks } } }],
    [
      'two repositories that differ only in case',
      { repositories: { 'acme/web': { checks }, 'Acme/Web': { checks } } },
    ],
    ['a repository without checks', { repositories: { 'acme/web': {} } }],
    ['a missing check, which must be null when not available', config({ checks: missingCheck })],
    ['an unknown check', config({ checks: { ...checks, e2e: 'npm run e2e' } })],
    ['an empty check command', config({ checks: { ...checks, lint: '' } })],
    ['a check command of more than one line', config({ checks: { ...checks, lint: 'a\nb' } })],
    ['an unknown repository field', config({ release: 'tag' })],
    ['an unknown house-yeast location', config({ houseYeast: 'nowhere' })],
    ['an unknown test report format', config({ testReport: { format: 'xunit', path: 'r.xml' } })],
    ['a JUnit report without a path', config({ testReport: { format: 'junit' } })],
    ['an absolute report path', config({ testReport: { format: 'junit', path: '/tmp/r.xml' } })],
    [
      'a report path outside the worktree',
      config({ testReport: { format: 'tap', path: '../r.tap' } }),
    ],
    ['a report path with a backslash', config({ testReport: { format: 'tap', path: 'a\\r.tap' } })],
    [
      'a test report without a test check',
      config({ checks: { ...checks, test: null }, testReport: { format: 'tap' } }),
    ],
    ['a setup without a timeout', config({ setup: { command: 'npm ci' } })],
    ['a setup without a command', config({ setup: { timeout: '10m' } })],
    ['a setup with an invalid timeout', config({ setup: { command: 'npm ci', timeout: 'ten' } })],
    ['a setup as a plain command', config({ setup: 'npm ci' })],
    ['AskUserQuestion in the repository tools', config({ tools: ['AskUserQuestion'] })],
    ['an invalid tool rule', config({ tools: ['Bash(npm test*'] })],
    ['an invalid ceiling rule', config({}, { permissionCeiling: ['Bash('] })],
  ];
  for (const [what, value] of invalid) {
    it(`rejects ${what}`, () => {
      assert.equal(accepted(value), false);
    });
  }

  const beyond: [string, unknown, (string | number)[]][] = [
    [
      'a tool broader than the ceiling',
      config({ tools: ['Bash(npm test*)', 'Bash(*)'] }),
      ['repositories', 'acme/web', 'tools', 1],
    ],
    [
      'a tool when the ceiling is empty',
      config({ tools: ['Read'] }, { permissionCeiling: [] }),
      ['repositories', 'acme/web', 'tools', 0],
    ],
    [
      'a tool when there is no ceiling',
      { repositories: { 'acme/web': { checks, tools: ['Bash(npm test*)'] } } },
      ['repositories', 'acme/web', 'tools', 0],
    ],
  ];
  for (const [what, value, path] of beyond) {
    it(`rejects ${what}, pointing at the tool`, () => {
      const result = BreweryConfig.safeParse(value);
      assert.equal(result.success, false);
      assert.deepEqual(
        result.error?.issues.map((issue) => issue.path),
        [path],
      );
      assert.match(result.error?.message ?? '', /permission ceiling/);
    });
  }
});
