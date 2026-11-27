// Git's answer whether a commit is on the line to a head (ADR 0452): `isAncestorIn` reads exit 0
// and 1 and refuses any other end; the red tests read the map at the base merged on the line to the
// attempt's branch, else where the batch started; and an attempt plan that must ask git for a
// merge says so when it has none. A fake git and test map (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import type { MapRead, ReadTestMapAt } from '../../src/checks/test-map.ts';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { baseMergeKey } from '../../src/engine/base-merge.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { isAncestorIn } from '../../src/workspace/clone-git.ts';
import type { Git, GitResult } from '../../src/workspace/git.ts';
import { claudeModels } from '../helpers/models.ts';

describe('isAncestorIn (ADR 0452)', () => {
  const answer = (code: number | null, stderr = ''): GitResult => ({ code, stdout: '', stderr });
  const asking = (result: GitResult) => {
    const calls: { cwd: string; args: readonly string[]; hooks: unknown; signal: unknown }[] = [];
    const git: Git = async (cwd, args, options) => {
      calls.push({
        cwd,
        args,
        hooks: options?.config?.['core.hooksPath'],
        signal: options?.signal,
      });
      return result;
    };
    return { git, calls };
  };

  it('says a commit git finds on the line is an ancestor, in the clone with no hook of its own', async () => {
    const { git, calls } = asking(answer(0));
    const stop = new AbortController();
    assert.equal(
      await isAncestorIn(git, '/clone', stop.signal)('c'.repeat(40), 'refs/heads/x'),
      true,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, [
      'merge-base',
      '--is-ancestor',
      'c'.repeat(40),
      'refs/heads/x',
    ]);
    assert.equal(calls[0]?.cwd, '/clone');
    assert.notEqual(calls[0]?.hooks, undefined);
    assert.equal(calls[0]?.signal, stop.signal);
  });

  it('says a commit git finds off the line is no ancestor', async () => {
    const { git } = asking(answer(1));
    assert.equal(await isAncestorIn(git, '/clone')('c'.repeat(40), 'refs/heads/x'), false);
  });

  it('refuses any other end of git, naming its last line', async () => {
    const { git } = asking(answer(128, 'fatal: Not a valid object name refs/heads/x\n'));
    await assert.rejects(isAncestorIn(git, '/clone')('c'.repeat(40), 'refs/heads/x'), {
      message: /^git merge-base failed: .*Not a valid object name refs\/heads\/x/,
    });
  });
});

const loaded = loadRecipes(readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')));
assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));

const root = join('/work', 'acme.api', 'attempts', '12-1');
const gaugeStart = 'a'.repeat(40);
const merged = { base: 'b'.repeat(40), merged: 'd'.repeat(40) };
const sessions: Record<string, string> = {
  map: '0f8fad5b-d9cb-469f-a165-70867728950d',
  gauge: '0f8fad5b-d9cb-469f-a165-70867728950a',
  implement: '0f8fad5b-d9cb-469f-a165-70867728950b',
};
const at = (stepId: string): AttemptRef => ({ batchId: '12-1', stepId, attempt: 1 });
const started = (stepId: string, commit: string): Event[] => {
  const worktree = {
    repo: 'acme/api',
    path: join(root, stepId, '1'),
    branch: `foedrum/12-1/${stepId}/1`,
    commit,
  };
  return [
    { type: 'step.scheduled', ...at(stepId), deadlineAt: '2026-10-18T12:30:00.000Z' },
    {
      type: 'step.started',
      ...at(stepId),
      session: { id: sessions[stepId] ?? '', worktree: worktree.path },
      worktree,
    },
  ];
};
const finished = (stepId: string, output: object): Event => ({
  type: 'step.finished',
  ...at(stepId),
  outcome: { kind: 'succeeded', output: { status: 'done', summary: 'Done', ...output } },
});
const merge: Event = {
  type: 'effect.applied',
  key: effectKey.encode(baseMergeKey(at('implement'))),
  result: merged,
};
const events: Event[] = [
  {
    type: 'batch.ordered',
    batchId: '12-1',
    order: { issue: 12 },
    routeBy: '2026-10-18T14:00:00.000Z',
  },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'nip', reason: 'l', source: 'label' },
  ...started('map', gaugeStart),
  finished('map', {}),
  ...started('gauge', gaugeStart),
  finished('gauge', { tests: ['adds'] }),
  ...started('implement', 'c'.repeat(40)),
  merge,
];
const gaugeDiff = [
  'diff --git a/test/add.test.mjs b/test/add.test.mjs',
  '--- /dev/null',
  '+++ b/test/add.test.mjs',
  '@@ -0,0 +1 @@',
  '+x',
  '',
].join('\n');
const map: MapRead = {
  kind: 'map',
  map: {
    derivedFrom: { globs: ['package.json'], paths: ['package.json'] },
    modules: [
      {
        name: 'api',
        code: ['src/**'],
        tests: { paths: ['test/**'] },
        testReport: { format: 'tap', path: 'report.tap' },
        coverage: 'none',
      },
    ],
  },
};

const plansOf = (git?: Git, testMapAt: ReadTestMapAt = async () => map) =>
  createAttemptPlans({
    state: () => fold(events),
    brewers: loaded.brewers,
    models: claudeModels({ standard: 'claude-sonnet-5-5', light: 'claude-haiku-5-5' }),
    repoTools: () => ['Bash(npm test)'],
    repoChecks: () => ({
      build: null,
      typecheck: 'tsc',
      lint: 'biome lint',
      format: 'biome format',
      test: 'node --test',
    }),
    provenStep: (recipe) => loaded.checks.redProof(recipe)?.of,
    clone: (repo) => join('/clones', repo),
    ...(git === undefined ? {} : { git }),
    testMapAt,
    sandbox: false,
    workRoot: join('/root'),
    env: { base: { PATH: '/usr/bin' }, forced: {} },
    platform: 'linux',
    orderText: async () => 'Add a --json flag.',
    orderComments: async () => [],
    files: { read: () => ({ kind: 'text', text: '# Guide' }), makeFolder: () => {} },
  });
const start = {
  ref: at('implement'),
  limits: { outDoc: { file: 'out.md', schema: OutDocFrontmatter } },
};

describe('the base a batch merged, read by an attempt plan (ADR 0452)', () => {
  /** A git that lists the Gauger's change, and says the commits `off` are no ancestor of the head. */
  const gitWith = (off: string[]) => {
    const ancestry: string[] = [];
    const git: Git = async (_cwd, args) => {
      if (args[0] === 'merge-base') {
        ancestry.push(args.slice(2).join(' '));
        return { code: off.includes(args[2] ?? '') ? 1 : 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: args.includes('diff') ? gaugeDiff : '', stderr: '' };
    };
    return { git, ancestry };
  };
  const mapsAsked = async (git: Git) => {
    const asked: string[] = [];
    const testMapAt: ReadTestMapAt = async (_repo, commit) => {
      asked.push(commit);
      return map;
    };
    await plansOf(git, testMapAt).plan(start);
    return asked;
  };

  it("reads the red tests' map at the merged base when the attempt's branch holds the merge", async () => {
    const { git, ancestry } = gitWith([]);
    const asked = await mapsAsked(git);
    assert.ok(asked.includes(merged.base), asked.join(', '));
    assert.ok(!asked.includes(gaugeStart), asked.join(', '));
    // The merge is asked of the attempt's branch for the red tests, and of its start commit for its inputs.
    assert.ok(
      ancestry.includes(`${merged.merged} refs/heads/foedrum/12-1/implement/1`),
      ancestry.join(' | '),
    );
  });

  it("reads the red tests' map where the batch started when the merge is not on the attempt's branch", async () => {
    const { git } = gitWith([merged.merged]);
    const asked = await mapsAsked(git);
    assert.ok(asked.includes(gaugeStart), asked.join(', '));
    assert.ok(!asked.includes(merged.base), asked.join(', '));
  });

  it('says it was given no git when a merge needs its answer', async () => {
    await assert.rejects(plansOf().plan(start), { message: /no git/ });
  });
});

describe('the head an attempt plan asks of, for an attempt that merges the base at its start (ADR 0452)', () => {
  it("asks of the attempt's branch only, since its merge is made after its start commit", async () => {
    const asked: string[] = [];
    const git: Git = async (_cwd, args) => {
      if (args[0] === 'merge-base') asked.push(args[3] ?? '');
      return { code: 0, stdout: args.includes('diff') ? gaugeDiff : '', stderr: '' };
    };
    await plansOf(git).plan(start);
    assert.ok(asked.length > 0);
    assert.deepEqual(
      asked.filter((head) => head !== 'refs/heads/foedrum/12-1/implement/1'),
      [],
    );
  });
});
