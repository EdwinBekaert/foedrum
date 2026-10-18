// A test-first recipe end to end through openDriver (ADR 0017, ADR 0078), with real git, real
// worktrees and a real test run (`node --test`, TAP on stdout), and the fake brewer runner in
// place of claude: the Gauger's first commit does not compile and its red proof sends it back,
// Cellarman's first attempt weakens an assertion and the guard stops it, and the bottle's branch
// ends with the red commit followed by the green one.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createCheckRunner } from '../../src/checks/check-runner.ts';
import { guardTests } from '../../src/checks/tests-guard.ts';
import { brewerBaseEnv } from '../../src/engine/brewer-env.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { type Driver, openDriver } from '../../src/engine/driver.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { stepRunner } from '../../src/engine/step-runner.ts';
import { execProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { openAttemptWorktrees } from '../../src/workspace/attempt-worktrees-git.ts';
import { runGit } from '../../src/workspace/git.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const commit = (path: string, files: Record<string, string>, message: string): void => {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text);
  git(path, ['add', ...Object.keys(files)]);
  git(path, ['commit', '-q', '-m', message]);
};

// What the brewers commit.
const test = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from './add.mjs';",
  "test('adds two numbers', () => {",
  '  assert.equal(add(1, 2), 3);',
  '});',
  '',
].join('\n');
const stub = "export function add() {\n  throw new Error('not implemented');\n}\n";
const implementation = 'export function add(a, b) {\n  return a + b;\n}\n';

const writer = (name: string, fields: Record<string, unknown> = {}) => ({
  path: `brewers/${name}.md`,
  text: brewerText(name, {
    access: 'write',
    tree: 'task',
    git: { commit: true },
    produces: 'commits',
    ...fields,
  }),
});

describe('a test-first recipe with real git and a real test run', () => {
  let dir: TempDir;
  let user: string;
  let store: EventStore;

  beforeEach(() => {
    dir = makeTempDir('test-first');
    const seed = join(dir.path, 'seed');
    git(dir.path, ['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, 'readme.txt'), 'hello\n');
    git(seed, ['add', 'readme.txt']);
    git(seed, ['commit', '-q', '-m', 'Initial commit']);
    const origin = join(dir.path, 'origin.git');
    user = join(dir.path, 'user');
    git(dir.path, ['clone', '-q', '--bare', '--no-hardlinks', seed, origin]);
    git(dir.path, ['clone', '-q', origin, user]);
    store = openSqliteEventStore(':memory:');
  });
  afterEach(async () => {
    store.close();
    await removeTree(dir.path);
  });

  it('proves the tests red, guards them, and ends with a red commit followed by a green commit', async () => {
    const clock = () => new Date('2026-10-18T12:00:00.000Z');
    let driver: Driver | undefined;
    const state = () => {
      assert.ok(driver !== undefined);
      return driver.state();
    };
    const worktreeOf = (ref: { batchId: string; stepId: string; attempt: number }) => {
      const started = state()
        .batches.get(ref.batchId)
        ?.steps.get(ref.stepId)
        ?.attempts.get(ref.attempt);
      assert.ok(started?.phase === 'started' && started.worktree !== undefined);
      return started.worktree.path;
    };
    const brewer = fakeBrewerRunner(({ ref }) => {
      const path = worktreeOf(ref);
      if (ref.stepId === 'gauge' && ref.attempt === 1) {
        // The test imports a function the stub file does not export: a load error.
        commit(
          path,
          { 'add.test.mjs': test, 'add.mjs': 'export const other = 1;\n' },
          'Red: test adds two numbers',
        );
      } else if (ref.stepId === 'gauge') {
        commit(path, { 'add.mjs': stub }, 'Red: a stub that throws');
      } else if (ref.attempt === 1) {
        commit(
          path,
          { 'add.test.mjs': test.replace('assert.equal(add(1, 2), 3);', 'assert.ok(true);') },
          'Weaken the test',
        );
      } else {
        commit(path, { 'add.mjs': implementation }, 'Green: add two numbers');
      }
      return behave.succeed();
    });
    const loaded = loadRecipes({
      recipes: [
        {
          path: 'recipes/nip.jsonc',
          text: recipeText('nip', [
            { id: 'gauge', brewer: 'gauger', when: 'recipe.testFirst' },
            {
              id: 'red',
              check: 'test',
              expect: 'fail',
              of: 'gauge',
              when: 'recipe.testFirst',
              onFail: { goto: 'gauge', maxRounds: 1 },
            },
            { id: 'implement', brewer: 'cellarman' },
            { id: 'green', check: 'test', onFail: { goto: 'implement', maxRounds: 1 } },
          ]),
        },
      ],
      brewers: [
        writer('gauger'),
        writer('cellarman', { guards: ['requiresOutDoc', 'testsUnchanged'] }),
      ],
    });
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
    const checks = createCheckRunner({
      state,
      checks: loaded.checks,
      repositoryChecks: () => ({
        build: null,
        typecheck: null,
        lint: null,
        format: null,
        test: 'node --test --test-reporter=tap',
      }),
      testReport: () => ({ format: 'tap' }),
      exec: execProcess,
      git: runGit,
      env: { base: brewerBaseEnv(process.env, process.platform), forced: {} },
      clock,
    });
    const guarded = guardTests({
      runner: brewer,
      state,
      protects: ({ batchId, stepId }) => {
        const recipe = state().batches.get(batchId)?.recipe?.name ?? '';
        const guards = loaded.brewers.find(recipe, stepId)?.brewer.guards ?? [];
        return guards.includes('testsUnchanged') ? loaded.checks.redProof(recipe)?.of : undefined;
      },
      git: runGit,
    });
    const workRoot = join(dir.path, 'work');
    driver = await openDriver({
      store,
      runner: stepRunner({
        brewer: guarded,
        check: checks,
        isCheck: ({ stepId }) => loaded.checks.find('nip', stepId) !== undefined,
      }),
      recipes: loaded.recipes,
      clock,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      worktrees: [
        {
          repo: 'acme/app',
          base: 'origin/main',
          manager: openAttemptWorktrees({ git: runGit, workRoot, repo: 'acme/app', clone: user }),
        },
      ],
    });
    try {
      const intake = createCommandLog({ store, recipes: loaded.recipes });
      intake.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, clock());
      const route = { kind: 'route', batchId: '12-1', recipe: 'nip', reason: 'label' } as const;
      intake.issue({ ...route, source: 'label' }, clock());
      // Checks are real processes: drive() returns while they run, and finishes them once ended.
      const until = Date.now() + 120_000;
      while (state().batches.get('12-1')?.lane.kind === 'brewing' && Date.now() < until) {
        await driver.drive();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(state().batches.get('12-1')?.lane.kind, 'on_tap');
    } finally {
      driver.close();
    }

    const events = store.eventsAfter(0).map(({ event }) => event);
    const ends = events.flatMap((event) =>
      event.type === 'step.finished'
        ? [
            [
              `${event.stepId}#${event.attempt}`,
              event.outcome.kind === 'failed' ? event.outcome.reason : event.outcome.kind,
            ],
          ]
        : [],
    );
    assert.deepEqual(
      ends.map(([attempt]) => attempt),
      ['gauge#1', 'red#1', 'gauge#2', 'red#2', 'implement#1', 'implement#2', 'green#1'],
    );
    assert.match(
      String(ends[1]?.[1]),
      /^the red proof of step gauge failed: the run has a load, compile, import or collection error: SyntaxError/,
    );
    assert.equal(ends[3]?.[1], 'succeeded');
    assert.equal(
      ends[4]?.[1],
      'the guard testsUnchanged: the attempt changed or removed a line of the tests of step gauge, add.test.mjs: assert.equal(add(1, 2), 3);',
    );
    assert.equal(ends[6]?.[1], 'succeeded');

    // The green check ran on the bottle's branch: the red commits, then the green one.
    const greenStart = events.flatMap((event) =>
      event.type === 'step.started' && event.stepId === 'green' && event.worktree
        ? [event.worktree.commit]
        : [],
    );
    assert.equal(greenStart.length, 1);
    assert.deepEqual(
      git(user, ['log', '--format=%s', greenStart[0] ?? ''])
        .trim()
        .split('\n'),
      [
        'Green: add two numbers',
        'Red: a stub that throws',
        'Red: test adds two numbers',
        'Initial commit',
      ],
    );
  });
});
