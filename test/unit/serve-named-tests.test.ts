// A test the Gauger names that the test run never reports, through `foedrum serve` on the fake host
// (ADR 0342): a recipe's Gauger, red proof, Cellarman and green check, a fake test command that writes
// a TAP report, and a fake GitHub; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runServe, type ServeShell } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import type { Git } from '../../src/workspace/git.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { FAKE_COMMIT, fakeWorktreeMerge, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { brewer, config, local, serveInputs } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const t0 = new Date('2026-11-06T12:00:00.000Z');

const recipe = JSON.stringify({
  name: 'gauged',
  description: 'Proves its tests red, brews, and reads its tests again.',
  steps: [
    { id: 'gauge', brewer: 'gauger' },
    {
      id: 'red',
      check: 'test',
      expect: 'fail',
      of: 'gauge',
      onFail: { goto: 'gauge', maxRounds: 1 },
    },
    { id: 'brew', brewer: 'cellarman' },
    { id: 'green', check: 'test', onFail: { goto: 'brew', maxRounds: 1 } },
    { action: 'openPullRequest' },
  ],
});

// test/integration is a test area of the map, and `npm test` does not run it.
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

const diff = [
  'diff --git a/test/unit/add.test.mjs b/test/unit/add.test.mjs',
  '--- /dev/null',
  '+++ b/test/unit/add.test.mjs',
  '@@ -0,0 +1 @@',
  "+test('adds two numbers', () => {});",
  'diff --git a/test/integration/add.test.mjs b/test/integration/add.test.mjs',
  '--- /dev/null',
  '+++ b/test/integration/add.test.mjs',
  '@@ -0,0 +1 @@',
  "+test('adds through the real tool', () => {});",
  '',
].join('\n');

describe('runServe: the tests a Gauger named (ADR 0342)', () => {
  let dir: TempDir;
  let store: EventStore;

  beforeEach(() => {
    dir = makeTempDir('serve-named-tests');
    const inner = openSqliteEventStore(':memory:');
    store = { ...inner, close: () => {} };
  });
  afterEach(() => dir.remove());

  /** Batch 12-1 brewed by runServe until it is on tap: its events, its batch and its comments. */
  const brew = async () => {
    const files = serveInputs().files;
    const result = serveSetup(
      serveInputs({
        files: {
          ...files,
          config: config({}, { testMap: 'brewery' }),
          local: local({ workRoot: dir.path }),
          brewery: {
            ...readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')),
            recipes: [{ path: 'recipes/gauged.jsonc', text: recipe }],
            brewers: [
              { path: 'brewers/cellarman.md', text: brewer },
              {
                path: 'brewers/gauger.md',
                text: brewer.replace('"name": "cellarman"', '"name": "gauger"'),
              },
            ],
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
      { kind: 'route', batchId: '12-1', recipe: 'gauged', reason: 'label', source: 'label' },
      t0,
    );
    const api = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: [], author: 'ann', title: 'Add add', body: 'Add add.' },
        ],
      },
    });
    const controller = new AbortController();
    let ticks = 0;
    let ended = false;
    const runner: BrewerRunner = {
      start: ({ ref }) => ({
        ended: Promise.resolve({
          ending: {
            kind: 'succeeded',
            output:
              ref.stepId === 'gauge'
                ? {
                    status: 'done',
                    summary: 'Gauged',
                    assumptions: [],
                    tests: ['adds two numbers', 'adds through the real tool'],
                  }
                : { status: 'done', summary: 'Brewed', assumptions: [] },
          },
        }),
        stop: () => {},
      }),
      progress: () => undefined,
    };
    // `npm test` runs test/unit only: it reports the one test, failing until the Cellarman brewed.
    const ran: string[] = [];
    const exec: ExecProcess = async (_file, _args, options) => {
      mkdirSync(options.cwd, { recursive: true });
      const red = ran.length === 0;
      ran.push(options.cwd);
      const point = red
        ? "not ok 1 - adds two numbers\n  ---\n  error: 'not implemented'\n  ..."
        : 'ok 1 - adds two numbers';
      writeFileSync(join(options.cwd, 'report.tap'), `TAP version 13\n${point}\n1..1\n`);
      return { exitCode: red ? 1 : 0, stdout: '', stderr: '', output: '' };
    };
    const git: Git = async (_cwd, args) => {
      if (args[0] === 'ls-files') return { code: 0, stdout: 'package.json\0', stderr: '' };
      if (args.includes('diff')) return { code: 0, stdout: diff, stderr: '' };
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
        // One tick past the end, whose status revision is due at once: the clock stands still, so a
        // revision of a batch still brewing waits a minute (ADR 0072).
        if (ended || ticks > 30) controller.abort();
        ended = lane === 'on_tap' || lane === 'stuck';
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
      runner: () => runner,
      exec,
      setup: () => Promise.reject(new Error('no repository setup runs here')),
      gh: ghOver(api.fetch).exec,
      git,
    };
    assert.equal(await runServe(setup, shell), 0);
    const finished = (stepId: string) =>
      store
        .eventsAfter(0)
        .flatMap(({ event }) =>
          event.type === 'step.finished' && event.stepId === stepId ? [event] : [],
        );
    const batch = createCommandLog({ store, recipes: setup.recipes }).state().batches.get('12-1');
    const comments = [...api.comments.values()].flat().map(({ body }) => body);
    return { batch, finished, comments, ran };
  };

  it('a test the Gauger names that the test run never reported is not proven red', async () => {
    const { batch, finished, comments, ran } = await brew();
    // Nothing fails: the batch went on through the red proof and the green check, each a run.
    assert.equal(ran.length, 2);
    assert.equal(batch?.lane.kind, 'on_tap', JSON.stringify(batch?.lane));
    const [red] = finished('red');
    assert.equal(red?.outcome.kind, 'succeeded');
    assert.deepEqual(red?.unreported, { tests: ['adds through the real tool'], more: 0 });
    const [green] = finished('green');
    assert.equal(green?.outcome.kind, 'succeeded');
    assert.deepEqual(green?.unreported, { tests: ['adds through the real tool'], more: 0 });
    // And it says so where a person reads it.
    assert.ok(
      comments.some((body) =>
        body.includes('Not proven: the test run reports no test named: adds through the real tool'),
      ),
      comments.join('\n---\n'),
    );
  });
});
