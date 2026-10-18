// The testsUnchanged guard and the red proof read a step's commits in the clone the attempt
// worktrees were added to, never by discovery in an attempt's worktree (#210): with real git, a
// worktree whose .git file points at another repository, one whose branches say the proven step
// committed no tests and the guarded attempt changed nothing, changes neither verdict.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createCheckRunner } from '../../src/checks/check-runner.ts';
import { guardTests } from '../../src/checks/tests-guard.ts';
import { brewerBaseEnv } from '../../src/engine/brewer-env.ts';
import { fold } from '../../src/engine/fold.ts';
import type { StepChecks } from '../../src/engine/recipe-files.ts';
import { execProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import type { Event } from '../../src/schemas/events.ts';
import { runGit } from '../../src/workspace/git.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const commit = (path: string, files: Record<string, string>, message: string): string => {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text);
  git(path, ['add', ...Object.keys(files)]);
  git(path, ['commit', '-q', '-m', message]);
  return git(path, ['rev-parse', 'HEAD']).trim();
};

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

const clock = () => new Date('2026-10-18T12:00:00.000Z');
const deadlineAt = '2026-10-18T12:30:00.000Z';
const branchOf = (stepId: string) => `foedrum/12-1/${stepId}/1`;

describe("the guard and the red proof read git in the clone, not the attempt's worktree (#210)", () => {
  let dir: TempDir;
  let user: string;
  let start: string;
  let gaugeTip: string;
  let gauged: Event[];

  /** An attempt worktree of step `stepId` at `from`, added to the user's clone. */
  const addWorktree = (stepId: string, from: string): string => {
    const path = join(dir.path, stepId);
    git(user, ['worktree', 'add', '-q', '-b', branchOf(stepId), path, from]);
    return path;
  };
  const started = (stepId: string, path: string, commit: string): Event[] => [
    { type: 'step.scheduled', batchId: '12-1', stepId, attempt: 1, deadlineAt },
    {
      type: 'step.started',
      batchId: '12-1',
      stepId,
      attempt: 1,
      worktree: { repo: 'acme/app', path, branch: branchOf(stepId), commit },
    },
  ];

  /**
   * Points the worktree at `path` at a repository of its own, whose gauge branch is where the
   * gauge step started and whose implement branch is where that attempt started: the proven
   * step committed nothing and the attempt changed nothing.
   */
  const pointAtDecoy = (path: string): void => {
    const decoy = join(dir.path, 'decoy');
    git(dir.path, ['init', '-q', decoy]);
    git(decoy, ['fetch', '-q', user, '+refs/heads/*:refs/heads/*']);
    git(decoy, ['update-ref', `refs/heads/${branchOf('gauge')}`, start]);
    git(decoy, ['update-ref', `refs/heads/${branchOf('implement')}`, gaugeTip]);
    // git on Windows hides the .git file, which then cannot be opened for writing: replaced.
    rmSync(join(path, '.git'));
    writeFileSync(join(path, '.git'), `gitdir: ${join(decoy, '.git')}\n`);
    // Read in the worktree, its proven step's commits are none: the decoy is in effect.
    assert.equal(git(path, ['diff', start, `refs/heads/${branchOf('gauge')}`]), '');
  };

  beforeEach(() => {
    dir = makeTempDir('step-commits-in-clone');
    user = join(dir.path, 'user');
    git(dir.path, ['init', '-q', '-b', 'main', user]);
    start = commit(user, { 'readme.txt': 'hello\n' }, 'Initial commit');
    const gauge = addWorktree('gauge', start);
    gaugeTip = commit(gauge, { 'add.test.mjs': test, 'add.mjs': stub }, 'Red: test adds');
    gauged = [
      { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
      { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'nip', reason: 'l', source: 'label' },
      ...started('gauge', gauge, start),
      {
        type: 'step.finished',
        batchId: '12-1',
        stepId: 'gauge',
        attempt: 1,
        outcome: { kind: 'succeeded', output: null },
      },
    ];
  });
  afterEach(async () => {
    await removeTree(dir.path);
  });

  it('the guard still stops an attempt that weakened an assertion', async () => {
    const implement = addWorktree('implement', gaugeTip);
    const weakened = test.replace('assert.equal(add(1, 2), 3);', 'assert.ok(true);');
    commit(implement, { 'add.test.mjs': weakened }, 'Weaken the test');
    pointAtDecoy(implement);
    const events = [...gauged, ...started('implement', implement, gaugeTip)];
    const guarded = guardTests({
      runner: fakeBrewerRunner({ implement: [behave.succeed()] }),
      state: () => fold(events),
      protects: () => 'gauge',
      git: runGit,
      clone: () => user,
      clock,
    });
    const ref = { batchId: '12-1', stepId: 'implement', attempt: 1 };
    const end = await guarded.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: true,
      reason:
        'the guard testsUnchanged: the attempt changed or removed a line of the tests of step gauge, add.test.mjs: assert.equal(add(1, 2), 3);',
    });
  });

  it("the red proof still finds the proven step's tests", async () => {
    const red = addWorktree('red', gaugeTip);
    pointAtDecoy(red);
    const events = [...gauged, ...started('red', red, gaugeTip)];
    const checks: StepChecks = {
      find: (recipe, stepId) => (recipe === 'nip' && stepId === 'red' ? ['test'] : undefined),
      any: () => true,
      proves: (recipe, stepId) => (recipe === 'nip' && stepId === 'red' ? 'gauge' : undefined),
      redProof: (recipe) => (recipe === 'nip' ? { id: 'red', of: 'gauge' } : undefined),
    };
    const runner = createCheckRunner({
      state: () => fold(events),
      checks,
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
      clone: () => user,
      env: { base: brewerBaseEnv(process.env, process.platform), forced: {} },
      clock,
    });
    const ref = { batchId: '12-1', stepId: 'red', attempt: 1 };
    const end = await runner.start({ ref, limits: defaultLimits }).ended;
    assert.deepEqual(end.ending, { kind: 'succeeded', output: null });
  });
});
