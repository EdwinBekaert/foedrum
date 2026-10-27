// The brew-audit workflow's bookkeeping (ADR 0245): which findings it keeps, drops and carries into
// findings.json, run as the Workflow tool runs it, a function body, with fake agents.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(
  join(import.meta.dirname, '..', '..', '.claude', 'workflows', 'brew-audit.js'),
  'utf8',
);
const body = source.replace('export const meta', 'const meta');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const SHA = 'a'.repeat(40);
const SINCE = 'b'.repeat(40);

type Call = { prompt: string; opts: { label: string; agentType?: string } };
type Answers = Record<string, unknown>;

/** Runs the workflow; each agent answers what `answers` holds for its label, a finder with no answer finds nothing. */
async function run(args: Record<string, unknown>, answers: Answers) {
  const calls: Call[] = [];
  const agent = async (prompt: string, opts: Call['opts']) => {
    calls.push({ prompt, opts });
    if (opts.label in answers) return answers[opts.label];
    if (opts.label.startsWith('find:')) return { area: 'x', verdict: 'clean', findings: [] };
    return 'the report';
  };
  const pipeline = (
    items: unknown[],
    ...stages: ((r: unknown, item: unknown, i: number) => unknown)[]
  ) =>
    Promise.all(
      items.map(async (item, i) => {
        let r: unknown = item;
        for (const stage of stages) r = await stage(r, item, i);
        return r;
      }),
    );
  const workflow = new AsyncFunction('args', 'agent', 'pipeline', 'log', 'phase', body);
  const out = await workflow(
    { root: 'R', sha: SHA, repo: 'o/r', ...args },
    agent,
    pipeline,
    () => {},
    () => {},
  );
  return { out, calls };
}

const finding = (id: string) => ({
  id,
  dimension: 'smell',
  severity: 'low',
  file: `${id}.ts`,
  line: 1,
  title: id,
  what: 'w',
  why: 'y',
  fix: 'f',
});
const ids = (findings: { id: string }[]) => findings.map((f) => f.id).sort();

describe('the brew-audit workflow', () => {
  it('starts every agent as the read-only auditor', async () => {
    const { calls } = await run(
      {},
      {
        'find:cli': { area: 'cli', verdict: 'v', findings: [finding('cli-1')] },
        'verify:cli': {
          area: 'cli',
          verdict: 'vv',
          kept: [],
          dropped: [{ id: 'cli-1', reason: 'r' }],
        },
      },
    );
    assert.ok(calls.length > 0);
    assert.deepEqual(
      calls.filter((c) => c.opts.agentType !== 'auditor').map((c) => c.opts.label),
      [],
    );
  });

  it('keeps what the skeptic keeps, with its severity and an id made unique by the commit', async () => {
    const { out } = await run(
      {},
      {
        'find:cli': { area: 'cli', verdict: 'v', findings: [finding('cli-1'), finding('cli-2')] },
        'verify:cli': {
          area: 'cli',
          verdict: 'vv',
          kept: [{ id: 'cli-1', severity: 'medium', note: 'n' }],
          dropped: [{ id: 'cli-2', reason: 'r' }],
        },
      },
    );
    assert.deepEqual(out.findings, [
      {
        ...finding('cli-1'),
        id: 'cli-1@aaaaaaaa',
        area: 'cli',
        severity: 'medium',
        verifierNote: 'n',
      },
    ]);
  });

  it('ignores a kept id the auditor never reported', async () => {
    const { out } = await run(
      {},
      {
        'find:cli': { area: 'cli', verdict: 'v', findings: [finding('cli-1')] },
        'verify:cli': {
          area: 'cli',
          verdict: 'vv',
          kept: [{ id: 'cli-9', severity: 'low', note: 'n' }],
          dropped: [{ id: 'cli-1', reason: 'r' }],
        },
      },
    );
    assert.deepEqual(out.findings, []);
  });

  it('names an area with no auditor result as missing', async () => {
    const { out } = await run({}, { 'find:tests': null });
    assert.deepEqual(out.missing, ['tests']);
  });

  it('carries an earlier finding found open, at its new line, and drops one found fixed or gone', async () => {
    const previous = [
      { ...finding('old-open'), area: 'cli' },
      { ...finding('old-fixed'), area: 'cli' },
      { ...finding('old-gone'), area: 'cli' },
    ];
    const { out } = await run(
      { since: SINCE, previous, changed: ['src/cli/a.ts'] },
      {
        'find:cli': {
          area: 'cli',
          verdict: 'v',
          findings: [],
          previous: [
            { id: 'old-open', state: 'open', line: 7 },
            { id: 'old-fixed', state: 'fixed' },
            { id: 'old-gone', state: 'gone' },
          ],
        },
      },
    );
    assert.deepEqual(out.findings, [{ ...finding('old-open'), area: 'cli', line: 7 }]);
  });

  it('carries an earlier finding the auditor did not re-check, and every earlier finding of a missing area', async () => {
    const previous = [
      { ...finding('old-cli'), area: 'cli' },
      { ...finding('old-tests'), area: 'tests' },
    ];
    const { out } = await run({ since: SINCE, previous, changed: [] }, { 'find:tests': null });
    assert.deepEqual(ids(out.findings), ['old-cli', 'old-tests']);
  });

  it('gives the since-auditors the changed files as data, and asks them to run nothing', async () => {
    const { calls } = await run(
      { since: SINCE, previous: [], changed: ['src/cli/a.ts', 'docs/adr/0001-x.md'] },
      {},
    );
    const cli = calls.find((c) => c.opts.label === 'find:cli');
    const adrs = calls.find((c) => c.opts.label === 'find:adrs');
    assert.match(cli?.prompt ?? '', /src\/cli\/a\.ts, docs\/adr\/0001-x\.md/);
    assert.match(adrs?.prompt ?? '', /since then \(docs\/adr\/0001-x\.md\)/);
    assert.deepEqual(
      calls.filter((c) => c.prompt.includes('git -C')).map((c) => c.opts.label),
      [],
    );
  });

  it('returns no report when the report agent writes nothing', async () => {
    const { out } = await run({}, { report: '' });
    assert.equal(out.report, null);
  });
});
