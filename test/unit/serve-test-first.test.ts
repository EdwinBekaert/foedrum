// Test-first recipes through `foedrum serve` (ADR 0078): the Gauger's tests, the red proof that
// reads them, and the guards on the brewer after it. An in-memory store, fake worktrees, a fake
// GitHub and a fake test command; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runServe } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { type BrewerRunner, settleAttempt } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import type { Git } from '../../src/workspace/git.ts';
import { testGuidance } from '../helpers/brewery-files.ts';
import { FAKE_COMMIT } from '../helpers/fake-worktrees.ts';
import { brewer, clone, config, local, serveInputs } from '../helpers/serve-brewery.ts';
import { serveFixture, t0 } from '../helpers/serve-fixture.ts';

describe('runServe', () => {
  const f = serveFixture();
  const { shell } = f;

  describe('test-first recipes (ADR 0078)', () => {
    // The Gauger commits failing tests, the red proof reads them, the cellarman keeps them.
    const nip = JSON.stringify({
      name: 'nip',
      type: 'brew',
      description: 'Proves the tests red, then brews.',
      guidance: testGuidance,
      steps: [
        { id: 'gauge', brewer: 'gauger' },
        { id: 'red', check: 'test', expect: 'fail', of: 'gauge' },
        { id: 'implement', brewer: 'cellarman' },
        { action: 'openPullRequest' },
      ],
    });
    const guarded = brewer.replace(
      '"maxAttempts": 1',
      '"maxAttempts": 1,\n  "guards": ["testsUnchanged"]',
    );
    const gauger = brewer.replace('"name": "cellarman"', '"name": "gauger"');
    // A survey ahead of the Gauger, whose check reads its map against one run (ADR 0298).
    const surveying = JSON.stringify({
      name: 'nip',
      type: 'brew',
      description: 'Surveys the test map, proves the tests red, then brews.',
      guidance: testGuidance,
      steps: [
        { id: 'survey', brewer: 'maltster' },
        {
          id: 'survey-check',
          check: 'test',
          of: 'survey',
          onFail: { goto: 'survey', maxRounds: 1 },
        },
        { id: 'gauge', brewer: 'gauger' },
        { id: 'red', check: 'test', expect: 'fail', of: 'gauge' },
        { id: 'implement', brewer: 'cellarman' },
        { action: 'openPullRequest' },
      ],
    });
    const maltster = brewer
      .replace('"name": "cellarman"', '"name": "maltster"')
      .replace('"schema": "outDoc"', '"schema": "survey"')
      .replace('"maxAttempts": 1', '"maxAttempts": 1,\n  "guards": ["testMapOnly"]');
    const testFirstSetup = (
      web: Record<string, unknown>,
      recipeText = nip,
      gaugerText = gauger,
      /** The Brewery's test maps, for a repository whose map it keeps. */
      testMaps: { path: string; text: string }[] = [],
    ) => {
      const files = serveInputs().files;
      const result = serveSetup(
        serveInputs({
          files: {
            ...files,
            config: config({}, web),
            local: local({ workRoot: f.dir.path }),
            brewery: {
              recipes: [{ path: 'recipes/nip.jsonc', text: recipeText }],
              brewers: [
                { path: 'brewers/cellarman.md', text: guarded },
                { path: 'brewers/gauger.md', text: gaugerText },
                { path: 'brewers/maltster.md', text: maltster },
              ],
            },
            ...(testMaps.length === 0 ? {} : { testMaps }),
          },
        }),
      );
      assert.ok(result.kind === 'ready', JSON.stringify(result));
      return result.setup;
    };
    const tap =
      "TAP version 13\nnot ok 1 - adds two numbers\n  ---\n  error: 'not implemented'\n  ...\n1..1\n";
    const gaugeDiff =
      "diff --git a/add.test.mjs b/add.test.mjs\n--- /dev/null\n+++ b/add.test.mjs\n@@ -0,0 +1 @@\n+test('adds two numbers', () => assert.equal(add(1, 2), 3));\n";

    /** Serve brewing batch 14-1 with the nip recipe: what the brewers, the checks and git saw. */
    const brewTestFirst = async (
      testFirst: ServeSetup,
      taps: string[] = [],
      clonedGit?: Git,
      /** The text of the clone's test map at every commit, when it has one. */
      testMap?: string,
      /** Where in its worktree the test run also writes its TAP, as a test map names it. */
      reportAt?: string,
      /** The brewers' runner; default one whose every attempt succeeds. */
      brewing?: BrewerRunner,
    ) => {
      const log = createCommandLog({ store: f.store, recipes: testFirst.recipes });
      log.issue({ kind: 'order', batchId: '14-1', order: { issue: 14 } }, t0);
      const route = { kind: 'route', batchId: '14-1', recipe: 'nip', reason: 'label' } as const;
      log.issue({ ...route, source: 'label' }, t0);
      const brewed: string[] = [];
      const succeeding: BrewerRunner = {
        start: ({ ref }) => {
          // Batch 12-1 of beforeEach brews too.
          if (ref.batchId === '14-1') brewed.push(ref.stepId);
          const output = { status: 'done', summary: 'Brewed' };
          return {
            ended: Promise.resolve({ ending: { kind: 'succeeded', output } }),
            stop: () => {},
          };
        },
        progress: () => undefined,
      };
      const checks: string[] = [];
      const exec: ExecProcess = async (file, _args, options) => {
        checks.push(file);
        const stdout = taps.shift() ?? tap;
        if (reportAt !== undefined && options.cwd !== undefined) {
          mkdirSync(options.cwd, { recursive: true });
          writeFileSync(join(options.cwd, reportAt), stdout);
        }
        return { exitCode: 1, stdout, stderr: '', output: stdout };
      };
      const diffs: string[] = [];
      const folders: string[] = [];
      const code = await runServe(
        testFirst,
        shell({
          runner: () => brewing ?? succeeding,
          exec,
          git: async (cwd, args) => {
            if (clonedGit !== undefined) return clonedGit(cwd, args);
            // The clone has no test map unless the test gives one, and nothing deleted (ADR 0274).
            if (args[0] === 'ls-tree') {
              const entry = `100644 blob ${'e'.repeat(40)}\t.foedrum/test-map.jsonc\u0000`;
              return { code: 0, stdout: testMap === undefined ? '' : entry, stderr: '' };
            }
            if (args[0] === 'cat-file' && testMap !== undefined) {
              return { code: 0, stdout: testMap, stderr: '' };
            }
            // The worktree's manifests, as the map records them: the map is fresh (ADR 0282).
            if (args[0] === 'ls-files' && testMap !== undefined) {
              const { paths } = (JSON.parse(testMap) as { derivedFrom: { paths: string[] } })
                .derivedFrom;
              return { code: 0, stdout: paths.map((path) => `${path}\u0000`).join(''), stderr: '' };
            }
            if (args.includes('--diff-filter=D')) return { code: 0, stdout: '', stderr: '' };
            folders.push(cwd);
            // The two revisions before the `--` that ends the options.
            const end = args.indexOf('--');
            const range = args.slice(end - 2, end).join(' ');
            diffs.push(range);
            const own = range.endsWith('/implement/1');
            return { code: 0, stdout: own ? '' : gaugeDiff, stderr: '' };
          },
          wait: async () => {
            f.calls.push('wait');
            const lane = log.state().batches.get('14-1')?.lane.kind;
            if (lane === 'on_tap' || lane === 'stuck' || f.calls.length > 40) f.controller.abort();
          },
        }),
      );
      assert.equal(code, 0);
      return { brewed, checks, diffs, folders, batch: log.state().batches.get('14-1') };
    };

    it('a test-first recipe without a survey, in a repository with no map, is Stuck naming .foedrum/test-map.jsonc', async () => {
      // A test report in foedrum.jsonc no longer lets the red proof read the tests by name.
      const { brewed, checks, batch } = await brewTestFirst(
        testFirstSetup({ testReport: { format: 'tap' } }),
      );
      assert.deepStrictEqual([brewed, checks], [[], []]);
      assert.deepStrictEqual(batch?.lane.kind === 'stuck' && batch.lane.reason, {
        kind: 'blocked',
        stepId: 'gauge',
        blockerKind: 'environment',
        summary:
          'recipe nip proves its tests red, which needs a test map of acme/web: commit .foedrum/test-map.jsonc to acme/web, or add a survey step to the recipe',
      });
    });

    it('a test-first batch whose Brewery keeps no map for the repository is Stuck naming the file', async () => {
      const { brewed, checks, batch } = await brewTestFirst(
        testFirstSetup({ testMap: 'brewery', testReport: { format: 'tap' } }),
      );
      assert.deepStrictEqual([brewed, checks], [[], []]);
      assert.deepStrictEqual(batch?.lane.kind === 'stuck' && batch.lane.reason, {
        kind: 'blocked',
        stepId: 'gauge',
        blockerKind: 'environment',
        summary:
          'recipe nip proves its tests red, which needs a test map of acme/web: the Brewery keeps it and has none, so add test-maps/acme/web.jsonc to the Brewery',
      });
    });

    it('a test-first recipe with a survey and no test map does not stick before its first step', async () => {
      // The repository keeps its test map, and has none: the survey proposes one (ADR 0298).
      const { brewed, batch } = await brewTestFirst(testFirstSetup({}, surveying));
      assert.equal(brewed[0], 'survey');
      const reason = batch?.lane.kind === 'stuck' ? batch.lane.reason : undefined;
      assert.ok(
        !JSON.stringify(reason ?? {}).includes('which needs a test map'),
        JSON.stringify(reason),
      );
    });

    it('still sticks a surveying batch before its first step when the Brewery keeps the test map: regression test', async () => {
      // A survey cannot write the Brewery, so no map would come of it (ADR 0298).
      const { brewed, batch } = await brewTestFirst(
        testFirstSetup({ testMap: 'brewery' }, surveying),
      );
      assert.deepStrictEqual(brewed, []);
      assert.deepStrictEqual(batch?.lane.kind === 'stuck' && batch.lane.reason, {
        kind: 'blocked',
        stepId: 'survey',
        blockerKind: 'environment',
        summary:
          'recipe nip proves its tests red, which needs a test map of acme/web: the Brewery keeps it and has none, so add test-maps/acme/web.jsonc to the Brewery',
      });
    });

    it('still sticks a batch before its first step when its recipe skips the survey but proves red: regression test', async () => {
      const skipping = JSON.stringify({
        ...JSON.parse(surveying),
        testFirst: false,
        steps: (JSON.parse(surveying) as { steps: Record<string, unknown>[] }).steps.map((step) =>
          step.id === 'survey' || step.id === 'survey-check'
            ? { ...step, when: 'recipe.testFirst' }
            : step,
        ),
      });
      const { brewed, batch } = await brewTestFirst(testFirstSetup({}, skipping));
      assert.deepStrictEqual(brewed, []);
      const reason = batch?.lane.kind === 'stuck' ? batch.lane.reason : undefined;
      assert.equal(reason?.kind === 'blocked' && reason.stepId, 'gauge');
      assert.match(
        reason?.kind === 'blocked' ? reason.summary : '',
        /which needs a test map of acme\/web: commit \.foedrum\/test-map\.jsonc to acme\/web/,
      );
    });

    it("fails the Maltster's attempt through serve when its commits change more than the test map: regression test", async () => {
      // The clone has no map, so the Maltster runs; its commits hold a file beside the map.
      const git: Git = async (_cwd, args) => {
        if (args[0] === 'diff' && args.includes('--name-only')) {
          return { code: 0, stdout: '.foedrum/test-map.jsonc\0src/app.ts\0', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      };
      const { brewed, batch } = await brewTestFirst(
        testFirstSetup({ testReport: { format: 'tap' } }, surveying),
        [],
        git,
      );
      assert.deepStrictEqual(brewed, ['survey']);
      assert.deepStrictEqual(batch?.lane.kind === 'stuck' && batch.lane.reason, {
        kind: 'attempts_exhausted',
        stepId: 'survey',
        attempts: 1,
        lastReason:
          'the guard testMapOnly: the attempt changed src/app.ts; it may change .foedrum/test-map.jsonc only',
      });
    });

    it("ends a survey whose base's map is fresh without a session, through serve, and brews on with the Gauger", async () => {
      const testMap = JSON.stringify({
        derivedFrom: { globs: ['package.json'], paths: ['package.json'] },
        modules: [
          {
            name: 'web',
            code: ['src/**'],
            tests: { paths: ['**/*.test.mjs'] },
            testReport: { format: 'tap', path: 'test-results.tap' },
            coverage: 'none',
          },
        ],
      });
      const { brewed, batch } = await brewTestFirst(
        testFirstSetup({ testReport: { format: 'tap' } }, surveying),
        [],
        undefined,
        testMap,
        'test-results.tap',
      );
      // No Maltster ran: the survey ended before its session (ADR 0298).
      assert.equal(brewed[0], 'gauge');
      const survey = batch?.steps.get('survey')?.attempts.get(1);
      assert.equal(
        survey?.phase === 'finished' &&
          survey.outcome.kind === 'succeeded' &&
          (survey.outcome.output as { map?: string }).map,
        'fresh',
      );
      const check = batch?.steps.get('survey-check')?.attempts.get(1);
      assert.equal(check?.phase === 'finished' && check.outcome.kind, 'succeeded');
    });

    // A clone with a test map at every commit, whose one module keeps add.test.mjs, and on each
    // attempt branch the test file as the Gauger committed it; the map is fresh by its manifests
    // (ADR 0274, ADR 0282). It records where it read each diff, and its range.
    const webMap = JSON.stringify({
      derivedFrom: { globs: ['package.json'], paths: ['package.json'] },
      modules: [
        {
          name: 'web',
          code: ['add.mjs'],
          tests: { paths: ['add.test.mjs'] },
          testReport: { format: 'tap', path: 'report.tap' },
          coverage: 'none',
        },
      ],
    });
    const mappedGit =
      (read: { cwd: string; range: string }[]): Git =>
      async (cwd, args) => {
        const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
        const path = args.at(-1) ?? '';
        const [mapBlob, testBlob] = ['a'.repeat(40), 'b'.repeat(40)];
        if (args.includes('ls-tree')) {
          // The Gauger's test file is on the attempt branches, not where it started.
          const at = args[args.indexOf('--') - 1] ?? '';
          if (path === '.foedrum/test-map.jsonc') return ok(`100644 blob ${mapBlob}\t${path}\0`);
          return at.startsWith('refs/heads/') ? ok(`100644 blob ${testBlob}\t${path}\0`) : ok('');
        }
        if (args[0] === 'cat-file') {
          return ok(
            path === mapBlob
              ? webMap
              : "test('adds two numbers', () => assert.equal(add(1, 2), 3));\n",
          );
        }
        if (args[0] === 'ls-files') return ok('package.json\0');
        // The attempt made no merge: its own change is one stretch (ADR 0358).
        if (args[0] === 'rev-list') return ok('');
        if (args.includes('--diff-filter=D') || args.includes('--name-only')) return ok('');
        const end = args.indexOf('--');
        read.push({ cwd, range: args.slice(end - 2, end).join(' ') });
        return ok(gaugeDiff);
      };

    it('a test-first batch whose Brewery keeps a map for the repository brews: regression test', async () => {
      const maps = [{ path: 'test-maps/acme/web.jsonc', text: webMap }];
      const { brewed, batch } = await brewTestFirst(
        testFirstSetup({ testMap: 'brewery' }, nip, gauger, maps),
        [],
        mappedGit([]),
        undefined,
        'report.tap',
      );
      assert.deepStrictEqual([brewed, batch?.lane.kind], [['gauge', 'implement'], 'on_tap']);
    });

    it('lets a map that cannot be read past the start refusal, for the red proof to name: regression test', async () => {
      const clone = mappedGit([]);
      const git: Git = async (cwd, args) =>
        args[0] === 'cat-file' && args.at(-1) === 'a'.repeat(40)
          ? { code: 0, stdout: '{ "modules": ', stderr: '' }
          : clone(cwd, args);
      const { brewed, batch } = await brewTestFirst(
        testFirstSetup({}),
        [],
        git,
        undefined,
        'report.tap',
      );
      assert.equal(brewed[0], 'gauge');
      const reason = batch?.lane.kind === 'stuck' ? batch.lane.reason : undefined;
      assert.match(
        JSON.stringify(reason ?? {}),
        /the test map of acme\/web at [0-9a-f]{40} cannot be read/,
      );
      assert.ok(
        !JSON.stringify(reason ?? {}).includes('which needs a test map'),
        JSON.stringify(reason),
      );
    });

    it("reads the repository's map for the start refusal at the commit the attempt started at: regression test", async () => {
      // The clone has the map only there: read anywhere else, the batch would be Stuck.
      const asked: string[] = [];
      const clone = mappedGit([]);
      const git: Git = async (cwd, args) => {
        if (args[0] === 'ls-tree' && args.at(-1) === '.foedrum/test-map.jsonc') {
          const at = args[args.indexOf('--') - 1] ?? '';
          asked.push(at);
          if (at !== FAKE_COMMIT) return { code: 0, stdout: '', stderr: '' };
        }
        return clone(cwd, args);
      };
      const { brewed } = await brewTestFirst(testFirstSetup({}), [], git, undefined, 'report.tap');
      assert.equal(brewed[0], 'gauge');
      assert.equal(asked[0], FAKE_COMMIT);
    });

    it("a sent-back Gauger's done without a commit is a divergence again", async () => {
      const routed = JSON.stringify({
        name: 'nip',
        type: 'brew',
        description: 'Proves the tests red, once more after a failure, then brews.',
        guidance: testGuidance,
        steps: [
          { id: 'gauge', brewer: 'gauger' },
          {
            id: 'red',
            check: 'test',
            expect: 'fail',
            of: 'gauge',
            onFail: { goto: 'gauge', maxRounds: 1 },
          },
          { id: 'implement', brewer: 'cellarman' },
          { action: 'openPullRequest' },
        ],
      });
      const gauging = gauger.replace(
        '"brew.md", "schema": "outDoc"',
        '"gauge.md", "schema": "gauge"',
      );
      const output = {
        status: 'done',
        summary: 'Named the tests',
        tests: ['adds two numbers'],
        regressionTests: [],
        assumptions: [],
      };
      // The second Gauger only names its tests: settled by the limits the Cellar gives it.
      const naming: BrewerRunner = {
        start: ({ ref, limits }) => {
          const ending =
            ref.stepId === 'gauge' && ref.attempt === 2
              ? settleAttempt(
                  {
                    exit: { kind: 'exited', code: 0 },
                    outDoc: `---\n${JSON.stringify(output)}\n---\nNamed.\n`,
                    denials: 0,
                    deniedTools: [],
                    turns: 1,
                    commits: { kind: 'counted', count: 0 },
                  },
                  limits,
                )
              : ({ kind: 'succeeded', output } as const);
          return { ended: Promise.resolve({ ending }), stop: () => {} };
        },
        progress: () => undefined,
      };
      const passing = 'TAP version 13\nok 1 - adds two numbers\n1..1\n';
      const { batch } = await brewTestFirst(
        testFirstSetup({}, routed, gauging),
        [passing],
        mappedGit([]),
        undefined,
        'report.tap',
        naming,
      );
      const reason = batch?.lane.kind === 'stuck' ? batch.lane.reason : undefined;
      assert.equal(reason?.kind === 'blocked' && reason.stepId, 'gauge');
      assert.equal(reason?.kind === 'blocked' && reason.blockerKind, 'divergence');
      assert.match(
        reason?.kind === 'blocked' ? reason.summary : '',
        /^the out doc says done, but the brewer made no commit since [0-9a-f]{7}: Named the tests$/,
      );
    });

    it("proves the Gauger's tests red from the test map's report and guards them, through serve's git", async () => {
      const read: { cwd: string; range: string }[] = [];
      const { brewed, checks, batch } = await brewTestFirst(
        testFirstSetup({}),
        [],
        mappedGit(read),
        undefined,
        'report.tap',
      );
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.deepStrictEqual([brewed, checks], [['gauge', 'implement'], ['npm test']]);
      // The red proof and the guard read the Gauger's commits, in the local clone the worktrees
      // were added to, never in a worktree (#210).
      const gaugeRange = /^[0-9a-f]{40} refs\/heads\/foedrum\/14-1\/gauge\/1$/;
      assert.deepStrictEqual(
        read.map(({ cwd }) => cwd),
        [clone, clone, clone],
      );
      const [proof, guard, own] = read.map(({ range }) => range);
      for (const range of [proof, guard]) assert.match(range ?? '', gaugeRange);
      // Then the Cellarman's own change, against the test files the base holds (ADR 0358).
      assert.match(own ?? '', /^[0-9a-f]{40} refs\/heads\/foedrum\/14-1\/implement\/1$/);
    });

    it('keeps every line the Gauger added to a test file of the test map, through serve (ADR 0274)', async () => {
      const map = JSON.stringify({
        derivedFrom: { globs: ['package.json'], paths: ['package.json'] },
        modules: [
          {
            name: 'web',
            code: ['add.mjs'],
            tests: { paths: ['add.test.mjs'] },
            testReport: { format: 'tap', path: 'report.tap' },
            coverage: 'none',
          },
        ],
      });
      const importLine = "import { add } from './add.mjs';";
      const test = "test('adds two numbers', () => assert.equal(add(1, 2), 3));";
      const gauged = `diff --git a/add.test.mjs b/add.test.mjs\n--- /dev/null\n+++ b/add.test.mjs\n@@ -0,0 +1,2 @@\n+${importLine}\n+${test}\n`;
      // The cellarman edits only the import line, which ADR 0078's rule lets change.
      const edited = importLine.replace('./add.mjs', './sum.mjs');
      const own = `diff --git a/add.test.mjs b/add.test.mjs\n--- a/add.test.mjs\n+++ b/add.test.mjs\n@@ -1 +1 @@\n-${importLine}\n+${edited}\n`;
      const [mapBlob, testBlob] = ['a'.repeat(40), 'b'.repeat(40)];
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
      const git: Git = async (_cwd, args) => {
        const path = args.at(-1) ?? '';
        if (args.includes('ls-tree')) {
          // The Gauger's test file is on its branch and the cellarman's, not where it started.
          const ref = args[args.indexOf('--') - 1] ?? '';
          if (path !== '.foedrum/test-map.jsonc' && !ref.startsWith('refs/heads/')) return ok('');
          const blob = path === '.foedrum/test-map.jsonc' ? mapBlob : testBlob;
          return ok(`100644 blob ${blob}\t${path}\0`);
        }
        if (args[0] === 'cat-file') return ok(path === mapBlob ? map : `${edited}\n${test}\n`);
        // The worktree's manifests, as the map records them: the map is fresh (ADR 0282).
        if (args[0] === 'ls-files') return ok('package.json\0');
        const end = args.indexOf('--');
        return ok(args[end - 1]?.endsWith('/implement/1') ? own : gauged);
      };
      // The run writes the report the map names, so the red proof proves the Gauger's test red.
      const { batch } = await brewTestFirst(
        testFirstSetup({ testReport: { format: 'tap' } }),
        [],
        git,
        undefined,
        'report.tap',
      );
      assert.deepStrictEqual(batch?.lane.kind === 'stuck' && batch.lane.reason, {
        kind: 'attempts_exhausted',
        stepId: 'implement',
        attempts: 1,
        lastReason: `the guard testsUnchanged: the attempt changed or removed a line of the tests of step gauge, add.test.mjs: ${importLine}`,
      });
    });

    it('lets a batch whose red proof it skips brew in a repository without a test report', async () => {
      const off = JSON.stringify({
        name: 'nip',
        type: 'brew',
        description: 'Proves the tests red only when test-first.',
        guidance: testGuidance,
        steps: [
          { id: 'gauge', brewer: 'gauger', when: 'recipe.testFirst' },
          { id: 'red', check: 'test', expect: 'fail', of: 'gauge', when: 'recipe.testFirst' },
          { id: 'implement', brewer: 'cellarman' },
          { action: 'openPullRequest' },
        ],
        testFirst: false,
      });
      const { brewed, checks, diffs, batch } = await brewTestFirst(testFirstSetup({}, off));
      assert.equal(batch?.lane.kind, 'on_tap');
      // The skipped Gauger committed no tests, so the guard has none to read either.
      assert.deepStrictEqual([brewed, checks, diffs], [['implement'], [], []]);
    });

    it('guards only the brewer with testsUnchanged, not the Gauger a failed red proof sent back', async () => {
      const routed = JSON.stringify({
        name: 'nip',
        type: 'brew',
        description: 'Proves the tests red, once more after a failure, then brews.',
        guidance: testGuidance,
        steps: [
          { id: 'gauge', brewer: 'gauger' },
          {
            id: 'red',
            check: 'test',
            expect: 'fail',
            of: 'gauge',
            onFail: { goto: 'gauge', maxRounds: 1 },
          },
          { id: 'implement', brewer: 'cellarman' },
          { action: 'openPullRequest' },
        ],
      });
      const passing = 'TAP version 13\nok 1 - adds two numbers\n1..1\n';
      const read: { cwd: string; range: string }[] = [];
      const { brewed, batch } = await brewTestFirst(
        testFirstSetup({}, routed),
        [passing],
        mappedGit(read),
        undefined,
        'report.tap',
      );
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.deepStrictEqual(brewed, ['gauge', 'gauge', 'implement']);
      // Two red proofs, then the guard of the cellarman, which reads the Gauger's commits and its
      // own change (ADR 0358): nothing for the Gauger's second attempt.
      const ranges = read.map(({ range }) => range);
      assert.equal(ranges.length, 4, ranges.join('\n'));
      assert.match(ranges[1] ?? '', /refs\/heads\/foedrum\/14-1\/gauge\/2$/);
    });

    it('a failed red proof still takes its onFail route', async () => {
      // regression test: in a repository with a test map, whose module wrote no report (ADR 0274).
      const routed = JSON.stringify({
        name: 'nip',
        type: 'brew',
        description: 'Proves the tests red, once more after a failure, then brews.',
        guidance: testGuidance,
        steps: [
          { id: 'gauge', brewer: 'gauger' },
          {
            id: 'red',
            check: 'test',
            expect: 'fail',
            of: 'gauge',
            onFail: { goto: 'gauge', maxRounds: 1 },
          },
          { id: 'implement', brewer: 'cellarman' },
          { action: 'openPullRequest' },
        ],
      });
      const testMap = JSON.stringify({
        derivedFrom: { globs: ['package.json'], paths: ['package.json'] },
        modules: [
          {
            name: 'web',
            code: ['src/**'],
            tests: { paths: ['**/*.test.mjs'] },
            testReport: { format: 'tap', path: 'test-results.tap' },
            coverage: 'none',
          },
        ],
      });
      const { brewed, batch } = await brewTestFirst(
        testFirstSetup({ testReport: { format: 'tap' } }, routed),
        [],
        undefined,
        testMap,
      );
      assert.deepStrictEqual(brewed, ['gauge', 'gauge']);
      // Sent back once, then out of rounds.
      const reason = batch?.lane.kind === 'stuck' ? batch.lane.reason : undefined;
      assert.equal(reason?.kind, 'attempts_exhausted');
      assert.match(
        reason?.kind === 'attempts_exhausted' ? reason.lastReason : '',
        /^the red proof of step gauge failed: .*module "web" wrote no test report at test-results\.tap$/,
      );
    });
  });
});
