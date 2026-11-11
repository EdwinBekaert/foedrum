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
import type { ServeShell } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { takeOver } from '../../src/engine/batch-leases.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { DriverRunningError } from '../../src/engine/driver-lock.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import { launchProcess } from '../../src/platform/processes.ts';
import { BrewCommand, type LauterCommand, MashCommand } from '../../src/schemas/commands.ts';
import type { Question } from '../../src/schemas/step-outcome.ts';
import { brewFixture, idle, request, t0 } from '../helpers/brew-fixture.ts';
import {
  type Behaviour,
  behave,
  fakeBrewerRunner,
  question,
} from '../helpers/fake-brewer-runner.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { aborted, fakeScreen } from '../helpers/fake-screen.ts';
import { brewer, local, serveInputs } from '../helpers/serve-brewery.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

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

  it('asks runBrew to override for foedrum mash --override, and without the flag not (ADR 0374)', () => {
    const remash: MashCommand = { command: 'mash', issue: { issue: 13 }, override: true };
    assert.deepStrictEqual(brewRequestOf(remash, 'ann', issued, undefined), {
      target: { issue: 13 },
      owner: 'ann',
      ...issued,
      mash: true,
      override: true,
    });
    const mash: MashCommand = { command: 'mash', issue: { issue: 13 } };
    assert.equal('override' in brewRequestOf(mash, 'ann', issued, undefined), false);
  });

  it('asks runBrew to lauter the issue of the batch, taking it over, for foedrum lauter (ADR 0286, #589)', () => {
    const lauter: LauterCommand = { command: 'lauter', issue: '12-1' };
    const found = { batchId: '12-1', target: { issue: 12 } };
    assert.deepStrictEqual(brewRequestOf(lauter, 'ann', issued, undefined, found), {
      target: { issue: 12 },
      owner: 'ann',
      ...issued,
      take: true,
      lauter: '12-1',
    });
    assert.equal('lauter' in brewRequestOf(command, 'ann', issued, undefined), false);
  });

  describe('foedrum lauter by a number (ADR 0329)', () => {
    const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
    const claimed = [
      {
        type: 'batch.ordered',
        batchId: 'web-7',
        order: { issue: 7, repo: 'acme/web' },
        routeBy: '2026-10-28T13:00:00.000Z',
      },
      { type: 'effect.applied', key, result: 40 },
    ] as const;
    const repositories = [{ alias: 'web', repo: 'acme/web' }];

    it("foedrum lauter takes a Brewery issue's number and acts on its latest batch", () => {
      assert.deepStrictEqual(lauterTarget(fold(claimed), { issue: 40 }, repositories), {
        batchId: 'web-7',
        target: { issue: 40 },
      });
    });

    it('a batch id brews by the number of its issue, which brew takes', () => {
      assert.deepStrictEqual(lauterTarget(fold(claimed), 'web-7', repositories), {
        batchId: 'web-7',
        target: { issue: 40 },
      });
    });

    it('refuses the target issue once its Brewery issue is alive, naming the number', () => {
      assert.deepStrictEqual(
        lauterTarget(fold(claimed), { alias: 'web', issue: 7 }, repositories),
        { refused: 'web#7 is Brewery issue #40; foedrum lauter 40' },
      );
    });

    it('says a number with no batch has none', () => {
      assert.deepStrictEqual(lauterTarget(fold(claimed), { issue: 99 }, repositories), {
        refused: '#99 has no batch',
      });
    });
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
      assert.deepStrictEqual(lauterTargetIn(path, '12-1', []), {
        batchId: '12-1',
        target: { issue: 12 },
      });
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
    assert.deepStrictEqual(lauterTarget(state, '12-1', repositories), {
      batchId: '12-1',
      target: { issue: 12 },
    });
    assert.deepStrictEqual(lauterTarget(state, 'web-7-1', repositories), {
      batchId: 'web-7-1',
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
    assert.ok(f.lines.includes('foedrum brew: ordered #12'), f.lines.join('\n'));
    assert.ok(f.lines.includes('foedrum brew: routed #12 to the recipe stout'), f.lines.join('\n'));
    assert.ok(f.lines.includes('foedrum brew: brewing #12 as ann'), f.lines.join('\n'));
    assert.equal(
      f.lines.at(-1),
      `foedrum brew: #12 is on tap: https://github.com/acme/web/pull/${f.api.pulls[0]?.number}`,
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
      [`foedrum brew: #12 is on tap: ${url}`],
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
    assert.equal(f.lines.at(-1), `foedrum brew: stopped; #12 on tap: ${url}`);
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
        'Opens as a draft: Foedrum marks it ready for review once its merge brief is posted.',
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
      'foedrum:review-and-merge',
    ]);
    assert.ok(f.api.labels.get('acme/brewery')?.has('foedrum:review-and-merge'));
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
      'foedrum brew: #12 brewing: brew #1 running for 30s',
      'foedrum brew: #12 brewing: brew #1 running for 1m 0s',
    ]);
  });

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
        'foedrum brew: #12 brewing: brew #1 running for 30s',
        'foedrum brew: #12 brewing: brew #1 running for 1m 0s',
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
      'foedrum brew: routed #12 to the recipe stout',
      'foedrum brew: brewing #12 as ann',
      'foedrum brew: status comment: https://github.com/Acme/Brewery/issues/12#issuecomment-1',
      'foedrum brew: #12 brewing: brew #1 started',
      'foedrum brew: #12 brewing: brew #1 running for 30s',
      'foedrum brew: #12 brewing: brew #1 running for 1m 0s',
      'foedrum brew: stopped; #12 brewing: brew #1 started',
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

  it("a lease's refusal says how to take the batch over", async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    const expiresAt = new Date(t0.getTime() + 60_000);
    f.store.withTransaction((tx) => tx.putBatchLease({ batchId: '12-1', owner: 'bob', expiresAt }));
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), request), 5);
    const [, takes] = /; (.+) takes it over now$/.exec(f.lines.at(-1) ?? '') ?? [];
    assert.equal(takes, 'foedrum brew 12 --take');
  });

  it("a lease's refusal of foedrum mash names mash's own --take", async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    const expiresAt = new Date(t0.getTime() + 60_000);
    f.store.withTransaction((tx) => tx.putBatchLease({ batchId: '12-1', owner: 'bob', expiresAt }));
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), { ...request, mash: true }), 5);
    const [, takes] = /; (.+) takes it over now$/.exec(f.lines.at(-1) ?? '') ?? [];
    assert.equal(takes, 'foedrum mash 12 --take');
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
      `foedrum brew: #12 is driven by cellar until ${expiresAt.toISOString()}, when its lease ends by itself; foedrum brew 12 --take takes it over now`,
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
      'foedrum brew: #12 needs input at brew:',
      'foedrum brew:   1. Which database should the cache use? (sqlite, redis; recommended: sqlite)',
      'foedrum brew:      why it blocks: The two need different migrations',
      'foedrum brew:   2. Which flag name? (--json, --format=json; recommended: --json)',
      'foedrum brew:      why it blocks: Scripts will depend on it',
      'foedrum brew: answer them in order with foedrum answer 12 <answer 1> <answer 2>, then brew again',
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
      'foedrum brew: #13 has no recipe:<name> label, and the Brewery has no recipe mash-in to brew it with by default; label it with the recipe to brew it with, or choose one with foedrum recipe 13 <recipe> "<reason>"',
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
    assert.equal(f.lines.at(-1), 'foedrum brew: #12 is paused; foedrum continue 12 lets it brew');
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
      'foedrum brew: #30 is a sub-order of #12, which is paused; foedrum continue 12 lets it brew',
    );
  });

  it('refuses a paused order, ordering nothing: exit 5 (ADR 0202)', async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log().issue({ kind: 'pause', order: { issue: 12 }, by: 'ann', via: 'terminal' }, t0);
    assert.equal(await runBrew(f.setup, shell(behave.succeed()), request), 5);
    assert.equal(f.lines.at(-1), 'foedrum brew: #12 is paused; foedrum continue 12 lets it brew');
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
      'foedrum brew: #12 is cancelled; foedrum order 12 orders it again',
    );
  });

  it('stops with the reason and the options when the batch is Stuck on anything but questions: exit 3', async () => {
    const blocked = behave.blocked('findings', 'The tests fail');
    assert.equal(await runBrew(f.setup, shell(blocked), request), 3);
    assert.match(
      f.lines.at(-1) ?? '',
      /^foedrum brew: #12 is stuck: blocked at brew \(findings\): The tests fail; reminder [^;]+; options: retry, /,
    );
  });

  describe('the status comment a run that ends Stuck leaves (#863)', () => {
    const shown = (): string => f.api.comments.get('acme/brewery#12')?.[0]?.body ?? '';
    const stuckLines = (): string[] => f.lines.filter((line) => line.includes(' is stuck: '));
    /**
     * A runner whose attempt ends with `ending` at the first wait, so the first tick has made the
     * comment, on a clock that stands still: the batch goes Stuck within a minute of that edit.
     */
    const endsAfterFirstTick = (ending: Ending): Partial<ServeShell> => {
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let waits = 0;
      return {
        runner: () => ({
          start: () => ({ ended: gate.then(() => ({ ending })), stop: () => {} }),
          progress: () => undefined,
        }),
        wait: async () => {
          waits++;
          if (waits > 20) assert.fail(`brew did not stop:\n${f.lines.join('\n')}`);
          release();
        },
      };
    };
    const blocked: Ending = { kind: 'blocked', blockerKind: 'findings', summary: 'The tests fail' };

    it('a run of foedrum brew that ends Stuck has posted the comment with that lane', async () => {
      const brew = shell(behave.succeed(), endsAfterFirstTick(blocked));
      assert.equal(await runBrew(f.setup, brew, request), 3);
      assert.match(shown(), /🔔 \*\*Stuck\*\*: `brew` is blocked \(findings\): The tests fail/);
      assert.match(shown(), /Next:/);
      assert.equal(stuckLines().length, 1, f.lines.join('\n'));
    });

    it('a run that stops for questions has posted the comment with them', async () => {
      const asking: Ending = { kind: 'needs_input', questions: [question] };
      const brew = shell(behave.succeed(), endsAfterFirstTick(asking));
      const exit = await runBrew(f.setup, brew, request);
      assert.equal(exit, 4, f.lines.join('\n'));
      assert.match(shown(), /🔔 \*\*Stuck\*\*/);
      assert.ok(shown().includes(question.q), shown());
    });

    it('a run whose pull request action is refused has posted the comment with the Stuck that ended it, and tries it once', async () => {
      let scans = 0;
      const refused = shell(behave.succeed('Brewed'), {
        push: () => ({
          commit: async () => 'c'.repeat(40),
          baseTip: async () => 'b'.repeat(40),
          isAncestor: async (commit, of) => commit === of,
          remoteTip: async () => undefined,
          push: async () => assert.fail('a refused push pushes nothing'),
          secretScan: async () => {
            scans++;
            return [{ commit: 'c'.repeat(40), place: 'src/a.ts:1', kind: 'token' }];
          },
          touchedFiles: async () => [],
        }),
      });
      assert.equal(await runBrew(f.setup, refused, request), 3);
      assert.match(shown(), /🔔 \*\*Stuck\*\*/);
      assert.match(shown(), /Next:/);
      assert.deepStrictEqual(f.started, ['brew#1']);
      assert.equal(scans, 1);
      assert.equal(stuckLines().length, 1, f.lines.join('\n'));
    });

    it('a run whose last edit fails still exits Stuck, and says the effect failed', async () => {
      const gh = ghOver(f.api.fetch).exec;
      const failing = shell(behave.succeed(), {
        ...endsAfterFirstTick(blocked),
        gh: (file, args, options) =>
          args.includes('PATCH')
            ? Promise.reject(new Error('GitHub is down'))
            : gh(file, args, options),
      });
      assert.equal(await runBrew(f.setup, failing, request), 3);
      assert.doesNotMatch(shown(), /Stuck/);
      assert.ok(
        f.lines.some((line) => line.includes('status.2') && line.includes('GitHub is down')),
        f.lines.join('\n'),
      );
      assert.match(f.lines.at(-1) ?? '', /^foedrum brew: #12 is stuck: /);
    });

    it('goes on brewing when a person moves the batch during the tick after it stuck, and says no Stuck', async () => {
      const runner = fakeBrewerRunner({
        brew: [behave.blocked('findings', 'The tests fail'), behave.succeed('Brewed')],
      });
      let retried = false;
      const moved = shell(behave.succeed(), {
        runner: () => runner,
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () => {
            if (!retried && log().state().batches.get('12-1')?.lane.kind === 'stuck') {
              retried = true;
              const by = { by: 'ann', via: 'terminal' } as const;
              log().issue({ kind: 'retry', batchId: '12-1', ...by }, t0);
            }
            return { kind: 'unchanged' };
          },
        }),
      });
      assert.equal(await runBrew(f.setup, moved, request), 0);
      assert.equal(retried, true);
      assert.deepStrictEqual(stuckLines(), []);
      assert.equal(runner.started.length, 2);
    });

    it('ticks once more after a second Stuck too, when a person moved the batch after the first', async () => {
      const runner = fakeBrewerRunner({
        brew: [behave.blocked('findings', 'The tests fail'), behave.succeed('Brewed')],
      });
      let retried = false;
      const again = shell(behave.succeed(), {
        runner: () => runner,
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () => {
            if (!retried && log().state().batches.get('12-1')?.lane.kind === 'stuck') {
              retried = true;
              const by = { by: 'ann', via: 'terminal' } as const;
              log().issue({ kind: 'retry', batchId: '12-1', ...by }, t0);
            }
            return { kind: 'unchanged' };
          },
        }),
        push: () => ({
          commit: async () => 'c'.repeat(40),
          baseTip: async () => 'b'.repeat(40),
          isAncestor: async (commit, of) => commit === of,
          remoteTip: async () => undefined,
          push: async () => assert.fail('a refused push pushes nothing'),
          secretScan: async () => [{ commit: 'c'.repeat(40), place: 'src/a.ts:1', kind: 'token' }],
          touchedFiles: async () => [],
        }),
      });
      assert.equal(await runBrew(f.setup, again, request), 3);
      assert.equal(retried, true);
      assert.match(shown(), /🔔 \*\*Stuck\*\*: `open-pull-request`/);
      assert.equal(stuckLines().length, 1, f.lines.join('\n'));
    });

    it('still exits Stuck, and says why, when the tick after it stuck throws: regression test', async () => {
      let thrown = false;
      const failing = shell(behave.blocked('findings', 'The tests fail'), {
        openStore: () => ({
          ...f.store,
          batchesPastDeadline: (at) => {
            if (!thrown && log().state().batches.get('12-1')?.lane.kind === 'stuck') {
              thrown = true;
              throw new Error('the store could not be read');
            }
            return f.store.batchesPastDeadline(at);
          },
        }),
      });
      assert.equal(await runBrew(f.setup, failing, request), 3);
      assert.equal(thrown, true);
      assert.ok(
        f.lines.includes('foedrum brew: a tick failed: the store could not be read'),
        f.lines.join('\n'),
      );
      assert.match(f.lines.at(-1) ?? '', /^foedrum brew: #12 is stuck: /);
    });

    it('stops as any tick does when the state branch says stop in the tick after it stuck: exit 1', async () => {
      const stopping = shell(behave.blocked('findings', 'The tests fail'), {
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () => {
            if (log().state().batches.get('12-1')?.lane.kind !== 'stuck') {
              return { kind: 'unchanged' };
            }
            throw new StateBranchStopError('the push was rejected: another engine wrote');
          },
        }),
      });
      assert.equal(await runBrew(f.setup, stopping, request), 1);
      assert.equal(f.lines.at(-1), 'foedrum brew: the push was rejected: another engine wrote');
      assert.equal(log().state().batches.get('12-1')?.lane.kind, 'stuck');
    });
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
    assert.equal(f.lines.at(-1), 'foedrum brew: stopped; #12 brewing: brew #1 started');
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
    assert.ok(f.lines.includes('foedrum brew: routed #12 to the recipe stout'), f.lines.join('\n'));
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
    const forged = 'foedrum brew: answer them in order with foedrum answer 12 x, then brew again';
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
      'foedrum brew: answer them in order with foedrum answer 12 <answer 1>, then brew again',
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
    assert.match(second.at(-1) ?? '', /^foedrum brew: #12 is on tap: /);
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
    assert.equal(f.lines.at(-1), 'foedrum brew: #12 was cancelled by bob via terminal');
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
      `foedrum brew: #12 is driven by cellar until ${expiresAt.toISOString()}, when its lease ends by itself; foedrum brew 12 --take takes it over now`,
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
    assert.equal(f.lines.at(-1)?.startsWith('foedrum brew: #12 is driven by bob until'), true);
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
    const controller = new AbortController();
    const taken = shell(behave.succeed(), {
      terminal: screen.terminal,
      signal: controller.signal,
      runner: () => ({
        ...runner,
        start: (attempt) => ({ ...runner.start(attempt), stop: () => {} }),
      }),
      clock: () => now,
      wait: async (ms, waiting) => {
        // The live line's wait beside a call lasts until the call ends (#873).
        if (waiting !== controller.signal) return aborted(waiting);
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
      wait: async (ms, waiting) => {
        // The live line's wait beside a call lasts until the call ends: counted here, it would
        // spend the redraws on however many turns of the event loop a call takes (#873).
        if (waiting !== controller.signal) return aborted(waiting);
        waits++;
        // The machine's clock is set back ten minutes in the second redraw.
        now = new Date(now.getTime() + ms - (waits === 2 ? 600_000 : 0));
        if (waits >= 30) controller.abort();
      },
      stateBranch: () => ({
        start: async () => ({ decision: 'ready' }),
        flush: async () => {
          flushes += 1;
          // A call that takes many turns of the event loop, as file I/O can on another platform.
          for (let turn = 0; turn < 40; turn++) {
            await new Promise((resolve) => setImmediate(resolve));
          }
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
      assert.ok(f.lines.includes('foedrum brew: took #12 over from cellar'), f.lines.join('\n'));
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
