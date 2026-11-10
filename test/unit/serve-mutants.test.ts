// A Brewery recipe's Brett step through `foedrum serve`'s wiring (ADR 0313): Brett's mutants run
// in scratch trees of the attempt's commit, and its step.finished records each verdict, which
// `foedrum replay` prints. Fake scratch trees in a test folder and a fake test command that writes
// a TAP report there; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { formatReplay } from '../../src/cli/replay.ts';
import { runServe, type ServeShell } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import type { MutantEdit } from '../../src/schemas/out-doc.ts';
import type { Git } from '../../src/workspace/git.ts';
import type { CommitTree } from '../../src/workspace/merge-tree-git.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { FAKE_COMMIT, fakeWorktreeMerge, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { brewer, config, local, serveInputs } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const t0 = new Date('2026-11-03T12:00:00.000Z');

// The cellarman brews, Brett proposes mutants of its change, and the pull request opens.
const tasting = JSON.stringify({
  name: 'tasting',
  type: 'brew',
  description: 'Brews an order, then has Brett mutate its change.',
  steps: [
    { id: 'brew', brewer: 'cellarman' },
    { id: 'brett', brewer: 'brett' },
    { action: 'openPullRequest' },
  ],
  testFirst: false,
});

const map = JSON.stringify({
  derivedFrom: { globs: ['package.json'], paths: ['package.json'] },
  modules: [
    {
      name: 'web',
      code: ['src/**'],
      tests: { paths: ['test/**'] },
      testReport: { format: 'tap', path: 'report.tap' },
      coverage: 'none',
    },
  ],
});

const code = [
  'export const add = (a, b) => a + b;',
  'export const clamp = (n) => (n > 10 ? 10 : n);',
  '',
].join('\n');

const diff = [
  'diff --git a/src/add.mjs b/src/add.mjs',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/add.mjs',
  '@@ -0,0 +1,2 @@',
  '+export const add = (a, b) => a + b;',
  '+export const clamp = (n) => (n > 10 ? 10 : n);',
  '',
].join('\n');

// Three mutants: one the tests catch, one on a branch no test reaches, one that adds a name.
const mutants: MutantEdit[] = [
  {
    file: 'src/add.mjs',
    line: 1,
    original: 'export const add = (a, b) => a + b;',
    replacement: 'export const add = (a, b) => a - b;',
    description: 'add subtracts',
  },
  {
    file: 'src/add.mjs',
    line: 2,
    original: 'export const clamp = (n) => (n > 10 ? 10 : n);',
    replacement: 'export const clamp = (n) => (n >= 10 ? 10 : n);',
    description: 'clamp at ten',
  },
  {
    file: 'src/add.mjs',
    line: 1,
    original: 'export const add = (a, b) => a + b;',
    replacement: 'export const add = (a, b) => a + b + c;',
    description: 'add a third',
  },
];

describe('runServe: a Brett step (ADR 0313)', () => {
  let dir: TempDir;
  let store: EventStore;

  beforeEach(() => {
    dir = makeTempDir('serve-mutants');
    const inner = openSqliteEventStore(':memory:');
    store = { ...inner, close: () => {} };
  });
  afterEach(() => dir.remove());

  /**
   * Batch 12-1 brewed by runServe with `recipe` until it is on tap, Brett proposing
   * `proposed(attempt)`: its events, its folded batch, and how many scratch trees ran.
   */
  const brew = async (recipe: string, proposed: (attempt: number) => MutantEdit[]) => {
    const files = serveInputs().files;
    const result = serveSetup(
      serveInputs({
        files: {
          ...files,
          config: config({}, { testMap: 'brewery' }),
          local: local({ workRoot: dir.path }),
          brewery: {
            ...readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')),
            recipes: [{ path: 'recipes/tasting.jsonc', text: recipe }],
            brewers: [{ path: 'brewers/cellarman.md', text: brewer }],
          },
          testMaps: [{ path: 'test-maps/acme/web.jsonc', text: map }],
        },
      }),
    );
    assert.ok(result.kind === 'ready', JSON.stringify(result));
    const { setup } = result;
    const log = createCommandLog({ store, recipes: setup.recipes });
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log.issue(
      { kind: 'route', batchId: '12-1', recipe: 'tasting', reason: 'label', source: 'label' },
      t0,
    );
    const api = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: [], author: 'ann', title: 'Add clamp', body: 'Add clamp.' },
        ],
      },
    });
    const controller = new AbortController();
    let ticks = 0;
    // The cellarman brews; Brett proposes its attempt's mutants.
    const runner: BrewerRunner = {
      start: ({ ref }) => ({
        ended: Promise.resolve({
          ending: {
            kind: 'succeeded',
            output:
              ref.stepId === 'brett'
                ? { status: 'done', summary: 'Mutants', mutants: proposed(ref.attempt) }
                : { status: 'done', summary: 'Brewed', assumptions: [] },
          },
        }),
        stop: () => {},
      }),
      progress: () => undefined,
    };
    // Each scratch tree a folder of the test's, with the commit's file and the mutant's edit.
    let trees = 0;
    const commitTree: CommitTree = async (commit, use, options = {}) => {
      assert.equal(commit, FAKE_COMMIT);
      trees += 1;
      const path = join(dir.path, 'scratch', String(trees));
      const file = join(path, 'src', 'add.mjs');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, code);
      if (options.edit !== undefined) {
        writeFileSync(join(path, ...options.edit.file.split('/')), options.edit.rewrite(code));
      }
      return use(path);
    };
    // The test command: two tests of add and one of clamp below ten, written as TAP.
    const exec: ExecProcess = async (file, _args, options) => {
      assert.equal(file, 'npm test');
      const source = readFileSync(join(options.cwd, 'src', 'add.mjs'), 'utf8');
      const adds = source.includes('a + b;');
      const points = [
        `${adds ? 'ok' : 'not ok'} 1 - adds two numbers`,
        `${adds ? 'ok' : 'not ok'} 2 - adds negatives`,
        'ok 3 - clamps small numbers',
      ];
      writeFileSync(
        join(options.cwd, 'report.tap'),
        `TAP version 13\n${points.join('\n')}\n1..3\n`,
      );
      const exitCode = adds ? 0 : 1;
      return { exitCode, stdout: '', stderr: '', output: '' };
    };
    const git: Git = async (_cwd, args) => {
      if (args.includes('diff')) return { code: 0, stdout: diff, stderr: '' };
      if (args.includes('cat-file') && args.includes(`${FAKE_COMMIT}:src/add.mjs`)) {
        return { code: 0, stdout: code, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const shell: ServeShell = {
      out: () => {},
      signal: controller.signal,
      clock: () => t0,
      wait: async () => {
        ticks += 1;
        const lane = createCommandLog({ store, recipes: setup.recipes }).state().batches.get('12-1')
          ?.lane.kind;
        if (lane === 'on_tap' || ticks > 30) controller.abort();
      },
      lock: () => fakeLock('cellar'),
      openStore: () => store,
      stateBranch: () => ({
        start: async () => ({ decision: 'ready' }),
        flush: async () => ({ kind: 'unchanged' }),
      }),
      worktrees: async () => fakeWorktrees({ root: join(dir.path, 'acme.web', 'attempts') }),
      merge: () => fakeWorktreeMerge(),
      push: () => ({
        commit: async () => FAKE_COMMIT,
        baseTip: async () => 'b'.repeat(40),
        isAncestor: async (commit, of) => commit === of,
        remoteTip: async () => undefined,
        push: async () => {},
        secretScan: async () => [],
        touchedFiles: async () => [],
      }),
      commitTree: () => commitTree,
      runner: () => runner,
      exec,
      setup: () => Promise.reject(new Error('no repository setup runs here')),
      gh: ghOver(api.fetch).exec,
      git,
    };
    assert.equal(await runServe(setup, shell), 0);
    const events = store.eventsAfter(0);
    const batch = createCommandLog({ store, recipes: setup.recipes }).state().batches.get('12-1');
    assert.ok(batch !== undefined);
    return { events, batch, trees };
  };

  it("a Brett attempt's step.finished records its mutants' verdicts and replay prints them", async () => {
    const { events, batch, trees } = await brew(tasting, () => mutants);
    const finished = events.flatMap(({ event }) =>
      event.type === 'step.finished' && event.stepId === 'brett' ? [event] : [],
    );
    assert.equal(finished.length, 1);
    assert.deepStrictEqual(finished[0]?.mutants, [
      {
        file: 'src/add.mjs',
        line: 1,
        description: 'add subtracts',
        verdict: { kind: 'killed', by: 'adds two numbers' },
      },
      {
        file: 'src/add.mjs',
        line: 2,
        description: 'clamp at ten',
        original: 'export const clamp = (n) => (n > 10 ? 10 : n);',
        replacement: 'export const clamp = (n) => (n >= 10 ? 10 : n);',
        verdict: { kind: 'survived' },
      },
      {
        file: 'src/add.mjs',
        line: 1,
        description: 'add a third',
        verdict: { kind: 'invalid', reason: 'the replacement adds c' },
      },
    ]);
    // The baseline and the two valid mutants each ran in a tree of their own.
    assert.equal(trees, 3);
    const replay = formatReplay(
      batch,
      events.filter(({ event }) => 'batchId' in event && event.batchId === '12-1'),
    );
    assert.match(replay, /brett\s+#1 finished: succeeded/);
    assert.match(replay, /mutants\s+src\/add\.mjs:1 add subtracts: killed by adds two numbers/);
    assert.match(replay, /src\/add\.mjs:2 clamp at ten: survived/);
    assert.match(replay, /src\/add\.mjs:1 add a third: invalid, the replacement adds c/);
  });

  it('a blocking Brett step sends its survivors to the fix step', async () => {
    // Brett blocks, and its findings go back to brew once; its second round proposes none.
    const blocking = JSON.stringify({
      name: 'tasting',
      type: 'brew',
      description: 'Brews an order, then has a blocking Brett mutate its change.',
      steps: [
        { id: 'brew', brewer: 'cellarman' },
        {
          id: 'brett',
          brewer: 'brett',
          blocking: true,
          onBlocked: { findings: { goto: 'brew', maxRounds: 1 } },
        },
        { action: 'openPullRequest' },
      ],
      testFirst: false,
    });
    const { events, batch } = await brew(blocking, (attempt) => (attempt === 1 ? mutants : []));
    const brett = events.flatMap(({ event }) =>
      event.type === 'step.finished' && event.stepId === 'brett' ? [event] : [],
    );
    assert.equal(brett.length, 2);
    const [first, second] = brett;
    assert.equal(first?.outcome.kind, 'failed');
    assert.match(
      first?.outcome.kind === 'failed' ? first.outcome.reason : '',
      /^blocked \(findings\): the tests let a mutant survive: src\/add\.mjs:2: - export const clamp = \(n\) => \(n > 10 \? 10 : n\); \/ \+ export const clamp = \(n\) => \(n >= 10 \? 10 : n\);: clamp at ten$/,
    );
    assert.deepStrictEqual(first?.findings, {
      kept: [
        {
          file: 'src/add.mjs',
          line: 2,
          severity: 'major',
          why: 'the tests let a mutant survive: - export const clamp = (n) => (n > 10 ? 10 : n); / + export const clamp = (n) => (n >= 10 ? 10 : n);: clamp at ten',
          introduced: true,
        },
      ],
      more: 0,
    });
    // Brew's second attempt was sent back by Brett's findings, and the batch went on tap after it.
    assert.deepStrictEqual(batch.steps.get('brew')?.attempts.get(2)?.route, {
      from: 'brett',
      why: 'findings',
    });
    assert.equal(second?.outcome.kind, 'succeeded');
    assert.equal(batch.lane.kind, 'on_tap');
  });
});
