// `foedrum brew` (ADR 0123): its schema, its owner, and runBrew on serve's shell with an in-memory
// store, fake worktrees, a fake GitHub and the scripted runner: it orders and routes an issue with
// no batch and brews it on tap, refuses a batch another driver leases, and stops with the questions
// when the batch needs input. No process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { type BrewRequest, runBrew } from '../../src/cli/brew.ts';
import {
  brewFromCheckout,
  brewInNewWindow,
  brewRequestOf,
  brewShellOf,
  lauterTarget,
  lauterTargetIn,
  noSessionsOf,
  thisMachine,
} from '../../src/cli/brew-main.ts';
import { brewOwner } from '../../src/cli/driver-owner.ts';
import type { LiveTerminal, ServeShell } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { takeOver } from '../../src/engine/batch-leases.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { DriverRunningError } from '../../src/engine/driver-lock.ts';
import { fold } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import type { FlushResult } from '../../src/engine/state-branch-git.ts';
import type { AttemptProgress } from '../../src/engine/supervisor.ts';
import { launchProcess } from '../../src/platform/processes.ts';
import { BrewCommand, type LauterCommand, MashCommand } from '../../src/schemas/commands.ts';
import type { Question } from '../../src/schemas/step-outcome.ts';
import { brewFixture, request, t0 } from '../helpers/brew-fixture.ts';
import {
  type Behaviour,
  behave,
  fakeBrewerRunner,
  question,
} from '../helpers/fake-brewer-runner.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { brewer, local, serveInputs } from '../helpers/serve-brewery.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const SPINNER = ['|', '/', '-', '\\'];

/**
 * A terminal over a fake screen (ADR 0174): it keeps what the live line shows now, every call and
 * every lasting line in order, and the lasting lines printed while the live line was on screen.
 */
const fakeScreen = (width: number | 'unknown') => {
  let columns = width === 'unknown' ? undefined : width;
  let drawn: string | undefined;
  const events: string[] = [];
  const resizers = new Set<() => void>();
  const printedOver: string[] = [];
  const terminal: LiveTerminal = {
    columns: () => columns,
    onResize: (handler) => {
      resizers.add(handler);
      return () => {
        resizers.delete(handler);
      };
    },
    clear: () => {
      events.push('clear');
      drawn = undefined;
    },
    rewrite: (text) => {
      events.push(`rewrite: ${text}`);
      drawn = text;
    },
  };
  /** The live lines drawn, in order. */
  const rewrites = (): string[] =>
    events.filter((event) => event.startsWith('rewrite: ')).map((event) => event.slice(9));
  return {
    terminal,
    events,
    resizers,
    printedOver,
    rewrites,
    /** What the live line shows now. */
    drawn: () => drawn,
    /** The shell's `out`: a lasting line. */
    print: (line: string): void => {
      if (drawn !== undefined) printedOver.push(line);
      events.push(`out: ${line}`);
    },
    resize: (to: number | undefined): void => {
      columns = to;
      for (const handler of [...resizers]) handler();
    },
    /** The live lines drawn, each without its spinner and the batch's time (ADR 0179). */
    texts: (): string[] =>
      rewrites().map((text) => {
        assert.ok(SPINNER.includes(text[0] ?? ''), `a spinner starts ${JSON.stringify(text)}`);
        const batchTime = BATCH_TIME.exec(text.slice(2));
        assert.ok(batchTime, `the batch's time leads ${JSON.stringify(text)}`);
        return text.slice(2 + batchTime[0].length);
      }),
    /** The batch's time on each live line drawn. */
    batchTimes: (): string[] =>
      rewrites().map((text) => BATCH_TIME.exec(text.slice(2))?.[1] ?? `none in ${text}`),
  };
};

/** The batch's time that leads a live line after its spinner, with the ` / ` after it. */
const BATCH_TIME = /^((?:\d+m )?\d+s) \/ /;

/** The line without its elapsed time, which depends on when each redraw came. */
const withoutTime = (text: string): string => text.replace(/ \/ (\d+m )?\d+s(?= \/|$)/, '');

describe('BrewCommand', () => {
  it('takes an issue as foedrum order does, and the name of its driver', () => {
    assert.deepStrictEqual(BrewCommand.parse({ command: 'brew', issue: '#12' }), {
      command: 'brew',
      issue: { issue: 12 },
    });
    assert.deepStrictEqual(BrewCommand.parse({ command: 'brew', issue: 'web#7', as: 'ann' }), {
      command: 'brew',
      issue: { alias: 'web', issue: 7 },
      as: 'ann',
    });
  });

  it("refuses the Cellar's owner, a name that is no path segment, and an issue it cannot read", () => {
    for (const input of [
      { command: 'brew', issue: '12', as: 'cellar' },
      { command: 'brew', issue: '12', as: 'Ann Lee' },
      { command: 'brew', issue: 'web#x' },
      { command: 'brew', issue: '12', recipe: 'stout' },
    ]) {
      assert.equal(BrewCommand.safeParse(input).success, false, JSON.stringify(input));
    }
  });

  it('takes --new-window, which opens the brew in a new terminal window (ADR 0222)', () => {
    const parsed = BrewCommand.safeParse({ command: 'brew', issue: '12', 'new-window': true });
    assert.deepStrictEqual(parsed.success && parsed.data, {
      command: 'brew',
      issue: { issue: 12 },
      'new-window': true,
    });
  });
});

describe('brewOwner', () => {
  const session = '0F8E2C1A-7B3D-4E5F-9A6B-1C2D3E4F5A6B';

  it('is the name given with --as, before the session', () => {
    assert.deepStrictEqual(brewOwner('ann', { CLAUDE_CODE_SESSION_ID: session }), {
      owner: 'ann',
    });
  });

  it("is the Claude Code session's id, which a resume by id keeps, in lower case", () => {
    assert.deepStrictEqual(brewOwner(undefined, { CLAUDE_CODE_SESSION_ID: session }), {
      owner: `session-${session.toLowerCase()}`,
    });
  });

  it('is terminal outside a session and without a name (ADR 0259)', () => {
    for (const env of [{}, { CLAUDE_CODE_SESSION_ID: '' }]) {
      assert.deepStrictEqual(brewOwner(undefined, env), { owner: 'terminal' }, JSON.stringify(env));
    }
  });

  it('is refused, naming --as, for a session id that names no driver', () => {
    const owner = brewOwner(undefined, { CLAUDE_CODE_SESSION_ID: '../x' });
    assert.ok('refused' in owner);
    assert.match(owner.refused, /--as <name>/);
  });
});

describe("brew-main's shell, request and new window (ADR 0222)", () => {
  const issued = { by: 'ann', via: 'plugin' } as const;
  const command = BrewCommand.parse({ command: 'brew', issue: 'web#12', take: true });

  it('asks runBrew to open no session, with why, only when the machine opens none', () => {
    assert.deepStrictEqual(brewRequestOf(command, 'ann', issued, 'no-terminal'), {
      target: { alias: 'web', issue: 12 },
      owner: 'ann',
      ...issued,
      take: true,
      noSessions: 'no-terminal',
    });
    assert.equal('noSessions' in brewRequestOf(command, 'ann', issued, undefined), false);
  });

  it('asks runBrew to mash for foedrum mash, and for foedrum brew not (ADR 0232)', () => {
    const mash = MashCommand.parse({ command: 'mash', issue: '#13' });
    assert.deepStrictEqual(brewRequestOf(mash, 'ann', issued, undefined), {
      target: { issue: 13 },
      owner: 'ann',
      ...issued,
      mash: true,
    });
    assert.equal('mash' in brewRequestOf(command, 'ann', issued, undefined), false);
  });

  it('asks runBrew to lauter the issue of the batch, taking it over, for foedrum lauter (ADR 0286, #589)', () => {
    const lauter: LauterCommand = { command: 'lauter', batch: '12-1' };
    assert.deepStrictEqual(brewRequestOf(lauter, 'ann', issued, undefined, { issue: 12 }), {
      target: { issue: 12 },
      owner: 'ann',
      ...issued,
      take: true,
      lauter: '12-1',
    });
    assert.equal('lauter' in brewRequestOf(command, 'ann', issued, undefined), false);
  });

  it("reads the batch foedrum lauter names from the Brewery's store, none yet being no batch: regression test (#589)", () => {
    const dir = makeTempDir('lauter-store');
    try {
      const path = join(dir.path, 'index.db');
      assert.deepStrictEqual(lauterTargetIn(path, '12-1', []), {
        refused: 'there is no batch 12-1',
      });
      const store = openSqliteEventStore(path);
      const order = { issue: 12 };
      const routeBy = '2026-10-28T13:00:00.000Z';
      store.withTransaction((tx) =>
        tx.append({ type: 'batch.ordered', batchId: '12-1', order, routeBy }),
      );
      store.close();
      assert.deepStrictEqual(lauterTargetIn(path, '12-1', []), { target: { issue: 12 } });
      assert.deepStrictEqual(lauterTargetIn(path, '99-1', []), {
        refused: 'there is no batch 99-1',
      });
    } finally {
      dir.remove();
    }
  });

  it('finds the issue of the batch foedrum lauter names, by its alias in a target repository (#589)', () => {
    const ordered = (batchId: string, order: { issue: number; repo?: string }) =>
      ({ type: 'batch.ordered', batchId, order, routeBy: '2026-10-28T13:00:00.000Z' }) as const;
    const state = fold([
      ordered('12-1', { issue: 12 }),
      ordered('web-7-1', { issue: 7, repo: 'acme/web' }),
    ]);
    const repositories = [{ alias: 'web', repo: 'acme/web' }];
    assert.deepStrictEqual(lauterTarget(state, '12-1', repositories), { target: { issue: 12 } });
    assert.deepStrictEqual(lauterTarget(state, 'web-7-1', repositories), {
      target: { alias: 'web', issue: 7 },
    });
    assert.deepStrictEqual(lauterTarget(state, '99-1', repositories), {
      refused: 'there is no batch 99-1',
    });
    assert.deepStrictEqual(lauterTarget(state, 'web-7-1', []), {
      refused: 'batch web-7-1 is of acme/web, which foedrum.jsonc names with no alias and intake',
    });
  });

  it("keeps serve's runner without sessions, and with them runs every attempt through the interactive runner, a resumed one headless", () => {
    const served: BrewerRunner = { start: () => assert.fail('serve'), progress: () => undefined };
    const base = { runner: () => served } as unknown as ServeShell;
    const made: boolean[] = [];
    const interactive = (_claude: string, _plan: unknown, opensResumed: boolean): BrewerRunner => {
      made.push(opensResumed);
      return served;
    };
    assert.equal(brewShellOf(base, 'claude-code', interactive), base);
    const plan = async () => assert.fail('no plan');
    brewShellOf(base, undefined, interactive).runner('/bin/claude', plan);
    assert.deepStrictEqual(made, [false]);
  });

  describe('brewInNewWindow', () => {
    const launched: { file: string; args: readonly string[]; env: unknown }[] = [];
    const deps = (exitCode: number | null) => ({
      platform: 'linux' as const,
      env: { DISPLAY: ':0', CLAUDE_CODE_CHILD_SESSION: '1' },
      find: (name: string) =>
        ['setsid', 'x-terminal-emulator'].includes(name) ? `/usr/bin/${name}` : undefined,
      execPath: '/usr/bin/node',
      script: '/opt/foedrum/src/cli/main.ts',
      exec: async (file: string, args: readonly string[], options: { env?: unknown }) => {
        launched.push({ file, args, env: options.env });
        return { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'no', output: '' };
      },
    });

    it('launches this node and program with brew <alias>#<issue> --take in the Brewery: exit 0', async () => {
      launched.length = 0;
      const result = await brewInNewWindow('/home/ann/brewery', command, 'session-ab12', deps(0));
      assert.equal(result.exitCode, 0);
      const [first] = launched;
      assert.deepStrictEqual(first?.args.slice(3, 7), [
        '/usr/bin/node',
        '/opt/foedrum/src/cli/main.ts',
        'brew',
        'web#12',
      ]);
      assert.ok(first?.args.includes('--take'));
      assert.match(result.stdout, /foedrum brew web#12 --take/);
    });

    it("runs the window's brew as this brew's owner, without the Claude Code session's variables, so it opens the session", async () => {
      launched.length = 0;
      await brewInNewWindow('/home/ann/brewery', command, 'session-ab12', deps(0));
      const [first] = launched;
      assert.deepStrictEqual(first?.args.slice(-5), [
        'brew',
        'web#12',
        '--take',
        '--as',
        'session-ab12',
      ]);
      assert.deepStrictEqual(first?.env, { DISPLAY: ':0' });
    });

    it('says it asked for the window, which only the window shows opened', async () => {
      const result = await brewInNewWindow('/home/ann/brewery', command, 'session-ab12', deps(0));
      assert.equal(
        result.stdout,
        'foedrum brew: asked for a new window that runs foedrum brew web#12 --take --as session-ab12; exit its claude session there when the step is done, then check the batch with foedrum status. If no window opened, run that command in a terminal\n',
      );
    });

    it("leaves out the session's variables in any case on Windows, and keeps every other", async () => {
      launched.length = 0;
      const env = {
        Claude_Code_Child_Session: '1',
        CLAUDE_CODE_SESSION_ID: 'ab12',
        PATH: 'C:\\Windows',
      };
      const windows = { ...deps(0), platform: 'win32' as const, env, find: () => 'wt.exe' };
      await brewInNewWindow(
        'D:\\brewery',
        BrewCommand.parse({ command: 'brew', issue: '12' }),
        'ann',
        windows,
      );
      assert.deepStrictEqual(launched[0]?.env, { PATH: 'C:\\Windows' });
    });

    it('says the command to run in a terminal when no window opens: exit 5', async () => {
      const result = await brewInNewWindow('/home/ann/brewery', command, 'session-ab12', deps(1));
      assert.equal(result.exitCode, 5);
      assert.match(
        result.stderr,
        /no new window can open here \(setsid exited with code 1: no\); run foedrum brew web#12 --take/,
      );
    });
  });
});

describe('thisMachine (ADR 0222)', () => {
  it('launches through launchProcess, with this node, this program and the environment given', () => {
    const env = { DISPLAY: ':0' };
    const machine = thisMachine(env);
    assert.equal(machine.exec, launchProcess);
    assert.equal(machine.execPath, process.execPath);
    assert.equal(machine.script, process.argv[1]);
    assert.equal(machine.env, env);
    assert.equal(machine.platform, process.platform);
  });
});

describe('noSessionsOf (ADR 0222)', () => {
  it('opens sessions on a terminal outside Claude Code', () => {
    assert.equal(noSessionsOf({}, 'linux', true), undefined);
  });

  it('opens none inside Claude Code, whose session keeps the terminal, by the name as Windows reads it', () => {
    assert.equal(noSessionsOf({ CLAUDE_CODE_CHILD_SESSION: '1' }, 'linux', true), 'claude-code');
    assert.equal(noSessionsOf({ claude_code_child_session: '1' }, 'win32', true), 'claude-code');
  });

  it('opens none when stdin is no terminal: a pipe, CI, or mintty without a console', () => {
    assert.equal(noSessionsOf({}, 'win32', false), 'no-terminal');
  });
});

describe('brewFromCheckout', () => {
  it('refuses with exit 2, reading nothing of the Brewery, when the session names no driver', async () => {
    const input = { command: 'brew', issue: { issue: 12 } } as const;
    const issued = { by: 'ann', via: 'terminal' } as const;
    const options = { exec: () => assert.fail('no tool is asked'), resolve: () => assert.fail() };
    const env = { CLAUDE_CODE_SESSION_ID: '../x' };
    assert.deepStrictEqual(await brewFromCheckout('no-brewery', input, issued, options, env), {
      exitCode: 2,
      stdout: '',
      stderr: 'foedrum brew: the Claude Code session "../x" names no driver; give --as <name>\n',
    });
  });
});

describe('runBrew', () => {
  const f = brewFixture();
  const { leaseOf, log, shell } = f;

  it('orders and routes an issue with no batch, and brews it on tap with no Cellar: exit 0', async () => {
    assert.equal(await runBrew(f.setup, shell(behave.succeed('Brewed')), request), 0);
    assert.deepStrictEqual(f.locked, ['ann']);
    assert.deepStrictEqual(f.started, ['brew#1']);
    const batch = log().state().batches.get('12-1');
    assert.equal(batch?.lane.kind, 'on_tap');
    // The order is a person's, recorded with who ran brew and from where (ADR 0105).
    const ordered = f.store.eventsAfter(0).find(({ event }) => event.type === 'batch.ordered');
    assert.deepStrictEqual(
      ordered?.event.type === 'batch.ordered'
        ? { by: ordered.event.by, via: ordered.event.via }
        : undefined,
      { by: 'ann', via: 'terminal' },
    );
    assert.equal(f.api.pulls.length, 1);
    assert.ok(f.lines.includes('foedrum brew: ordered #12 as batch 12-1'), f.lines.join('\n'));
    assert.ok(
      f.lines.includes('foedrum brew: routed batch 12-1 to the recipe stout'),
      f.lines.join('\n'),
    );
    assert.ok(f.lines.includes('foedrum brew: brewing batch 12-1 as ann'), f.lines.join('\n'));
    assert.equal(
      f.lines.at(-1),
      `foedrum brew: batch 12-1 is on tap: https://github.com/acme/web/pull/${f.api.pulls[0]?.number}`,
    );
    // Every effect applied, the driver let the batch go and its lock.
    assert.equal(leaseOf(), undefined);
    assert.equal(f.lock.held, false);
  });

  /** How many times the driver read whether acme/web is public. */
  const visibilityReads = () =>
    f.api.requests.filter((request) => request === 'GET /repos/acme/web').length;
  /** The fake GitHub, answering whether acme/web is public with `answer`. */
  const answeringVisibility = (answer: { status: number; body?: unknown }) =>
    fakeGitHubApi({
      login: 'ann',
      issues: f.api.issues,
      instead: (method, url) =>
        method === 'GET' && url.pathname === '/repos/acme/web' ? answer : undefined,
    });

  it("reads a repository's visibility again on each tick while it could not be read (ADR 0300)", async () => {
    // GitHub fails to answer: unknown, so every tick reads it again.
    f.api = answeringVisibility({ status: 503, body: { message: 'Service Unavailable' } });
    assert.equal(await runBrew(f.setup, shell(behave.succeed('Brewed')), request), 0);
    assert.ok(visibilityReads() > 2, f.api.requests.join('|'));
  });

  it("reads a repository's visibility again only after the tick, which renews the leases first (ADR 0300)", async () => {
    f.api = answeringVisibility({ status: 503, body: { message: 'Service Unavailable' } });
    assert.equal(await runBrew(f.setup, shell(behave.succeed('Brewed')), request), 0);
    const reads = f.api.requests.flatMap((request, at) =>
      request === 'GET /repos/acme/web' ? [at] : [],
    );
    const [opening, second] = reads;
    assert.ok(opening !== undefined && second !== undefined, f.api.requests.join('|'));
    // The first tick posts the status comment before the visibility is read again.
    assert.ok(
      f.api.requests
        .slice(opening + 1, second)
        .includes('POST /repos/Acme/Brewery/issues/12/comments'),
      f.api.requests.join('|'),
    );
  });

  /**
   * The body brew opens #12's pull request with, as a sub-order of order #1 beside #13 in a
   * repository this Brewery does not list, acme/web answered with `answer`.
   */
  const subOrderBody = async (answer: { status: number; body?: unknown }): Promise<string> => {
    f.api = answeringVisibility(answer);
    const routeBy = new Date(t0.getTime() + 3_600_000).toISOString();
    f.store.withTransaction((tx) => {
      tx.append({ type: 'batch.ordered', batchId: '1-1', order: { issue: 1 }, routeBy });
      tx.append({
        type: 'order.decomposed',
        batchId: '1-1',
        subOrders: [
          { issue: 12, repo: 'acme/web' },
          { issue: 13, repo: 'acme/ledger' },
        ],
        dependencies: [],
      });
      tx.append({ type: 'batch.on_tap', batchId: '1-1', pullRequests: [] });
      // As the intake orders a sub-order: brew refuses to order one itself.
      tx.append({
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        parentBatchId: '1-1',
        routeBy,
      });
    });
    assert.equal(
      await runBrew(f.setup, shell(behave.succeed('Brewed')), request),
      0,
      f.lines.join('|'),
    );
    return f.api.pulls[0]?.body ?? assert.fail('no pull request opened');
  };

  it("names a sibling in a private sub-order's pull request, as the visibility read says (ADR 0300): regression test", async () => {
    const body = await subOrderBody({
      status: 200,
      body: { private: true, visibility: 'private' },
    });
    assert.match(body, /^2\. acme\/ledger: not opened yet/m);
  });

  it("hides a sibling it cannot read in a public sub-order's pull request, as the visibility read says (ADR 0300): regression test", async () => {
    const body = await subOrderBody({
      status: 200,
      body: { private: false, visibility: 'public' },
    });
    assert.match(body, /^2\. A pull request in a private repository: not opened yet/m);
    assert.doesNotMatch(body, /acme\/ledger/);
  });

  it("reads a repository's visibility once when GitHub answers it (ADR 0300)", async () => {
    f.api = answeringVisibility({ status: 200, body: { private: false, visibility: 'public' } });
    assert.equal(await runBrew(f.setup, shell(behave.succeed('Brewed')), request), 0);
    assert.equal(visibilityReads(), 1);
  });

  it('says the batch is on tap once, in its last line (#662)', async () => {
    assert.equal(await runBrew(f.setup, shell(behave.succeed('Brewed')), request), 0);
    const url = `https://github.com/acme/web/pull/${f.api.pulls[0]?.number}`;
    assert.deepStrictEqual(
      f.lines.filter((line) => line.includes('on tap')),
      [`foedrum brew: batch 12-1 is on tap: ${url}`],
    );
  });

  it('names the lane on tap when it is stopped while the batch on tap still applies its effects (#662)', async () => {
    const controller = new AbortController();
    const stopping = shell(behave.succeed('Brewed'), {
      signal: controller.signal,
      wait: async () => {
        if (log().state().batches.get('12-1')?.lane.kind === 'on_tap') controller.abort();
      },
    });
    assert.equal(await runBrew(f.setup, stopping, request), 1);
    const url = `https://github.com/acme/web/pull/${f.api.pulls[0]?.number}`;
    assert.equal(f.lines.at(-1), `foedrum brew: stopped; batch 12-1 on tap: ${url}`);
  });

  it("opens the pull request on the code host in Foedrum's layout, as a draft with no Taster (ADR 0167)", async () => {
    const files = serveInputs().files;
    const writing = serveSetup(
      serveInputs({
        files: {
          ...files,
          local: local({ workRoot: f.dir.path }),
          brewery: {
            ...files.brewery,
            brewers: [
              {
                path: 'brewers/cellarman.md',
                text: brewer.replace('"schema": "outDoc"', '"schema": "pullRequest"'),
              },
            ],
          },
        },
      }),
    );
    assert.equal(writing.kind, 'ready');
    if (writing.kind !== 'ready') return;
    const sections = {
      howItWorks: 'This touches `foedrum status`. Fixes #3 for @octocat.',
      seeIt: '`foedrum status --json` prints JSON',
      beforeAfter: [{ case: '`status --json`', before: 'refused', after: 'JSON' }],
    };
    const brewing = shell(behave.succeedWith(sections, 'Added --json'));
    assert.equal(await runBrew(writing.setup, brewing, request), 0);
    assert.equal(f.api.pulls.length, 1);
    const [pull] = f.api.pulls;
    assert.equal(pull?.draft, true);
    // Its last line is the marker of the body (ADR 0227), after the layout.
    const body = pull?.body ?? '';
    assert.match(body, /\n\n<!-- foedrum:\[[^\]]*\] sha256:[0-9a-f]{16} -->$/);
    assert.equal(
      body.slice(0, body.lastIndexOf('\n\n')),
      [
        '## How it works',
        '',
        'This touches `foedrum status`. #3 for octocat.',
        '',
        '| | Before | After |',
        '|---|---|---|',
        '| `status --json` | refused | JSON |',
        '',
        '**See it:** `foedrum status --json` prints JSON',
        '',
        '## How this was brewed',
        '',
        'Brewed by Foedrum with the recipe stout.',
        '',
        'A person reviews this before it is marked ready: no step tasted the change.',
        '',
        '| Attempt | Result |',
        '|---|---|',
        '| `brew #1` | succeeded |',
        '',
        '<details><summary>What each step reported</summary>',
        '',
        '```text',
        'brew: Added --json',
        '```',
        '',
        '</details>',
      ].join('\n'),
    );
  });

  it("labels the order's issue with its batch's lane, made in the Brewery first (#406)", async () => {
    assert.equal(await runBrew(f.setup, shell(behave.succeed('Brewed')), request), 0);
    assert.deepStrictEqual(f.api.issue('acme/brewery', 12)?.labels, [
      'recipe:stout',
      'foedrum:awaiting-merge',
    ]);
    assert.ok(f.api.labels.get('acme/brewery')?.has('foedrum:awaiting-merge'));
  });

  it('prints the link to the status comment once it is made (#406)', async () => {
    assert.equal(await runBrew(f.setup, shell(behave.succeed('Brewed')), request), 0);
    const [comment] = f.api.comments.get('acme/brewery#12') ?? [];
    const link = `https://github.com/${f.setup.brewery}/issues/12#issuecomment-${comment?.id}`;
    const shown = f.lines.filter((line) => line === `foedrum brew: status comment: ${link}`);
    assert.equal(shown.length, 1, f.lines.join('\n'));
  });

  it('says about every 30 s which step runs and for how long (#406)', async () => {
    const controller = new AbortController();
    let now = t0;
    const running = behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0 });
    const ticking = shell(running, {
      signal: controller.signal,
      clock: () => now,
      wait: async () => {
        now = new Date(now.getTime() + 5_000);
        if (now.getTime() - t0.getTime() > 60_000) controller.abort();
      },
    });
    assert.equal(await runBrew(f.setup, ticking, request), 1);
    const progress = f.lines.filter((line) => line.includes('running for'));
    assert.deepStrictEqual(progress, [
      'foedrum brew: batch 12-1 brewing: brew #1 running for 30s',
      'foedrum brew: batch 12-1 brewing: brew #1 running for 1m 0s',
    ]);
  });

  const idle: AttemptProgress = { lastProgressAt: t0, turnsWithoutProgress: 0 };

  it('prints the same plain lines, waiting the whole tick, when the shell has no terminal, whatever the brewer reports (ADR 0174)', async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    let now = t0;
    const running = behave.hang({
      ...idle,
      turn: 14,
      lastTool: { name: 'Edit', word: 'src/a.ts' },
      denied: true,
    });
    const plain = shell(running, {
      signal: controller.signal,
      clock: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now = new Date(now.getTime() + ms);
        if (now.getTime() - t0.getTime() > 60_000) controller.abort();
      },
    });
    assert.equal(await runBrew(f.setup, plain, request), 1);
    assert.ok(waits.length > 0 && waits.every((ms) => ms === 5_000), waits.join(' '));
    assert.deepStrictEqual(
      f.lines.filter((line) => line.includes('running for')),
      [
        'foedrum brew: batch 12-1 brewing: brew #1 running for 30s',
        'foedrum brew: batch 12-1 brewing: brew #1 running for 1m 0s',
      ],
    );
    assert.ok(
      f.lines.every(
        (line) => line.startsWith('foedrum brew: ') && !/\bturn\b|\bdenied\b|Edit/.test(line),
      ),
      f.lines.join('\n'),
    );
  });

  it('prints every plain line byte for byte off a terminal, with no batch time (ADR 0179)', async () => {
    // Ordered five minutes before this run, so a batch time would differ from the attempt's.
    const ordered = new Date(t0.getTime() - 5 * 60_000);
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, ordered);
    const controller = new AbortController();
    let now = t0;
    const plain = shell(behave.hang({ ...idle, turn: 14 }), {
      signal: controller.signal,
      clock: () => now,
      wait: async (ms) => {
        now = new Date(now.getTime() + ms);
        if (now.getTime() - t0.getTime() > 60_000) controller.abort();
      },
    });
    assert.equal(await runBrew(f.setup, plain, request), 1);
    assert.deepStrictEqual(f.lines, [
      'foedrum brew: routed batch 12-1 to the recipe stout',
      'foedrum brew: brewing batch 12-1 as ann',
      'foedrum brew: status comment: https://github.com/Acme/Brewery/issues/12#issuecomment-1',
      'foedrum brew: batch 12-1 brewing: brew #1 started',
      'foedrum brew: batch 12-1 brewing: brew #1 running for 30s',
      'foedrum brew: batch 12-1 brewing: brew #1 running for 1m 0s',
      'foedrum brew: stopped; batch 12-1 brewing: brew #1 started',
    ]);
  });

  it('stops when a tick must stop the engine: another engine pushed the state branch (ADR 0027)', async () => {
    const stopping = shell(behave.succeed('Brewed'), {
      stateBranch: () => ({
        start: async () => ({ decision: 'ready' }),
        flush: async () => {
          throw new StateBranchStopError('the push was rejected: another engine wrote');
        },
      }),
    });
    assert.equal(await runBrew(f.setup, stopping, request), 1);
    assert.equal(f.lines.at(-1), 'foedrum brew: the push was rejected: another engine wrote');
    assert.equal(f.lock.held, false);
  });

  describe('with a live line on a terminal (ADR 0174)', () => {
    interface Live {
      /** How many seconds of the fake clock the brew runs before it is stopped. */
      seconds?: number;
      columns?: number | 'unknown';
      /** Runs inside each wait, with the number of waits so far. */
      onWait?: (waits: number, screen: ReturnType<typeof fakeScreen>) => void;
      runner?: BrewerRunner;
      /** What the state branch's flush answers, by the number of flushes so far. */
      flush?: (flushes: number) => FlushResult;
      /** Runs on the fresh store before the brew, to record what was there before it. */
      before?: () => void;
    }

    /** Brews with a terminal, a clock that only the waits move and a brewer that shows `progress`. */
    const brewLive = async (progress: AttemptProgress, more: Live = {}) => {
      const { seconds = 10, columns = 120, onWait, runner, flush, before } = more;
      // A test brews more than once: each brew gets the lock and the store of a fresh machine.
      f.lock = fakeLock('ann');
      f.store = { ...openSqliteEventStore(':memory:'), close: () => {} };
      before?.();
      const screen = fakeScreen(columns);
      const controller = new AbortController();
      const waits: number[] = [];
      let flushes = 0;
      let now = t0;
      const live = shell(behave.hang(progress), {
        terminal: screen.terminal,
        out: (line) => {
          f.lines.push(line);
          screen.print(line);
        },
        signal: controller.signal,
        clock: () => now,
        wait: async (ms) => {
          waits.push(ms);
          now = new Date(now.getTime() + ms);
          onWait?.(waits.length, screen);
          if (now.getTime() - t0.getTime() > seconds * 1000) controller.abort();
        },
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () => {
            flushes += 1;
            return flush?.(flushes) ?? { kind: 'unchanged' };
          },
        }),
        ...(runner === undefined ? {} : { runner: () => runner }),
      });
      const code = await runBrew(f.setup, live, request);
      return { code, screen, waits, flushes: () => flushes };
    };

    it('shows an attempt as step and attempt, elapsed time, turn and last tool, joined by " / "', async () => {
      const { code, screen } = await brewLive(
        { ...idle, turn: 14, lastTool: { name: 'Edit', word: 'src/schemas/primitives.ts' } },
        { seconds: 170 },
      );
      assert.equal(code, 1);
      assert.ok(
        screen.texts().includes('brew #1 / 2m 41s / turn 14 / Edit src/schemas/primitives.ts'),
        screen.texts().slice(-3).join('\n'),
      );
    });

    it("leads the line with the batch's time, counted from when it was ordered, before the attempts (ADR 0179)", async () => {
      const { screen } = await brewLive(
        { ...idle, turn: 14 },
        {
          seconds: 5,
          before: () => {
            const ordered = new Date(t0.getTime() - 5 * 60_000);
            log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, ordered);
          },
        },
      );
      const times = screen.batchTimes();
      assert.ok(times.length > 0, 'a live line is drawn');
      assert.ok(
        times.every((time) => /^5m \d+s$/.test(time)),
        times.join(' '),
      );
      assert.ok(times.includes('5m 3s'), times.join(' '));
      assert.ok(
        screen.rewrites().some((drawn) => /^. 5m 3s \/ brew #1 \/ \d+s \/ turn 14$/.test(drawn)),
        screen.rewrites().join('\n'),
      );
    });

    it("counts the batch's time from this brew's start for a batch ordered with no time (ADR 0179)", async () => {
      const { screen } = await brewLive(idle, {
        seconds: 5,
        before: () => {
          // A batch ordered before batch.ordered recorded when.
          const routeBy = new Date(t0.getTime() + 3_600_000).toISOString();
          const old = {
            type: 'batch.ordered',
            batchId: '12-1',
            order: { issue: 12 },
            routeBy,
          } as const;
          f.store.withTransaction((tx) => tx.append(old));
        },
      });
      const times = screen.batchTimes();
      assert.ok(times.length > 0, 'a live line is drawn');
      assert.ok(
        // Seconds since this run's start at t0, never the minutes of an earlier order.
        times.every((time) => /^\d+s$/.test(time)),
        times.join(' '),
      );
      // And it moves: a time pinned at 0s would also be no minutes.
      assert.ok(times.includes('3s'), times.join(' '));
    });

    it("shows a batch's time as 0s while the clock reads before its order (ADR 0179)", async () => {
      const { screen } = await brewLive(idle, {
        seconds: 3,
        before: () => {
          const ordered = new Date(t0.getTime() + 10 * 60_000);
          log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, ordered);
        },
      });
      const times = screen.batchTimes();
      assert.ok(times.length > 0, 'a live line is drawn');
      assert.ok(
        times.every((time) => time === '0s'),
        times.join(' '),
      );
    });

    it('counts the elapsed time as the plain lines do: whole seconds, then minutes from one', async () => {
      const { screen } = await brewLive({ ...idle, turn: 1 }, { seconds: 70 });
      const texts = screen.texts().map(withoutTime);
      assert.ok(texts.includes('brew #1 / turn 1'), texts.join('\n'));
      const times = screen.texts().map((text) => /^brew #1 \/ ((?:\d+m )?\d+s)/.exec(text)?.[1]);
      assert.ok(times.includes('59s'), times.join(' '));
      assert.ok(times.includes('1m 0s'), times.join(' '));
    });

    it('shows only the step, attempt and elapsed time for an attempt whose runner reports no brewer fields, as a check step does', async () => {
      const { screen } = await brewLive(idle, { seconds: 5 });
      const attempts = screen.texts().filter((text) => text.startsWith('brew'));
      assert.ok(attempts.length > 0, 'the attempt is shown');
      for (const text of attempts) assert.match(text, /^brew #1 \/ (\d+m )?\d+s$/);
    });

    it('shows setup in place of the turn and the tool while the setup of the repository runs', async () => {
      const { screen } = await brewLive({ ...idle, settingUp: true }, { seconds: 5 });
      const attempts = screen.texts().filter((text) => text.startsWith('brew'));
      assert.ok(attempts.length > 0, 'the attempt is shown');
      for (const text of attempts) assert.match(text, /^brew #1 \/ (\d+m )?\d+s \/ setup$/);
    });

    it('shows the last tool as its name and the one safe word the runner reduced it to, or the name alone', async () => {
      const cases: [{ name: string; word?: string } | undefined, string][] = [
        [{ name: 'Read', word: 'src/a.ts' }, 'brew #1 / turn 3 / Read src/a.ts'],
        [{ name: 'Read', word: 'outside' }, 'brew #1 / turn 3 / Read outside'],
        [{ name: 'Write', word: '(left out)' }, 'brew #1 / turn 3 / Write (left out)'],
        [{ name: 'Bash', word: 'git status' }, 'brew #1 / turn 3 / Bash git status'],
        [{ name: 'Grep' }, 'brew #1 / turn 3 / Grep'],
        [undefined, 'brew #1 / turn 3'],
      ];
      for (const [lastTool, expected] of cases) {
        const progress = { ...idle, turn: 3, ...(lastTool === undefined ? {} : { lastTool }) };
        const { screen } = await brewLive(progress, { seconds: 3 });
        const shown = screen.texts().map(withoutTime);
        assert.ok(shown.includes(expected), `${expected}\n${shown.join('\n')}`);
      }
    });

    it('adds denied after the last tool while the runner reports a denial, and not otherwise', async () => {
      const tool = { name: 'Bash', word: 'git push' };
      const held = await brewLive(
        { ...idle, turn: 3, lastTool: tool, denied: true },
        { seconds: 3 },
      );
      const heldTexts = held.screen.texts().map(withoutTime);
      assert.ok(
        heldTexts.includes('brew #1 / turn 3 / Bash git push / denied'),
        heldTexts.join('\n'),
      );
      const clear = await brewLive(
        { ...idle, turn: 3, lastTool: tool, denied: false },
        { seconds: 3 },
      );
      const clearTexts = clear.screen.texts().map(withoutTime);
      assert.ok(clearTexts.includes('brew #1 / turn 3 / Bash git push'), clearTexts.join('\n'));
      assert.ok(
        clearTexts.every((text) => !text.includes('denied')),
        clearTexts.join('\n'),
      );
    });

    it('shows every code point outside U+0020 to U+007E as an escape with four hex digits, the name of the tool and the path alike', async () => {
      const lastTool = { name: 'Ed⁦it\u0007\n\u007f', word: 'src/Ж/‮\u{1f600}.ts' };
      const { screen } = await brewLive({ ...idle, turn: 3, lastTool }, { seconds: 3 });
      const expected =
        'brew #1 / turn 3 / Ed\\u2066it\\u0007\\u000a\\u007f src/\\u0416/\\u202e\\ud83d\\ude00.ts';
      const shown = screen.texts().map(withoutTime);
      assert.ok(
        shown.some((text) => text.toLowerCase() === expected.toLowerCase()),
        shown.join('\n'),
      );
      for (const drawn of screen.rewrites()) assert.match(drawn, /^[ -~]*$/);
    });

    it('cuts the name of the tool to 64 characters before it escapes it', async () => {
      const plain = await brewLive(
        { ...idle, turn: 3, lastTool: { name: 'A'.repeat(100) } },
        { seconds: 3, columns: 500 },
      );
      assert.ok(
        plain.screen
          .texts()
          .map(withoutTime)
          .includes(`brew #1 / turn 3 / ${'A'.repeat(64)}`),
        plain.screen.texts().join('\n'),
      );
      const wide = await brewLive(
        { ...idle, turn: 3, lastTool: { name: 'é'.repeat(70) } },
        { seconds: 3, columns: 500 },
      );
      const escaped = '\\u00e9'.repeat(64);
      assert.ok(
        wide.screen.texts().map(withoutTime).includes(`brew #1 / turn 3 / ${escaped}`),
        wide.screen.texts().join('\n'),
      );
    });

    it('cuts the whole line, spinner included, to the width of the terminal less one, and to 79 when it is unknown', async () => {
      const lastTool = { name: 'Edit', word: 'x'.repeat(300) };
      const narrow = await brewLive({ ...idle, turn: 3, lastTool }, { seconds: 3, columns: 40 });
      const full = narrow.screen.rewrites().filter((drawn) => drawn.length >= 39);
      assert.ok(full.length > 0, 'a line fills the terminal');
      assert.ok(full.every((drawn) => drawn.length === 39));
      assert.ok(narrow.screen.rewrites().every((drawn) => drawn.length <= 39));
      // Cut from the end: the spinner and the batch's time stay (ADR 0179).
      assert.ok(
        full.every((drawn) => /^. \d+s \/ brew #1 \/ /.test(drawn)),
        full.join('\n'),
      );
      const cut = await brewLive({ ...idle, turn: 3, lastTool }, { seconds: 3, columns: 9 });
      assert.ok(
        cut.screen.rewrites().every((drawn) => /^. \d+s \/ b?$/.test(drawn)),
        cut.screen.rewrites().join('\n'),
      );
      const unknown = await brewLive(
        { ...idle, turn: 3, lastTool },
        { seconds: 3, columns: 'unknown' },
      );
      const lengths = unknown.screen.rewrites().map((drawn) => drawn.length);
      assert.equal(Math.max(...lengths), 79);
    });

    it('redraws at once when the terminal is resized, to its new width, and stops listening at the end', async () => {
      const lastTool = { name: 'Edit', word: 'x'.repeat(300) };
      let seen: { before: number; after: number; line: string | undefined } | undefined;
      const { screen } = await brewLive(
        { ...idle, turn: 3, lastTool },
        {
          seconds: 8,
          onWait: (waits, screen) => {
            if (waits !== 3) return;
            const before = screen.rewrites().length;
            screen.resize(30);
            seen = { before, after: screen.rewrites().length, line: screen.drawn() };
          },
        },
      );
      assert.ok(seen !== undefined && seen.after > seen.before, JSON.stringify(seen));
      assert.equal(seen.line?.length, 29);
      assert.equal(screen.resizers.size, 0);
    });

    it('redraws about once a second on the wait of the shell, while the tick stays every 5 s', async () => {
      const { screen, waits, flushes } = await brewLive(
        { ...idle, turn: 3 },
        { seconds: 30, columns: 120 },
      );
      assert.ok(waits.length > 0 && waits.every((ms) => ms <= 1_000), waits.join(' '));
      const drawn = screen.rewrites().length;
      assert.ok(drawn >= 25 && drawn <= 45, `${drawn} redraws in 30 s`);
      // A tick flushes the state branch once: every 5 s, not every redraw.
      assert.ok(flushes() >= 5 && flushes() <= 9, `${flushes()} ticks in 30 s`);
    });

    it('turns the spinner one frame at each redraw, through its four frames in order', async () => {
      const { screen } = await brewLive({ ...idle, turn: 3 }, { seconds: 20 });
      const frames = new Set<string>();
      let previous: string | undefined;
      let steps = 0;
      for (const event of screen.events) {
        if (!event.startsWith('rewrite: ')) {
          previous = undefined;
          continue;
        }
        const frame = event.charAt(9);
        frames.add(frame);
        if (previous !== undefined) {
          const next = SPINNER[(SPINNER.indexOf(previous) + 1) % SPINNER.length];
          assert.equal(frame, next, `after ${previous}`);
          steps += 1;
        }
        previous = frame;
      }
      assert.deepEqual([...frames].sort(), [...SPINNER].sort());
      assert.ok(steps >= 10, `${steps} steps`);
    });

    it('prints no 30 s progress line while it keeps a live line', async () => {
      const { screen } = await brewLive({ ...idle, turn: 3 }, { seconds: 70 });
      assert.ok(screen.rewrites().length > 0, 'a live line is drawn');
      assert.deepStrictEqual(
        f.lines.filter((line) => line.includes('running for')),
        [],
      );
    });

    it('clears the live line, prints a lasting line, and draws the live line again', async () => {
      const { screen } = await brewLive(
        { ...idle, turn: 3 },
        {
          seconds: 20,
          flush: (flushes) =>
            flushes === 3 ? { kind: 'failed', reason: 'offline' } : { kind: 'unchanged' },
        },
      );
      const at = screen.events.indexOf(
        'out: foedrum brew: the state branch was not pushed: offline',
      );
      assert.ok(at > 0, screen.events.join('\n'));
      assert.equal(screen.events[at - 1], 'clear');
      assert.ok(screen.events[at + 1]?.startsWith('rewrite: '), screen.events[at + 1]);
      assert.deepStrictEqual(screen.printedOver, []);
    });

    it('clears the live line before it exits when it is stopped, and leaves the last line of today', async () => {
      const { code, screen } = await brewLive({ ...idle, turn: 3 }, { seconds: 10 });
      assert.equal(code, 1);
      assert.ok(screen.rewrites().length > 0, 'a live line was drawn');
      assert.ok(f.lines.at(-1)?.startsWith('foedrum brew: stopped; '), f.lines.at(-1));
      assert.equal(screen.drawn(), undefined);
      assert.ok(!screen.events.at(-1)?.startsWith('rewrite: '), screen.events.at(-1));
    });

    it('shows the attempts of a parallel group on the one line, joined by " ; ", in the order of the plain lines', async () => {
      // Two Tasters' lens steps side by side (ADR 0168), on a batch routed to their recipe.
      const taster = brewer
        .replace('"name": "cellarman"', '"name": "taster"')
        .replace('"doc": "brew.md", "schema": "outDoc"', '"doc": "taste.md", "schema": "tasting"')
        .replace('"allow": ["Read", "Write"]', '"allow": ["Read"]')
        .replace('"produces": "commits"', '"produces": "report"')
        .replace('"access": "write"', '"access": "read"')
        .replace('"git": { "commit": true },', '');
      const tasting = JSON.stringify({
        name: 'tasting',
        description: 'Two lenses side by side.',
        testFirst: false,
        steps: [
          {
            id: 'tasting',
            parallel: [
              { id: 'security', brewer: 'taster', lens: 'plan/security' },
              { id: 'correctness', brewer: 'taster', lens: 'plan/correctness' },
            ],
          },
        ],
      });
      const inputs = serveInputs({
        files: { ...serveInputs().files, local: local({ workRoot: f.dir.path }) },
      });
      const { brewery } = inputs.files;
      const result = serveSetup({
        ...inputs,
        files: {
          ...inputs.files,
          brewery: {
            ...brewery,
            recipes: [...brewery.recipes, { path: 'recipes/tasting.jsonc', text: tasting }],
            brewers: [...brewery.brewers, { path: 'brewers/taster.md', text: taster }],
            lenses: [
              { path: 'lenses/plan/security.md', text: 'Security.' },
              { path: 'lenses/plan/correctness.md', text: 'Correctness.' },
            ],
          },
        },
      });
      f.setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
      f.api = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            {
              number: 12,
              labels: ['recipe:tasting'],
              author: 'ann',
              title: 'Taste',
              body: 'Both.',
            },
          ],
        },
      });
      const { screen } = await brewLive({ ...idle, turn: 3 }, { seconds: 5 });
      const times = / \/ (\d+m )?\d+s(?= \/|$| ;)/g;
      const shown = screen.texts().map((text) => text.replace(times, ''));
      assert.ok(shown.includes('security #1 / turn 3 ; correctness #1 / turn 3'), shown.join('\n'));
      assert.ok(
        f.lines.some((line) => line.includes('security #1') && line.includes('correctness #1')),
        f.lines.join('\n'),
      );
    });

    it('draws no line with only its spinner: once no attempt runs, the live line is cleared', async () => {
      // The brew attempt runs for six redraws, then ends; the pull request step runs no attempt.
      const inner = fakeBrewerRunner(() => behave.succeed('Brewed'));
      let release: () => void = () => {};
      const released = new Promise<void>((done) => {
        release = done;
      });
      const runner: BrewerRunner = {
        start: (attempt) => {
          const run = inner.start(attempt);
          return { ended: released.then(() => run.ended), stop: run.stop };
        },
        progress: () => ({ ...idle, turn: 3 }),
      };
      const { code, screen, waits } = await brewLive(
        { ...idle, turn: 3 },
        {
          seconds: 300,
          runner,
          onWait: (count) => {
            if (count === 6) release();
          },
        },
      );
      assert.equal(code, 0, f.lines.join('\n'));
      assert.ok(waits.length > 6, `${waits.length} waits: brew went on after the attempt ended`);
      assert.ok(screen.rewrites().length > 0, 'a live line was drawn');
      for (const text of screen.texts()) assert.match(text, /^brew #1 \/ /);
    });

    it('clears the live line before it exits, whatever the exit code', async () => {
      const exits: [string, ReturnType<typeof behave.succeed>, number][] = [
        ['on tap', behave.succeed('Brewed'), 0],
        ['needs input', behave.needInput(), 4],
      ];
      for (const [name, ending, exitCode] of exits) {
        f.lines.length = 0;
        const inner = fakeBrewerRunner(() => ending);
        let release: () => void = () => {};
        const released = new Promise<void>((done) => {
          release = done;
        });
        let over = false;
        const runner: BrewerRunner = {
          start: (attempt) => {
            const run = inner.start(attempt);
            const ended = released
              .then(() => run.ended)
              .then((end) => {
                over = true;
                return end;
              });
            return { ended, stop: run.stop };
          },
          progress: () => (over ? undefined : { ...idle, turn: 3 }),
        };
        const { code, screen } = await brewLive(
          { ...idle, turn: 3 },
          {
            seconds: 300,
            runner,
            onWait: (waits) => {
              if (waits === 6) release();
            },
          },
        );
        assert.equal(code, exitCode, `${name}: ${f.lines.join('\n')}`);
        assert.ok(screen.rewrites().length >= 5, `${name}: a live line was drawn`);
        assert.equal(screen.drawn(), undefined, name);
        assert.ok(
          !screen.events.at(-1)?.startsWith('rewrite: '),
          `${name}: ${screen.events.at(-1)}`,
        );
        assert.deepStrictEqual(screen.printedOver, [], name);
      }
    });
  });

  it('refuses a batch another driver leases, naming it and when its lease ends: exit 5', async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log().issue(
      { kind: 'route', batchId: '12-1', recipe: 'stout', reason: 'label', source: 'label' },
      t0,
    );
    const expiresAt = new Date(t0.getTime() + 60_000);
    f.store.withTransaction((tx) =>
      tx.putBatchLease({ batchId: '12-1', owner: 'cellar', expiresAt }),
    );
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), request), 5);
    assert.deepStrictEqual(f.started, []);
    assert.equal(
      f.lines.at(-1),
      `foedrum brew: batch 12-1 is driven by cellar until ${expiresAt.toISOString()}`,
    );
    assert.equal(leaseOf()?.owner, 'cellar');
    assert.equal(f.lock.held, false);
  });

  it('stops with the questions, numbered as foedrum answer takes them, when the batch needs input: exit 4', async () => {
    const second: Question = {
      q: 'Which flag name?',
      options: ['--json', '--format=json'],
      recommended: '--json',
      whyBlocking: 'Scripts will depend on it',
    };
    assert.equal(await runBrew(f.setup, shell(behave.needInput([question, second])), request), 4);
    assert.deepStrictEqual(f.lines.slice(-6), [
      'foedrum brew: batch 12-1 needs input at brew:',
      'foedrum brew:   1. Which database should the cache use? (sqlite, redis; recommended: sqlite)',
      'foedrum brew:      why it blocks: The two need different migrations',
      'foedrum brew:   2. Which flag name? (--json, --format=json; recommended: --json)',
      'foedrum brew:      why it blocks: Scripts will depend on it',
      'foedrum brew: answer them in order with foedrum answer 12-1 <answer 1> <answer 2>, then brew again',
    ]);
    // The batch stays this driver's while its engineer answers (ADR 0044); the lock goes.
    assert.equal(leaseOf()?.owner, 'ann');
    assert.equal(f.lock.held, false);
  });

  it('refuses an issue it cannot route, ordering nothing: exit 5', async () => {
    const unlabelled = { ...request, target: { issue: 13 } };
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), unlabelled), 5);
    assert.equal(log().state().batches.size, 0);
    assert.equal(
      f.lines.at(-1),
      'foedrum brew: #13 has no recipe:<name> label; label it with the recipe to brew it with',
    );
  });

  it('ends with the refusal once a pause that came while it brews holds the batch and nothing runs: exit 5 (ADR 0202)', async () => {
    let paused = false;
    let ticks = 0;
    const pausing = shell(behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0 }), {
      wait: async () => {
        ticks++;
        if (ticks > 20) assert.fail(`brew did not stop:\n${f.lines.join('\n')}`);
        if (paused) return;
        paused = true;
        // Paused with --by now: the next tick stops brew#1, and its retry waits.
        const stopAt = { at: t0, zone: 'UTC' };
        log().issue(
          { kind: 'pause', order: { issue: 12 }, by: 'ann', via: 'terminal', stopAt },
          t0,
        );
      },
    });
    assert.equal(await runBrew(f.setup, pausing, request), 5);
    assert.equal(f.lines.at(-1), 'foedrum brew: #12 is paused; foedrum continue #12 lets it brew');
    assert.deepStrictEqual(f.started, ['brew#1']);
  });

  it('names the order to continue when a sub-order is held by its paused order: exit 5 (ADR 0202)', async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    const subOrders = [{ issue: 30, repo: 'acme/web' }];
    const decomposed = {
      type: 'order.decomposed',
      batchId: '12-1',
      subOrders,
      dependencies: [],
    } as const;
    log().issue({ kind: 'record', event: { ...decomposed, subOrders, dependencies: [] } }, t0);
    log().issue(
      { kind: 'order', batchId: '30-1', order: { issue: 30 }, parentBatchId: '12-1' },
      t0,
    );
    log().issue({ kind: 'pause', order: { issue: 12 }, by: 'ann', via: 'terminal' }, t0);
    const sub = { ...request, target: { issue: 30 } };
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), sub), 5);
    assert.equal(
      f.lines.at(-1),
      'foedrum brew: #30 is a sub-order of #12, which is paused; foedrum continue #12 lets it brew',
    );
  });

  it('refuses a paused order, ordering nothing: exit 5 (ADR 0202)', async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log().issue({ kind: 'pause', order: { issue: 12 }, by: 'ann', via: 'terminal' }, t0);
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), request), 5);
    assert.equal(f.lines.at(-1), 'foedrum brew: #12 is paused; foedrum continue #12 lets it brew');
    assert.deepStrictEqual(f.started, []);
  });

  it('refuses any issue while the Brewery is paused, ordering nothing: exit 5 (ADR 0202)', async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log().issue({ kind: 'pause', by: 'ann', via: 'terminal' }, t0);
    const other = { ...request, target: { issue: 13 } };
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), other), 5);
    assert.equal(
      f.lines.at(-1),
      'foedrum brew: the Brewery is paused; foedrum continue --all lets it brew',
    );
    assert.equal(log().state().batches.size, 1);
    assert.deepStrictEqual(f.started, []);
  });

  it('refuses an issue whose latest batch ended: ordering it again is foedrum order: exit 5', async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log().issue({ kind: 'cancel', batchId: '12-1', by: 'ann', via: 'terminal' }, t0);
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), request), 5);
    assert.equal(
      f.lines.at(-1),
      'foedrum brew: batch 12-1 of #12 is cancelled; foedrum order #12 orders it again',
    );
  });

  it('stops with the reason and the options when the batch is Stuck on anything but questions: exit 3', async () => {
    const blocked = behave.blocked('findings', 'The tests fail');
    assert.equal(await runBrew(f.setup, shell(blocked), request), 3);
    assert.match(
      f.lines.at(-1) ?? '',
      /^foedrum brew: batch 12-1 is stuck: blocked at brew \(findings\): The tests fail; reminder [^;]+; options: retry, /,
    );
  });

  it("refuses when its owner's lock is held, opening nothing: exit 5", async () => {
    const held = shell(behave.succeed(), {
      lock: () => {
        throw new Error('The driver ann already runs on this work root');
      },
      openStore: () => assert.fail('no store is opened'),
    });
    assert.equal(await runBrew(f.setup, held, request), 5);
    assert.equal(f.lines.at(-1), 'foedrum brew: The driver ann already runs on this work root');
  });

  it("names --as when its owner's driver already runs, as a second terminal meets it (ADR 0259)", async () => {
    const held = shell(behave.succeed(), {
      lock: () => {
        throw new DriverRunningError('terminal', 'driver-terminal.lock', undefined);
      },
      openStore: () => assert.fail('no store is opened'),
    });
    assert.equal(await runBrew(f.setup, held, { ...request, owner: 'terminal' }), 5);
    assert.match(
      f.lines.at(-1) ?? '',
      /^foedrum brew: The driver terminal already runs .*give --as <name> to run another driver beside it$/,
    );
  });

  it('refuses an alias of no repository with an intake, before it takes the lock: exit 5', async () => {
    const target = { alias: 'web', issue: 7 };
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), { ...request, target }), 5);
    assert.deepStrictEqual(f.locked, []);
    assert.equal(
      f.lines.at(-1),
      'foedrum brew: foedrum.jsonc names no repository with the alias web and an intake',
    );
  });

  it('refuses an issue with two recipe labels, ordering nothing: exit 5', async () => {
    const two = { ...request, target: { issue: 14 } };
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), two), 5);
    assert.equal(log().state().batches.size, 0);
    assert.equal(
      f.lines.at(-1),
      'foedrum brew: #14 carries recipe:stout and recipe:porter; give it one recipe label',
    );
  });

  it('says where it left the batch when it is stopped, and stops its run: exit 1', async () => {
    const controller = new AbortController();
    const running = behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0 });
    const stopped = shell(running, {
      signal: controller.signal,
      wait: async () => controller.abort(),
    });
    assert.equal(await runBrew(f.setup, stopped, request), 1);
    assert.equal(f.lines.at(-1), 'foedrum brew: stopped; batch 12-1 brewing: brew #1 started');
    assert.equal(f.stops.length, 1, 'the hung run was stopped');
    assert.equal(f.lock.held, false);
  });

  it('holds the machine awake from the start of its attempt to its end, and lets the hold go when it stops (ADR 0195)', async () => {
    const held: string[] = [];
    const awake = {
      attemptStarted: () => held.push(`started with ${f.started.length} brewer attempts begun`),
      attemptEnded: () => held.push('ended'),
      release: () => held.push('released'),
    };
    assert.equal(await runBrew(f.setup, shell(behave.succeed(), { awake }), request), 0);
    assert.deepStrictEqual(held, ['started with 0 brewer attempts begun', 'ended', 'released']);
  });

  it('lets the hold go when it is stopped while its attempt runs (ADR 0195)', async () => {
    const held: string[] = [];
    const awake = {
      attemptStarted: () => held.push('started'),
      attemptEnded: () => held.push('ended'),
      release: () => held.push('released'),
    };
    const controller = new AbortController();
    const running = behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0 });
    const stopped = shell(running, {
      signal: controller.signal,
      wait: async () => controller.abort(),
      awake,
    });
    assert.equal(await runBrew(f.setup, stopped, request), 1);
    assert.deepStrictEqual(held.slice(0, 1), ['started']);
    assert.equal(held.at(-1), 'released');
  });

  it('lets the hold go when closing its store fails (ADR 0195)', async () => {
    const held: string[] = [];
    const awake = {
      attemptStarted: () => held.push('started'),
      attemptEnded: () => held.push('ended'),
      release: () => held.push('released'),
    };
    const failing = {
      ...f.store,
      close: () => {
        throw new Error('the store did not close');
      },
    };
    await assert.rejects(
      runBrew(f.setup, shell(behave.succeed(), { awake, openStore: () => failing }), request),
      /the store did not close/,
    );
    assert.equal(held.at(-1), 'released');
  });

  it("holds the machine awake through a check step's attempt too (ADR 0195)", async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log().issue(
      { kind: 'route', batchId: '12-1', recipe: 'porter', reason: 'label', source: 'label' },
      t0,
    );
    const held: string[] = [];
    const awake = {
      attemptStarted: () => held.push('started'),
      attemptEnded: () => held.push('ended'),
      release: () => held.push('released'),
    };
    // The porter recipe's green step runs the repository's test check.
    const exec = async () => {
      held.push('check runs');
      return { exitCode: 0, stdout: '', stderr: '', output: '' };
    };
    assert.equal(
      await runBrew(f.setup, shell(behave.succeed(), { awake, exec }), request),
      0,
      f.lines.join('\n'),
    );
    assert.deepStrictEqual(held, [
      'started',
      'ended',
      'started',
      'check runs',
      'ended',
      'released',
    ]);
  });

  it('drives its batch alone, leaving a lease its owner holds of another batch to lapse (ADR 0123)', async () => {
    // A batch this owner left Stuck in an earlier brew, its lease still live.
    const expiresAt = new Date(t0.getTime() + 60_000);
    f.store.withTransaction((tx) => tx.putBatchLease({ batchId: '13-1', owner: 'ann', expiresAt }));
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), request), 0);
    const other = f.store.batchLeases(t0).find(({ batchId }) => batchId === '13-1');
    assert.deepStrictEqual(other, { batchId: '13-1', owner: 'ann', expiresAt });
  });

  it('drives on when another writer routed the Ordered batch while brew read its label: exit 0', async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    const route = {
      kind: 'route',
      batchId: '12-1',
      recipe: 'stout',
      reason: 'label',
      source: 'label',
    } as const;
    // The Cellar's intake routes the batch while brew reads the issue's label.
    const racing: typeof globalThis.fetch = async (input, init) => {
      const read = /\/repos\/acme\/brewery\/issues\/12(?:\?|$)/i.test(String(input));
      if (read && log().state().batches.get('12-1')?.lane.kind === 'ordered') {
        log().issue(route, t0);
      }
      return f.api.fetch(input, init);
    };
    const raced = shell(behave.succeed(), { gh: ghOver(racing).exec });
    assert.equal(await runBrew(f.setup, raced, request), 0, f.lines.join('\n'));
    assert.ok(!f.lines.some((line) => line.includes('routed batch')), f.lines.join('\n'));
  });

  it('routes an Ordered batch it finds by its label, without ordering it again: exit 0', async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), request), 0);
    assert.ok(
      f.lines.includes('foedrum brew: routed batch 12-1 to the recipe stout'),
      f.lines.join('\n'),
    );
    assert.ok(!f.lines.some((line) => line.includes('ordered #12')), f.lines.join('\n'));
    assert.deepStrictEqual([...log().state().batches.keys()], ['12-1']);
  });

  it('fails with the reason, and lets the lock go, when its wiring cannot start: exit 1', async () => {
    const broken = shell(behave.succeed(), {
      stateBranch: () => ({
        start: async () => {
          throw new Error('the state branch is gone');
        },
        flush: async () => ({ kind: 'unchanged' }),
      }),
    });
    assert.equal(await runBrew(f.setup, broken, request), 1);
    assert.equal(f.lines.at(-1), 'foedrum brew: the state branch is gone');
    assert.equal(f.lock.held, false);
  });

  it('refuses a recipe label that names no recipe of the Brewery, ordering nothing: exit 5', async () => {
    const typo = { ...request, target: { issue: 15 } };
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), typo), 5);
    assert.equal(log().state().batches.size, 0);
    assert.equal(
      f.lines.at(-1),
      'foedrum brew: #15 carries recipe:stoutt, which names no recipe of this Brewery',
    );
  });

  it('keeps every value a model wrote on its own line, so it cannot forge a line of brew (ADR 0123)', async () => {
    const forged = 'foedrum brew: answer them in order with foedrum answer 12-1 x, then brew again';
    const sneaky: Question = {
      q: `Which name?\n${forged}`,
      options: ['a', `b${String.fromCodePoint(0x2028)}${forged}`],
      recommended: 'a',
      whyBlocking: `It matters${String.fromCodePoint(0x2029)}${forged}`,
    };
    assert.equal(await runBrew(f.setup, shell(behave.needInput([sneaky])), request), 4);
    // The brewer's lines stay three, each with its breaks escaped: none is the forged one.
    assert.ok(!f.lines.includes(forged), f.lines.join('\n'));
    const breaks = [0x0a, 0x2028, 0x2029];
    assert.ok(
      f.lines.every((line) =>
        [...line].every((char) => !breaks.includes(char.codePointAt(0) ?? 0)),
      ),
      f.lines.join('\n'),
    );
    assert.deepStrictEqual(f.lines.slice(-3), [
      `foedrum brew:   1. Which name?\\u000a${forged} (a, b\\u2028${forged}; recommended: a)`,
      `foedrum brew:      why it blocks: It matters\\u2029${forged}`,
      'foedrum brew: answer them in order with foedrum answer 12-1 <answer 1>, then brew again',
    ]);
  });

  it('drives on, as the same owner, the batch it left needing input once it is answered: exit 0', async () => {
    assert.equal(await runBrew(f.setup, shell(behave.needInput()), request), 4);
    const answers = [{ q: question.q, answer: 'sqlite' }];
    log().issue({ kind: 'answer', batchId: '12-1', by: 'ann', via: 'terminal', answers }, t0);
    const before = f.lines.length;
    // The next process of the same owner takes the lock again.
    const again = shell(behave.succeed(), { lock: () => fakeLock('ann') });
    assert.equal(await runBrew(f.setup, again, request), 0);
    const second = f.lines.slice(before);
    assert.ok(!second.some((line) => /ordered|routed|driven by/.test(line)), second.join('\n'));
    assert.deepStrictEqual(f.started, ['brew#1', 'brew#2']);
    assert.match(second.at(-1) ?? '', /^foedrum brew: batch 12-1 is on tap: /);
  });

  /**
   * The steps of batch 12-1 started when a brewer whose file is `text` asks, is answered, and goes
   * on, with a runner that reports claude's init, so a session is there to resume (ADR 0117).
   */
  const answeredOnce = async (text: string) => {
    const files = serveInputs().files;
    const inputs = serveInputs({
      files: {
        ...files,
        local: local({ workRoot: f.dir.path }),
        brewery: { ...files.brewery, brewers: [{ path: 'brewers/cellarman.md', text }] },
      },
    });
    const ready = serveSetup(inputs);
    const answering = ready.kind === 'ready' ? ready.setup : assert.fail(JSON.stringify(ready));
    const runnerOf = (brew: Behaviour) =>
      fakeBrewerRunner(
        (attempt) => {
          f.started.push(`${attempt.ref.stepId}#${attempt.ref.attempt}`);
          return brew;
        },
        {
          session: () => ({ sessionId: 's', model: 'claude-haiku-5-5', claudeVersion: '2.1.301' }),
        },
      );
    const asking = shell(behave.needInput(), { runner: () => runnerOf(behave.needInput()) });
    assert.equal(await runBrew(answering, asking, request), 4);
    const answers = [{ q: question.q, answer: 'sqlite' }];
    log().issue({ kind: 'answer', batchId: '12-1', by: 'ann', via: 'terminal', answers }, t0);
    const again = shell(behave.succeed(), {
      lock: () => fakeLock('ann'),
      runner: () => runnerOf(behave.succeed()),
    });
    assert.equal(await runBrew(answering, again, request), 0);
    return f.store
      .eventsAfter(0)
      .flatMap(({ event }) => (event.type === 'step.started' ? [event] : []));
  };

  it('resumes the session of a brewer with retryMode resume once its questions are answered, in its worktree (#327, ADR 0118)', async () => {
    const resuming = brewer.replace(
      '"maxAttempts": 1',
      '"maxAttempts": 1,\n  "retryMode": "resume"',
    );
    const [first, second] = await answeredOnce(resuming);
    assert.equal(second?.attempt, 2);
    assert.deepStrictEqual(second.session, {
      id: first?.session?.id,
      resumes: first?.session?.id,
      worktree: first?.worktree?.path,
    });
    assert.equal(second.worktree, undefined);
  });

  it('starts the answered attempt of a brewer with retryMode fresh in a session and worktree of its own (ADR 0118)', async () => {
    const [first, second] = await answeredOnce(brewer);
    assert.equal(second?.attempt, 2);
    assert.equal(second.session?.resumes, undefined);
    assert.notEqual(second.session?.id, first?.session?.id);
    assert.ok(second.worktree !== undefined);
    assert.notEqual(second.worktree.path, first?.worktree?.path);
  });

  it('stops with who cancelled the batch when it is cancelled while it brews: exit 6', async () => {
    let waits = 0;
    const running = behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0 });
    const cancelled = shell(running, {
      wait: async () => {
        waits++;
        if (waits === 1) {
          log().issue({ kind: 'cancel', batchId: '12-1', by: 'bob', via: 'terminal' }, t0);
        }
        if (waits > 20) assert.fail(`brew did not stop:\n${f.lines.join('\n')}`);
      },
    });
    assert.equal(await runBrew(f.setup, cancelled, request), 6);
    assert.equal(f.lines.at(-1), 'foedrum brew: batch 12-1 was cancelled by bob via terminal');
  });

  it('refuses the batch, naming its new driver, when another driver takes it while it brews: exit 5', async () => {
    const expiresAt = new Date(t0.getTime() + 60_000);
    const running = behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0 });
    const taken = shell(running, {
      wait: async () => {
        // The lease of a driver that took the batch, as an expired lease of this one would let it.
        f.store.withTransaction((tx) =>
          tx.putBatchLease({ batchId: '12-1', owner: 'cellar', expiresAt }),
        );
      },
    });
    assert.equal(await runBrew(f.setup, taken, request), 5);
    assert.equal(
      f.lines.at(-1),
      `foedrum brew: batch 12-1 is driven by cellar until ${expiresAt.toISOString()}`,
    );
  });

  it('records the end of the run it stops when the batch is taken over to resume its step, before it refuses the batch (ADR 0127)', async () => {
    // A run whose stop ends it a wait later, as a process tree takes a moment to go.
    let ending: (() => void) | undefined;
    const runner = {
      start: ({ ref }: { ref: { stepId: string; attempt: number } }) => {
        f.started.push(`${ref.stepId}#${ref.attempt}`);
        let settle: (end: { ending: { kind: 'cancelled' } }) => void = () => {};
        const ended = new Promise<{ ending: { kind: 'cancelled' } }>((resolve) => {
          settle = resolve;
        });
        return {
          ended,
          stop: () => {
            ending = () => settle({ ending: { kind: 'cancelled' } });
          },
        };
      },
      progress: () => ({ lastProgressAt: t0, turnsWithoutProgress: 0 }),
    };
    let waits = 0;
    const taken = shell(behave.succeed(), {
      runner: () => runner,
      wait: async () => {
        waits++;
        if (waits === 1) {
          const handover = { batchId: '12-1', owner: 'bob', by: 'bob', via: 'terminal' } as const;
          takeOver(log(), { ...handover, now: t0, leaseMs: 300_000, resumes: 'brew' });
        }
        ending?.();
        if (waits > 20) assert.fail(`brew did not stop:\n${f.lines.join('\n')}`);
      },
    });
    assert.equal(await runBrew(f.setup, taken, request), 5);
    assert.ok(
      f.store
        .eventsAfter(0)
        .some(({ event }) => event.type === 'step.finished' && event.stepId === 'brew'),
      'the stopped brew#1 is recorded',
    );
    assert.deepStrictEqual(f.store.currentLeases(t0), [], 'and its lease let go');
    assert.equal(
      f.lines.at(-1)?.startsWith('foedrum brew: batch 12-1 is driven by bob until'),
      true,
    );
  });

  /**
   * brew with a run its stop never ends, taken over to bob in its first wait (resuming brew when
   * `resumes` says so), on a clock a minute further on each wait; the waits it took.
   */
  const takenWithEndlessRun = async (
    resumes: boolean,
    after: () => void = () => {},
  ): Promise<number> => {
    let now = t0;
    let waits = 0;
    const endless = behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0 });
    const runner = fakeBrewerRunner(() => endless);
    const taken = shell(behave.succeed(), {
      runner: () => ({
        ...runner,
        start: (attempt) => ({ ...runner.start(attempt), stop: () => {} }),
      }),
      clock: () => now,
      wait: async () => {
        waits++;
        if (waits === 1) {
          const handover = { batchId: '12-1', owner: 'bob', by: 'bob', via: 'terminal' } as const;
          const request = { ...handover, now, leaseMs: 300_000 };
          takeOver(log(), resumes ? { ...request, resumes: 'brew' } : request);
          after();
        }
        now = new Date(now.getTime() + 60_000);
        if (waits > 20) assert.fail(`brew did not stop:\n${f.lines.join('\n')}`);
      },
    });
    assert.equal(await runBrew(f.setup, taken, request), 5);
    return waits;
  };

  it('waits at most a lease for the runs it stopped to end before it refuses the batch (ADR 0127)', async () => {
    const waits = await takenWithEndlessRun(true);
    assert.ok(waits >= 5 && waits <= 7, `${waits} waits`);
  });

  it('keeps redrawing the live line each second while it waits for the runs it stopped (ADR 0174, ADR 0127)', async () => {
    const screen = fakeScreen(120);
    let now = t0;
    const waits: number[] = [];
    let drawnAtTakeover = 0;
    const endless = behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0, turn: 3 });
    const runner = fakeBrewerRunner(() => endless);
    const taken = shell(behave.succeed(), {
      terminal: screen.terminal,
      runner: () => ({
        ...runner,
        start: (attempt) => ({ ...runner.start(attempt), stop: () => {} }),
      }),
      clock: () => now,
      wait: async (ms) => {
        waits.push(ms);
        if (waits.length === 1) {
          const handover = { batchId: '12-1', owner: 'bob', by: 'bob', via: 'terminal' } as const;
          takeOver(log(), { ...handover, now, leaseMs: 300_000, resumes: 'brew' });
          drawnAtTakeover = screen.rewrites().length;
        }
        now = new Date(now.getTime() + 1_000);
        if (waits.length > 400) assert.fail(`brew did not stop:\n${f.lines.join('\n')}`);
      },
    });
    assert.equal(await runBrew(f.setup, taken, request), 5);
    assert.ok(waits.length > 5, `${waits.length} waits`);
    assert.ok(
      waits.every((ms) => ms <= 1_000),
      waits.join(' '),
    );
    assert.ok(screen.rewrites().length >= drawnAtTakeover + 200, `${screen.rewrites().length}`);
    assert.equal(screen.drawn(), undefined);
  });

  it('ticks every five redraws on a terminal even when the clock steps back (ADR 0174)', async () => {
    const screen = fakeScreen(120);
    const controller = new AbortController();
    let now = t0;
    let waits = 0;
    let flushes = 0;
    const taken = shell(behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0, turn: 3 }), {
      terminal: screen.terminal,
      signal: controller.signal,
      clock: () => now,
      wait: async (ms) => {
        waits++;
        // The machine's clock is set back ten minutes in the second redraw.
        now = new Date(now.getTime() + ms - (waits === 2 ? 600_000 : 0));
        if (waits >= 30) controller.abort();
      },
      stateBranch: () => ({
        start: async () => ({ decision: 'ready' }),
        flush: async () => {
          flushes += 1;
          return { kind: 'unchanged' };
        },
      }),
    });
    assert.equal(await runBrew(f.setup, taken, request), 1);
    assert.ok(flushes >= 5, `${flushes} ticks in ${waits} redraws`);
  });

  it('refuses at once a batch taken over to resume no step, waiting for no run (ADR 0124)', async () => {
    assert.equal(await takenWithEndlessRun(false), 1);
  });

  it('refuses at once a batch whose resuming owner let it go to another driver (ADR 0127)', async () => {
    const until = new Date(t0.getTime() + 600_000);
    const third = () =>
      f.store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: '12-1', owner: 'session-7', expiresAt: until }),
      );
    assert.equal(await takenWithEndlessRun(true, third), 1);
  });

  it('goes on recording the end of the run it stopped when a tick fails while it waits (ADR 0127)', async () => {
    // The two ticks after the takeover fail: the main loop's, then the first of the wait's.
    let failing = 0;
    const inner = f.store;
    f.store = {
      ...inner,
      withTransaction: (fn) => {
        if (failing > 0) {
          failing--;
          throw new Error('the store is busy');
        }
        return inner.withTransaction(fn);
      },
    };
    let waits = 0;
    const running = behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0 });
    const taken = shell(running, {
      wait: async () => {
        waits++;
        if (waits === 1) {
          const handover = { batchId: '12-1', owner: 'bob', by: 'bob', via: 'terminal' } as const;
          takeOver(log(), { ...handover, now: t0, leaseMs: 300_000, resumes: 'brew' });
          failing = 2;
        }
        if (waits > 20) assert.fail(`brew did not stop:\n${f.lines.join('\n')}`);
      },
    });
    assert.equal(await runBrew(f.setup, taken, request), 5, f.lines.join('\n'));
    assert.ok(
      inner
        .eventsAfter(0)
        .some(({ event }) => event.type === 'step.finished' && event.stepId === 'brew'),
      'the stopped brew#1 is recorded',
    );
  });

  describe('--take (ADR 0124)', () => {
    const takes: BrewRequest = { ...request, take: true };
    const cellarUntil = new Date(t0.getTime() + 60_000);
    // Ordered, so brew reads its label before it takes the batch over.
    beforeEach(() => {
      log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
      f.store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: '12-1', owner: 'cellar', expiresAt: cellarUntil }),
      );
    });

    it('takes the batch over from the driver that holds it, records who did, and brews it', async () => {
      // The clock moves on a minute per wait, so the effects' wait for the Cellar's lease ends.
      let now = t0;
      const moving = shell(behave.succeed(), {
        clock: () => now,
        wait: async () => {
          now = new Date(now.getTime() + 60_000);
        },
      });
      assert.equal(await runBrew(f.setup, moving, takes), 0);
      const handovers = f.store
        .eventsAfter(0)
        .map(({ event }) => event)
        .filter((event) => event.type === 'batch.taken_over');
      assert.deepStrictEqual(handovers, [
        {
          type: 'batch.taken_over',
          batchId: '12-1',
          by: 'ann',
          via: 'terminal',
          from: 'cellar',
          to: 'ann',
          until: cellarUntil.toISOString(),
        },
      ]);
      assert.ok(
        f.lines.includes('foedrum brew: took batch 12-1 over from cellar'),
        f.lines.join('\n'),
      );
      assert.equal(f.started.length > 0, true);
    });

    it('takes nothing over when it refuses the batch for its labels: exit 5', async () => {
      log().issue({ kind: 'order', batchId: '14-1', order: { issue: 14 } }, t0);
      f.store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: '14-1', owner: 'cellar', expiresAt: cellarUntil }),
      );
      const two = { ...takes, target: { issue: 14 } };
      assert.equal(await runBrew(f.setup, shell(behave.succeed()), two), 5);
      assert.ok(!f.store.eventsAfter(0).some(({ event }) => event.type === 'batch.taken_over'));
      assert.equal(
        f.store.batchLeases(t0).find(({ batchId }) => batchId === '14-1')?.owner,
        'cellar',
      );
    });

    /** serve's shell whose gh read of issue 12, for its labels, does `meanwhile` first. */
    const readingLabels = (meanwhile: () => void): Partial<ServeShell> => {
      const gh = ghOver(f.api.fetch).exec;
      return {
        gh: (...args: Parameters<typeof gh>) => {
          if (JSON.stringify(args).includes('issues/12')) meanwhile();
          return gh(...args);
        },
      };
    };

    it("brews on, taking nothing over, when the holder's lease lapsed while it read the labels: exit 0", async () => {
      const lapsed = readingLabels(() =>
        f.store.withTransaction((tx) => tx.releaseBatchLease('12-1')),
      );
      assert.equal(await runBrew(f.setup, shell(behave.succeed(), lapsed), takes), 0);
      assert.ok(!f.store.eventsAfter(0).some(({ event }) => event.type === 'batch.taken_over'));
    });

    it('refuses with the reason, leaving the lease, when the takeover is refused while the holder still holds it: exit 5', async () => {
      const cancelled = readingLabels(() => {
        log().issue({ kind: 'cancel', batchId: '12-1', by: 'bob', via: 'terminal' }, t0);
      });
      assert.equal(await runBrew(f.setup, shell(behave.succeed(), cancelled), takes), 5);
      assert.equal(
        f.lines.at(-1),
        'foedrum brew: batch 12-1 is cancelled; take over needs it ordered, brewing, conditioning or stuck',
      );
      assert.equal(leaseOf()?.owner, 'cellar');
    });

    it('brews as before when no other driver holds the batch, recording no handover', async () => {
      f.store.withTransaction((tx) => tx.releaseBatchLease('12-1'));
      assert.equal(await runBrew(f.setup, shell(behave.succeed()), takes), 0);
      assert.ok(!f.store.eventsAfter(0).some(({ event }) => event.type === 'batch.taken_over'));
    });
  });
});
