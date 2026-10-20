// `foedrum status`, `replay`, `cancel` and `retry` through the wiring main.ts runs
// (cliFromCheckout), against real store files and recipe files (ADR 0021): what the unit tests
// replace. In process, with gh answered from captured output, so no command here can start the
// real gh. The output itself is in test/unit/cli.test.ts.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cliFromCheckout } from '../../src/cli/cli-main.ts';
import { INVALID_RECIPES } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';
import { config } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { cannedGhLogin, doctorHere, MADE_UP_GH, resolveWithMadeUpGh } from './canned-gh-login.ts';

const foedrumIn = (cwd: string, args: string[]) =>
  cliFromCheckout(args, cwd, { exec: cannedGhLogin(), resolve: resolveWithMadeUpGh });

describe('foedrum doctor and serve through cliFromCheckout', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('cli-runner');
  });
  afterEach(() => removeTree(dir.path));

  // The programs the injected runner was asked to start: gh among them means its login check went
  // through the runner and the PATH lookup the test gave, never the real ones (ADR 0086).
  const started = async (args: string[]): Promise<string[]> => {
    const files: string[] = [];
    const canned = cannedGhLogin();
    const exec: ExecProcess = (file, execArgs, options) => {
      files.push(file);
      return canned(file, execArgs, options);
    };
    await cliFromCheckout(args, dir.path, { exec, resolve: resolveWithMadeUpGh });
    return files;
  };

  it('asks doctor’s gh through the injected runner', async () => {
    assert.ok((await started(['doctor'])).includes(MADE_UP_GH));
  });

  it('asks serve’s gh through the injected runner, before it refuses a folder that is no Brewery', async () => {
    assert.ok((await started(['serve'])).includes(MADE_UP_GH));
  });
});

describe('foedrum status and replay on store files', () => {
  let brewery: TempDir;
  let store: string;
  beforeEach(() => {
    brewery = makeTempDir('cli');
    store = join(brewery.path, '.foedrum', 'index.db');
  });
  afterEach(() => removeTree(brewery.path));

  const foedrum = (...args: string[]) => foedrumIn(brewery.path, args);

  it('says there is no store, and creates none, in a folder without one', async () => {
    for (const args of [['status'], ['replay', '12-1']]) {
      const { exitCode, stdout, stderr } = await foedrum(...args);
      assert.equal(exitCode, 1);
      assert.equal(stdout, '');
      assert.equal(stderr, `foedrum ${args[0]}: no event store at ${store}\n`);
      assert.equal(existsSync(store), false);
    }
  });

  it('refuses a store at an older schema version in one line, and leaves it as it was', async () => {
    mkdirSync(join(brewery.path, '.foedrum'));
    const writer = openSqliteEventStore(store);
    writer.withTransaction((tx) =>
      tx.append({
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        routeBy: '2026-12-31T00:00:00.000Z',
      }),
    );
    writer.close();
    const db = new DatabaseSync(store);
    // What schema version 1 left: no pushed table. An older Cellar may still run on it.
    db.exec('PRAGMA journal_mode = DELETE; DROP TABLE pushed; PRAGMA user_version = 1');
    db.close();
    const { exitCode, stdout, stderr } = await foedrum('status');
    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /^foedrum status: [^\n]*schema version 1[^\n]*\n$/);
    const after = new DatabaseSync(store, { readOnly: true });
    assert.deepEqual(
      {
        ...after.prepare('PRAGMA user_version').get(),
        ...after.prepare('PRAGMA journal_mode').get(),
      },
      { user_version: 1, journal_mode: 'delete' },
    );
    after.close();
  });

  it('changes a store with a command that changes state, recorded as the user from the terminal', async () => {
    mkdirSync(join(brewery.path, '.foedrum'));
    const writer = openSqliteEventStore(store);
    writer.withTransaction((tx) =>
      tx.append({
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        routeBy: '2026-12-31T00:00:00.000Z',
      }),
    );
    writer.close();
    const { exitCode, stdout, stderr } = await foedrum('cancel', '12-1');
    assert.equal(stderr, '');
    assert.equal(exitCode, 0);
    assert.equal(stdout, `12-1 cancelled: by ${userInfo().username} via terminal\n`);
    const reader = openSqliteEventStore(store, { readOnly: true });
    assert.deepEqual(reader.eventsAfter(1)[0]?.event, {
      type: 'batch.cancelled',
      batchId: '12-1',
      by: userInfo().username,
      via: 'terminal',
    });
    reader.close();
  });

  it('creates no store for a command that changes state, in a folder without one', async () => {
    const { exitCode, stderr } = await foedrum('cancel', '12-1');
    assert.equal(exitCode, 1);
    assert.equal(stderr, `foedrum cancel: no event store at ${store}\n`);
    assert.equal(existsSync(store), false);
  });

  it("lists a kept task-tree branch from the repository's clone, through git (ADR 0092)", async () => {
    // The user's clone: the batch started at `start`, and its branch holds two commits past it.
    const clone = join(brewery.path, 'web');
    mkdirSync(clone);
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
        cwd: clone,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'start');
    const start = git('rev-parse', 'HEAD');
    git('switch', '-q', '-c', 'foedrum/11-1/brew/1');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    writeFileSync(join(brewery.path, 'foedrum.jsonc'), config());
    mkdirSync(join(brewery.path, '.foedrum'));
    writeFileSync(
      join(brewery.path, '.foedrum', 'local.jsonc'),
      JSON.stringify({ clones: { 'acme/web': clone } }),
    );
    const writer = openSqliteEventStore(store);
    const step = { batchId: '11-1', stepId: 'brew', attempt: 1 };
    writer.withTransaction((tx) => {
      for (const event of [
        {
          type: 'batch.ordered',
          batchId: '11-1',
          order: { issue: 11 },
          routeBy: '2026-12-31T00:00:00.000Z',
        },
        { type: 'step.scheduled', ...step, deadlineAt: '2026-12-31T00:00:00.000Z' },
        {
          type: 'step.started',
          ...step,
          worktree: {
            repo: 'acme/web',
            path: join(brewery.path, 'attempts', '11-1', 'brew', '1'),
            branch: 'foedrum/11-1/brew/1',
            commit: start,
          },
        },
        { type: 'step.finished', ...step, outcome: { kind: 'succeeded', output: {} } },
        { type: 'batch.cancelled', batchId: '11-1', by: 'ann', via: 'terminal' },
      ] as const) {
        tx.append(event);
      }
    });
    writer.close();

    const { exitCode, stdout, stderr } = await foedrum('status');

    assert.equal(stderr, '');
    assert.equal(exitCode, 0);
    // The whole line, as text: the clone's path may hold regex characters.
    assert.ok(
      stdout
        .split('\n')
        .includes(
          `  11-1  foedrum/11-1/brew/1  2 commits past the start  in ${clone}: git branch -D foedrum/11-1/brew/1`,
        ),
      stdout,
    );
  });

  it('says in one line, and exits 1, when the store is not a database', async () => {
    mkdirSync(join(brewery.path, '.foedrum'));
    writeFileSync(store, 'not a database, but long enough to have a header page\n'.repeat(10));
    const { exitCode, stdout, stderr } = await foedrum('status');
    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /^foedrum status: [^\n]+\n$/);
  });
});

describe("foedrum with the Brewery's recipe files (ADR 0053)", () => {
  let brewery: TempDir;
  let store: string;
  beforeEach(() => {
    brewery = makeTempDir('cli-recipes');
    store = join(brewery.path, '.foedrum', 'index.db');
    mkdirSync(join(brewery.path, '.foedrum'));
    mkdirSync(join(brewery.path, 'brewers'));
    mkdirSync(join(brewery.path, 'recipes'));
    writeFileSync(join(brewery.path, 'brewers', 'maltster.md'), brewerText('maltster'));
    // 12-1 brews pale and got Stuck at its maltster step.
    const writer = openSqliteEventStore(store);
    writer.withTransaction((tx) => {
      tx.append({
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        routeBy: '2026-12-31T00:00:00.000Z',
      });
      tx.append({
        type: 'batch.recipe_chosen',
        batchId: '12-1',
        recipe: 'pale',
        reason: 'label recipe:pale',
        source: 'label',
      });
      tx.append({
        type: 'batch.stuck',
        batchId: '12-1',
        reason: {
          kind: 'attempts_exhausted',
          stepId: 'maltster',
          attempts: 2,
          lastReason: 'tests fail',
        },
        options: ['retry', 'cancel'],
        remindAt: '2026-12-31T00:00:00.000Z',
      });
    });
    writer.close();
  });
  afterEach(() => removeTree(brewery.path));

  const foedrum = (...args: string[]) => foedrumIn(brewery.path, args);
  const writeRecipe = (steps: unknown[]): void =>
    writeFileSync(join(brewery.path, 'recipes', 'pale.jsonc'), recipeText('pale', steps));

  it("schedules a step with the deadline of the Brewery's brewer", async () => {
    writeRecipe([{ brewer: 'maltster' }]);
    const before = Date.now();
    const { exitCode, stdout, stderr } = await foedrum('retry', '12-1');
    assert.equal(stderr, '');
    assert.equal(exitCode, 0);
    assert.match(stdout, /^12-1 brewing: maltster #1 scheduled/);
    const reader = openSqliteEventStore(store, { readOnly: true });
    const scheduled = reader
      .eventsAfter(0)
      .flatMap(({ event }) => (event.type === 'step.scheduled' ? [event] : []));
    reader.close();
    assert.equal(scheduled.length, 1);
    const deadlineAt = Date.parse(scheduled[0]?.deadlineAt ?? '');
    // The maltster's deadline is 30 minutes.
    assert.ok(deadlineAt >= before + 30 * 60_000 && deadlineAt <= Date.now() + 30 * 60_000);
  });

  it("is refused with doctor's line when a recipe file is not valid, and changes nothing", async () => {
    writeRecipe([{ brewer: 'maltster' }, { id: 'approve', gate: 'human', deadline: '1d' }]);
    const line = `${INVALID_RECIPES}: recipes/pale.jsonc: step "approve" is a gate step, which the engine does not brew yet (ADR 0053)`;
    const retry = await foedrum('retry', '12-1');
    assert.deepEqual(
      { exitCode: retry.exitCode, stdout: retry.stdout, stderr: retry.stderr },
      { exitCode: 1, stdout: '', stderr: `foedrum retry: ${line}\n` },
    );
    const reader = openSqliteEventStore(store, { readOnly: true });
    assert.equal(reader.lastEventId(), 3);
    reader.close();
    // doctor's own shell, with a canned answer for gh's login check (ADR 0073).
    const doctor = await doctorHere(brewery.path);
    assert.equal(doctor.exitCode, 1);
    assert.ok(
      doctor.stdout.split('\n').includes(`  ${line.replace(': ', ' (required): ')}`),
      doctor.stdout,
    );
  });
});
