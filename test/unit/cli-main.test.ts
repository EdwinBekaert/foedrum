// `foedrum status`, `replay`, `cancel`, `retry`, `brewers`, `order` and `doctor` through the
// wiring main.ts runs (cliFromCheckout), against real store files and recipe files, which a unit
// test may hold (ADR 0021). gh answers from captured output over a runner that starts nothing, and
// the PATH lookup is made up, so no command here starts a process or reads this machine's tools
// (ADR 0086, ADR 0362). The output itself is in cli.test.ts; listing a kept branch, which needs
// git, is in test/integration/cli.test.ts.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cliFromCheckout } from '../../src/cli/cli-main.ts';
import type { TerminalStream } from '../../src/cli/live-terminal.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { INVALID_RECIPES } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';
import { cannedGhLogin, doctorHere, MADE_UP_GH, noDenylist } from '../helpers/canned-gh.ts';
import { flagValue, ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { config } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

// A runner that starts nothing: every tool but gh, which cannedGhLogin answers, could not start.
const startsNothing: ExecProcess = async (file) => {
  const output = `${file}: not started in a unit test`;
  return { exitCode: null, stdout: '', stderr: output, output };
};

// The PATH lookup, with every tool at a made-up path and gh at MADE_UP_GH.
const madeUpPath = (name: string): string => (name === 'gh' ? MADE_UP_GH : `/made-up/bin/${name}`);

// What every command here runs with: canned gh over a runner that starts nothing, made-up tools.
const startingNothing = {
  exec: cannedGhLogin(startsNothing),
  resolve: madeUpPath,
  denylist: noDenylist,
};

const foedrumIn = (cwd: string, args: string[]) => cliFromCheckout(args, cwd, startingNothing);

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
    const canned = cannedGhLogin(startsNothing);
    const exec: ExecProcess = (file, execArgs, options) => {
      files.push(file);
      return canned(file, execArgs, options);
    };
    await cliFromCheckout(args, dir.path, { ...startingNothing, exec });
    return files;
  };

  it('asks doctor’s gh through the injected runner', async () => {
    assert.ok((await started(['doctor'])).includes(MADE_UP_GH));
  });

  it('asks serve’s gh through the injected runner, before it refuses a folder that is no Brewery', async () => {
    assert.ok((await started(['serve'])).includes(MADE_UP_GH));
  });

  it("prints the version of Foedrum's own package.json, not the Brewery's, for --version", async () => {
    writeFileSync(join(dir.path, 'package.json'), '{ "name": "brewery", "version": "9.9.9" }\n');
    const own = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.deepEqual(await foedrumIn(dir.path, ['--version']), {
      exitCode: 0,
      stdout: `${own.version}\n`,
      stderr: '',
    });
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
    const { exitCode, stdout, stderr } = await foedrum('replay', '12-1');
    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.equal(stderr, `foedrum replay: no event store at ${store}\n`);
    assert.equal(existsSync(store), false);
  });

  it('says there are no batches yet, and creates no store, in a folder without one', async () => {
    assert.deepEqual(await foedrum('status'), {
      exitCode: 0,
      stdout: 'No batches yet.\n',
      stderr: '',
    });
    assert.equal(existsSync(store), false);
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
    assert.equal(stdout, `#12 is done: cancelled by ${userInfo().username} from a terminal\n`);
    const reader = openSqliteEventStore(store, { readOnly: true });
    assert.deepEqual(reader.eventsAfter(1)[0]?.event, {
      type: 'batch.cancelled',
      batchId: '12-1',
      by: userInfo().username,
      via: 'terminal',
    });
    reader.close();
  });

  it('records a command that changes state as the user the caller gives, not the account', async () => {
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
    // A name no machine's account has, as npm run demo gives its own user (#663).
    const user = 'demo-user-663';
    const { exitCode, stdout, stderr } = await cliFromCheckout(['cancel', '12-1'], brewery.path, {
      ...startingNothing,
      user: () => user,
    });
    assert.equal(stderr, '');
    assert.equal(exitCode, 0);
    assert.equal(stdout, `#12 is done: cancelled by ${user} from a terminal\n`);
    const reader = openSqliteEventStore(store, { readOnly: true });
    assert.deepEqual(reader.eventsAfter(1)[0]?.event, {
      type: 'batch.cancelled',
      batchId: '12-1',
      by: user,
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

  it('says in one line, and exits 1, when the store is not a database', async () => {
    mkdirSync(join(brewery.path, '.foedrum'));
    writeFileSync(store, 'not a database, but long enough to have a header page\n'.repeat(10));
    const { exitCode, stdout, stderr } = await foedrum('status');
    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /^foedrum status: [^\n]+\n$/);
  });
});

describe('foedrum status --watch through cliFromCheckout (ADR 0188)', () => {
  let brewery: TempDir;
  let store: string;
  beforeEach(() => {
    brewery = makeTempDir('cli');
    store = join(brewery.path, '.foedrum', 'index.db');
  });
  afterEach(() => removeTree(brewery.path));

  /** A TTY stream that keeps what is written to it and calls `written` after each write. */
  const ttyStream = (isTTY: boolean, written: (text: string) => void = () => {}) => {
    const writes: string[] = [];
    const stream: TerminalStream = {
      isTTY,
      columns: 100,
      rows: 30,
      on: () => {},
      off: () => {},
      cursorTo: () => true,
      moveCursor: () => true,
      clearLine: () => true,
      clearScreenDown: () => true,
      write: (text) => {
        writes.push(text);
        written(text);
        return true;
      },
    };
    return { stream, writes };
  };

  it("draws the board of the Brewery's store on the terminal, and ends on a stop signal with exit code 0", async () => {
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
    const listeners = process.listenerCount('SIGBREAK');
    // The stop comes once the first board is on the terminal, as a Ctrl+C would.
    const { stream, writes } = ttyStream(true, (text) => {
      if (text.includes('12-1')) process.emit('SIGBREAK', 'SIGBREAK');
    });
    const result = await cliFromCheckout(['status', '--watch'], brewery.path, {
      ...startingNothing,
      board: { stream, env: { TERM: 'xterm' } },
    });
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(writes[0], '1 live batch');
    assert.match(
      writes.join(''),
      /^1 live batch\n- +12-1 +#12 +Queued: waiting for a recipe +a recipe is chosen by /,
    );
    assert.equal(writes.at(-1), '\n');
    assert.equal(process.listenerCount('SIGBREAK'), listeners);
  });

  it('says there are no live batches in a Brewery without a store, and creates none', async () => {
    const { stream, writes } = ttyStream(true, (text) => {
      if (text === 'No live batches.') process.emit('SIGBREAK', 'SIGBREAK');
    });
    const result = await cliFromCheckout(['status', '--watch'], brewery.path, {
      ...startingNothing,
      board: { stream, env: { TERM: 'xterm' } },
    });
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.equal(writes[0], 'No live batches.');
    assert.equal(existsSync(store), false);
  });

  it('refuses off a terminal in one line with exit code 1, and creates no store', async () => {
    const { stream, writes } = ttyStream(false);
    const result = await cliFromCheckout(['status', '--watch'], brewery.path, {
      ...startingNothing,
      board: { stream, env: { TERM: 'xterm' } },
    });
    assert.deepEqual(result, {
      exitCode: 1,
      stdout: '',
      stderr: 'foedrum status --watch needs a terminal; foedrum status prints the batches once\n',
    });
    assert.deepEqual(writes, []);
    assert.equal(existsSync(store), false);
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
    writeFileSync(join(brewery.path, 'brewers', 'roaster.md'), brewerText('roaster'));
    // 12-1 brews pale and got Stuck at its roaster step.
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
          stepId: 'roaster',
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
    writeRecipe([{ brewer: 'roaster' }]);
    const before = Date.now();
    const { exitCode, stdout, stderr } = await foedrum('retry', '12-1');
    assert.equal(stderr, '');
    assert.equal(exitCode, 0);
    assert.match(stdout, /^#12 is running: step roaster is about to start/);
    const reader = openSqliteEventStore(store, { readOnly: true });
    const scheduled = reader
      .eventsAfter(0)
      .flatMap(({ event }) => (event.type === 'step.scheduled' ? [event] : []));
    reader.close();
    assert.equal(scheduled.length, 1);
    const deadlineAt = Date.parse(scheduled[0]?.deadlineAt ?? '');
    // The roaster's deadline is 30 minutes.
    assert.ok(deadlineAt >= before + 30 * 60_000 && deadlineAt <= Date.now() + 30 * 60_000);
  });

  it("reports the Brewery's brewer with the batch Stuck at its step, and appends nothing (ADR 0159)", async () => {
    writeRecipe([{ brewer: 'roaster' }]);
    const { exitCode, stdout, stderr } = await foedrum('brewers');
    assert.equal(stderr, '');
    assert.equal(exitCode, 0);
    assert.ok(
      stdout.includes('roaster  brewers/roaster.md\n  no attempts\n  Stuck: 12-1\n'),
      stdout,
    );
    // Foedrum's default brewers are in use too (ADR 0098).
    assert.ok(stdout.includes('gauger  defaults/brewers/gauger.md\n  no attempts\n'), stdout);
    const reader = openSqliteEventStore(store, { readOnly: true });
    assert.equal(reader.lastEventId(), 3);
    reader.close();
  });

  it("is refused with doctor's line when a recipe file is not valid, and changes nothing", async () => {
    writeRecipe([{ brewer: 'roaster' }, { id: 'approve', gate: 'human', deadline: '1d' }]);
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
    const doctor = await doctorHere(brewery.path, cannedGhLogin(startsNothing), madeUpPath);
    assert.equal(doctor.exitCode, 1);
    assert.ok(
      doctor.stdout.split('\n').includes(`  ${line.replace(': ', ' (required): ')}`),
      doctor.stdout,
    );
  });
});

describe('foedrum order through cliFromCheckout (ADR 0105)', () => {
  let brewery: TempDir;
  let store: string;
  beforeEach(() => {
    brewery = makeTempDir('cli-order');
    store = join(brewery.path, '.foedrum', 'index.db');
  });
  afterEach(() => removeTree(brewery.path));

  const intake = { alias: 'web', intake: { labels: ['foedrum'] } };
  const order = (exec: ExecProcess) =>
    cliFromCheckout(['order', 'web#7'], brewery.path, { exec, resolve: madeUpPath });

  it('claims a target issue through gh, on the host foedrum.jsonc names, and orders it again', async () => {
    writeFileSync(
      join(brewery.path, 'foedrum.jsonc'),
      config({ githubApi: 'http://api.github.localhost' }, intake),
    );
    mkdirSync(join(brewery.path, '.foedrum'));
    const writer = openSqliteEventStore(store);
    writer.withTransaction((tx) => {
      const batchId = 'web-7';
      tx.append({
        type: 'batch.ordered',
        batchId,
        order: { issue: 7, repo: 'acme/web' },
        routeBy: '2026-10-15T13:00:00.000Z',
      });
      tx.append({ type: 'batch.cancelled', batchId, by: 'ann', via: 'comment' });
      for (const effect of ['release.label', 'release.comment', 'release.ref']) {
        tx.append({
          type: 'effect.applied',
          key: effectKey.encode({ batchId, effect }),
          result: null,
        });
      }
    });
    writer.close();
    const api = fakeGitHubApi({ login: 'ann', issues: {} });
    const gh = ghOver(api.fetch);

    const { exitCode, stdout, stderr } = await order(gh.exec);
    assert.equal(stderr, '');
    assert.equal(exitCode, 0);
    assert.match(
      stdout,
      /^web#7 is queued: waiting for a recipe: a recipe is chosen by \d{1,2} [A-Z][a-z]{2} \d{2}:\d{2} UTC\n$/,
    );
    assert.deepStrictEqual(api.created, ['acme/web refs/foedrum/claims/issues/7']);
    assert.deepStrictEqual(
      [...new Set(gh.calls.map(({ args }) => flagValue(args, '--hostname')))],
      ['github.localhost'],
    );
    const reader = openSqliteEventStore(store, { readOnly: true });
    const last = reader.eventsAfter(0).at(-1)?.event;
    reader.close();
    assert.deepStrictEqual(last?.type === 'batch.ordered' && [last.batchId, last.by, last.via], [
      'web-7-2',
      userInfo().username,
      'terminal',
    ]);
  });

  it('says in one line when foedrum.jsonc is missing or does not pass its schema, and asks gh nothing', async () => {
    const gh = ghOver(fakeGitHubApi({ login: 'ann', issues: {} }).fetch);
    assert.deepStrictEqual(await order(gh.exec), {
      exitCode: 1,
      stdout: '',
      stderr: `foedrum order: foedrum.jsonc: not found in ${brewery.path}\n`,
    });
    writeFileSync(
      join(brewery.path, 'foedrum.jsonc'),
      config({ brewery: 'not a repository' }, intake),
    );
    const invalid = await order(gh.exec);
    assert.equal(invalid.exitCode, 1);
    assert.match(invalid.stderr, /^foedrum order: foedrum\.jsonc: .*brewery.*\n$/);
    assert.equal(invalid.stderr.split('\n').length, 2, invalid.stderr);
    assert.deepStrictEqual(gh.calls, []);
  });
});
