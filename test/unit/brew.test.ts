// `foedrum brew` (ADR 0123): its schema, its owner, and runBrew on serve's shell with an in-memory
// store, fake worktrees, a fake GitHub and the scripted runner: it orders and routes an issue with
// no batch and brews it on tap, refuses a batch another driver leases, and stops with the questions
// when the batch needs input. No process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type BrewRequest, runBrew } from '../../src/cli/brew.ts';
import {
  brewFromCheckout,
  brewInNewWindow,
  brewRequestOf,
  brewShellOf,
  noSessionsOf,
  thisMachine,
} from '../../src/cli/brew-main.ts';
import { brewOwner } from '../../src/cli/driver-owner.ts';
import type { LiveTerminal, ServeShell } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { takeOver } from '../../src/engine/batch-leases.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { DriverRunningError } from '../../src/engine/driver-lock.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import type { FlushResult } from '../../src/engine/state-branch-git.ts';
import type { AttemptProgress } from '../../src/engine/supervisor.ts';
import { launchProcess } from '../../src/platform/processes.ts';
import { BrewCommand, MashCommand } from '../../src/schemas/commands.ts';
import type { Question } from '../../src/schemas/step-outcome.ts';
import {
  type Behaviour,
  behave,
  fakeBrewerRunner,
  question,
} from '../helpers/fake-brewer-runner.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { FAKE_COMMIT, fakeWorktreeMerge, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { brewer, config, local, recipe, serveInputs } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const t0 = new Date('2026-10-22T12:00:00.000Z');

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
  let dir: TempDir;
  let setup: ServeSetup;
  let store: EventStore;
  let lines: string[];
  let api: FakeGitHubApi;
  let lock: ReturnType<typeof fakeLock>;
  let locked: string[];
  let started: string[];
  /** The runs the last shell's runner was asked to stop, by attempt key. */
  let stops: readonly string[];

  beforeEach(() => {
    dir = makeTempDir('brew');
    const result = serveSetup(
      serveInputs({ files: { ...serveInputs().files, local: local({ workRoot: dir.path }) } }),
    );
    setup = result.kind === 'ready' ? result.setup : assert.fail();
    // brew closes its store at the end; the test reads it after.
    const inner = openSqliteEventStore(':memory:');
    store = { ...inner, close: () => {} };
    lines = [];
    locked = [];
    started = [];
    lock = fakeLock('ann');
    api = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          {
            number: 12,
            labels: ['recipe:stout'],
            author: 'ann',
            title: 'Add a --json flag',
            body: 'Add a --json flag.',
          },
          { number: 13, labels: [], author: 'ann', title: 'Unlabelled', body: 'No recipe.' },
          {
            number: 14,
            labels: ['recipe:stout', 'recipe:porter'],
            author: 'ann',
            title: 'Two recipes',
            body: 'Both.',
          },
          {
            number: 15,
            labels: ['recipe:stoutt'],
            author: 'ann',
            title: 'A typo',
            body: 'No such recipe.',
          },
        ],
      },
    });
  });
  afterEach(() => dir.remove());

  const log = () => createCommandLog({ store, recipes: setup.recipes });
  /** The live lease of batch 12-1. */
  const leaseOf = () => store.batchLeases(t0).find(({ batchId }) => batchId === '12-1');

  /** serve's shell with fakes, ticking until brew stops, or failing after 20 ticks. */
  const shell = (brew: Behaviour, overrides: Partial<ServeShell> = {}): ServeShell => {
    let ticks = 0;
    const runner = fakeBrewerRunner((attempt) => {
      started.push(`${attempt.ref.stepId}#${attempt.ref.attempt}`);
      return brew;
    });
    stops = runner.stopped;
    return {
      out: (line) => lines.push(line),
      signal: new AbortController().signal,
      clock: () => t0,
      wait: async () => {
        ticks++;
        if (ticks > 20) assert.fail(`brew did not stop:\n${lines.join('\n')}`);
      },
      lock: (_workRoot, { owner }) => {
        locked.push(owner);
        return lock;
      },
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
      exec: () => Promise.reject(new Error('no check step runs here')),
      setup: () => Promise.reject(new Error('no repository setup runs here')),
      gh: ghOver(api.fetch).exec,
      git: () => Promise.reject(new Error('no red proof or guarded step runs here')),
      ...overrides,
    };
  };

  const request: BrewRequest = { target: { issue: 12 }, owner: 'ann', by: 'ann', via: 'terminal' };

  it('orders and routes an issue with no batch, and brews it on tap with no Cellar: exit 0', async () => {
    assert.equal(await runBrew(setup, shell(behave.succeed('Brewed')), request), 0);
    assert.deepStrictEqual(locked, ['ann']);
    assert.deepStrictEqual(started, ['brew#1']);
    const batch = log().state().batches.get('12-1');
    assert.equal(batch?.lane.kind, 'on_tap');
    // The order is a person's, recorded with who ran brew and from where (ADR 0105).
    const ordered = store.eventsAfter(0).find(({ event }) => event.type === 'batch.ordered');
    assert.deepStrictEqual(
      ordered?.event.type === 'batch.ordered'
        ? { by: ordered.event.by, via: ordered.event.via }
        : undefined,
      { by: 'ann', via: 'terminal' },
    );
    assert.equal(api.pulls.length, 1);
    assert.ok(lines.includes('foedrum brew: ordered #12 as batch 12-1'), lines.join('\n'));
    assert.ok(
      lines.includes('foedrum brew: routed batch 12-1 to the recipe stout'),
      lines.join('\n'),
    );
    assert.ok(lines.includes('foedrum brew: brewing batch 12-1 as ann'), lines.join('\n'));
    assert.equal(
      lines.at(-1),
      `foedrum brew: batch 12-1 is on tap: https://github.com/acme/web/pull/${api.pulls[0]?.number}`,
    );
    // Every effect applied, the driver let the batch go and its lock.
    assert.equal(leaseOf(), undefined);
    assert.equal(lock.held, false);
  });

  it('says the batch is on tap once, in its last line (#662)', async () => {
    assert.equal(await runBrew(setup, shell(behave.succeed('Brewed')), request), 0);
    const url = `https://github.com/acme/web/pull/${api.pulls[0]?.number}`;
    assert.deepStrictEqual(
      lines.filter((line) => line.includes('on tap')),
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
    assert.equal(await runBrew(setup, stopping, request), 1);
    const url = `https://github.com/acme/web/pull/${api.pulls[0]?.number}`;
    assert.equal(lines.at(-1), `foedrum brew: stopped; batch 12-1 on tap: ${url}`);
  });

  it("opens the pull request on the code host in Foedrum's layout, as a draft with no Taster (ADR 0167)", async () => {
    const files = serveInputs().files;
    const writing = serveSetup(
      serveInputs({
        files: {
          ...files,
          local: local({ workRoot: dir.path }),
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
    assert.equal(api.pulls.length, 1);
    const [pull] = api.pulls;
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
        'Brewed by Foedrum from Acme/Brewery#12 with the recipe stout.',
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
        '',
        'Closes Acme/Brewery#12',
      ].join('\n'),
    );
  });

  it("labels the order's issue with its batch's lane, made in the Brewery first (#406)", async () => {
    assert.equal(await runBrew(setup, shell(behave.succeed('Brewed')), request), 0);
    assert.deepStrictEqual(api.issue('acme/brewery', 12)?.labels, [
      'recipe:stout',
      'foedrum:on-tap',
    ]);
    assert.ok(api.labels.get('acme/brewery')?.has('foedrum:on-tap'));
  });

  it('prints the link to the status comment once it is made (#406)', async () => {
    assert.equal(await runBrew(setup, shell(behave.succeed('Brewed')), request), 0);
    const [comment] = api.comments.get('acme/brewery#12') ?? [];
    const link = `https://github.com/${setup.brewery}/issues/12#issuecomment-${comment?.id}`;
    const shown = lines.filter((line) => line === `foedrum brew: status comment: ${link}`);
    assert.equal(shown.length, 1, lines.join('\n'));
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
    assert.equal(await runBrew(setup, ticking, request), 1);
    const progress = lines.filter((line) => line.includes('running for'));
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
    assert.equal(await runBrew(setup, plain, request), 1);
    assert.ok(waits.length > 0 && waits.every((ms) => ms === 5_000), waits.join(' '));
    assert.deepStrictEqual(
      lines.filter((line) => line.includes('running for')),
      [
        'foedrum brew: batch 12-1 brewing: brew #1 running for 30s',
        'foedrum brew: batch 12-1 brewing: brew #1 running for 1m 0s',
      ],
    );
    assert.ok(
      lines.every(
        (line) => line.startsWith('foedrum brew: ') && !/\bturn\b|\bdenied\b|Edit/.test(line),
      ),
      lines.join('\n'),
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
    assert.equal(await runBrew(setup, plain, request), 1);
    assert.deepStrictEqual(lines, [
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
    assert.equal(await runBrew(setup, stopping, request), 1);
    assert.equal(lines.at(-1), 'foedrum brew: the push was rejected: another engine wrote');
    assert.equal(lock.held, false);
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
      lock = fakeLock('ann');
      store = { ...openSqliteEventStore(':memory:'), close: () => {} };
      before?.();
      const screen = fakeScreen(columns);
      const controller = new AbortController();
      const waits: number[] = [];
      let flushes = 0;
      let now = t0;
      const live = shell(behave.hang(progress), {
        terminal: screen.terminal,
        out: (line) => {
          lines.push(line);
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
      const code = await runBrew(setup, live, request);
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
          store.withTransaction((tx) => tx.append(old));
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
        lines.filter((line) => line.includes('running for')),
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
      assert.ok(lines.at(-1)?.startsWith('foedrum brew: stopped; '), lines.at(-1));
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
        files: { ...serveInputs().files, local: local({ workRoot: dir.path }) },
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
      setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
      api = fakeGitHubApi({
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
        lines.some((line) => line.includes('security #1') && line.includes('correctness #1')),
        lines.join('\n'),
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
      assert.equal(code, 0, lines.join('\n'));
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
        lines.length = 0;
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
        assert.equal(code, exitCode, `${name}: ${lines.join('\n')}`);
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
    store.withTransaction((tx) =>
      tx.putBatchLease({ batchId: '12-1', owner: 'cellar', expiresAt }),
    );
    assert.equal(await runBrew(setup, shell(behave.succeed()), request), 5);
    assert.deepStrictEqual(started, []);
    assert.equal(
      lines.at(-1),
      `foedrum brew: batch 12-1 is driven by cellar until ${expiresAt.toISOString()}`,
    );
    assert.equal(leaseOf()?.owner, 'cellar');
    assert.equal(lock.held, false);
  });

  it('stops with the questions, numbered as foedrum answer takes them, when the batch needs input: exit 4', async () => {
    const second: Question = {
      q: 'Which flag name?',
      options: ['--json', '--format=json'],
      recommended: '--json',
      whyBlocking: 'Scripts will depend on it',
    };
    assert.equal(await runBrew(setup, shell(behave.needInput([question, second])), request), 4);
    assert.deepStrictEqual(lines.slice(-6), [
      'foedrum brew: batch 12-1 needs input at brew:',
      'foedrum brew:   1. Which database should the cache use? (sqlite, redis; recommended: sqlite)',
      'foedrum brew:      why it blocks: The two need different migrations',
      'foedrum brew:   2. Which flag name? (--json, --format=json; recommended: --json)',
      'foedrum brew:      why it blocks: Scripts will depend on it',
      'foedrum brew: answer them in order with foedrum answer 12-1 <answer 1> <answer 2>, then brew again',
    ]);
    // The batch stays this driver's while its engineer answers (ADR 0044); the lock goes.
    assert.equal(leaseOf()?.owner, 'ann');
    assert.equal(lock.held, false);
  });

  it('refuses an issue it cannot route, ordering nothing: exit 5', async () => {
    const unlabelled = { ...request, target: { issue: 13 } };
    assert.equal(await runBrew(setup, shell(behave.succeed()), unlabelled), 5);
    assert.equal(log().state().batches.size, 0);
    assert.equal(
      lines.at(-1),
      'foedrum brew: #13 has no recipe:<name> label; label it with the recipe to brew it with',
    );
  });

  it('ends with the refusal once a pause that came while it brews holds the batch and nothing runs: exit 5 (ADR 0202)', async () => {
    let paused = false;
    let ticks = 0;
    const pausing = shell(behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0 }), {
      wait: async () => {
        ticks++;
        if (ticks > 20) assert.fail(`brew did not stop:\n${lines.join('\n')}`);
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
    assert.equal(await runBrew(setup, pausing, request), 5);
    assert.equal(lines.at(-1), 'foedrum brew: #12 is paused; foedrum continue #12 lets it brew');
    assert.deepStrictEqual(started, ['brew#1']);
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
    assert.equal(await runBrew(setup, shell(behave.succeed()), sub), 5);
    assert.equal(
      lines.at(-1),
      'foedrum brew: #30 is a sub-order of #12, which is paused; foedrum continue #12 lets it brew',
    );
  });

  it('refuses a paused order, ordering nothing: exit 5 (ADR 0202)', async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log().issue({ kind: 'pause', order: { issue: 12 }, by: 'ann', via: 'terminal' }, t0);
    assert.equal(await runBrew(setup, shell(behave.succeed()), request), 5);
    assert.equal(lines.at(-1), 'foedrum brew: #12 is paused; foedrum continue #12 lets it brew');
    assert.deepStrictEqual(started, []);
  });

  it('refuses any issue while the Brewery is paused, ordering nothing: exit 5 (ADR 0202)', async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log().issue({ kind: 'pause', by: 'ann', via: 'terminal' }, t0);
    const other = { ...request, target: { issue: 13 } };
    assert.equal(await runBrew(setup, shell(behave.succeed()), other), 5);
    assert.equal(
      lines.at(-1),
      'foedrum brew: the Brewery is paused; foedrum continue --all lets it brew',
    );
    assert.equal(log().state().batches.size, 1);
    assert.deepStrictEqual(started, []);
  });

  it('refuses an issue whose latest batch ended: ordering it again is foedrum order: exit 5', async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log().issue({ kind: 'cancel', batchId: '12-1', by: 'ann', via: 'terminal' }, t0);
    assert.equal(await runBrew(setup, shell(behave.succeed()), request), 5);
    assert.equal(
      lines.at(-1),
      'foedrum brew: batch 12-1 of #12 is cancelled; foedrum order #12 orders it again',
    );
  });

  it('stops with the reason and the options when the batch is Stuck on anything but questions: exit 3', async () => {
    const blocked = behave.blocked('findings', 'The tests fail');
    assert.equal(await runBrew(setup, shell(blocked), request), 3);
    assert.match(
      lines.at(-1) ?? '',
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
    assert.equal(await runBrew(setup, held, request), 5);
    assert.equal(lines.at(-1), 'foedrum brew: The driver ann already runs on this work root');
  });

  it("names --as when its owner's driver already runs, as a second terminal meets it (ADR 0259)", async () => {
    const held = shell(behave.succeed(), {
      lock: () => {
        throw new DriverRunningError('terminal', 'driver-terminal.lock', undefined);
      },
      openStore: () => assert.fail('no store is opened'),
    });
    assert.equal(await runBrew(setup, held, { ...request, owner: 'terminal' }), 5);
    assert.match(
      lines.at(-1) ?? '',
      /^foedrum brew: The driver terminal already runs .*give --as <name> to run another driver beside it$/,
    );
  });

  it('refuses an alias of no repository with an intake, before it takes the lock: exit 5', async () => {
    const target = { alias: 'web', issue: 7 };
    assert.equal(await runBrew(setup, shell(behave.succeed()), { ...request, target }), 5);
    assert.deepStrictEqual(locked, []);
    assert.equal(
      lines.at(-1),
      'foedrum brew: foedrum.jsonc names no repository with the alias web and an intake',
    );
  });

  it('refuses an issue with two recipe labels, ordering nothing: exit 5', async () => {
    const two = { ...request, target: { issue: 14 } };
    assert.equal(await runBrew(setup, shell(behave.succeed()), two), 5);
    assert.equal(log().state().batches.size, 0);
    assert.equal(
      lines.at(-1),
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
    assert.equal(await runBrew(setup, stopped, request), 1);
    assert.equal(lines.at(-1), 'foedrum brew: stopped; batch 12-1 brewing: brew #1 started');
    assert.equal(stops.length, 1, 'the hung run was stopped');
    assert.equal(lock.held, false);
  });

  it('holds the machine awake from the start of its attempt to its end, and lets the hold go when it stops (ADR 0195)', async () => {
    const held: string[] = [];
    const awake = {
      attemptStarted: () => held.push(`started with ${started.length} brewer attempts begun`),
      attemptEnded: () => held.push('ended'),
      release: () => held.push('released'),
    };
    assert.equal(await runBrew(setup, shell(behave.succeed(), { awake }), request), 0);
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
    assert.equal(await runBrew(setup, stopped, request), 1);
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
      ...store,
      close: () => {
        throw new Error('the store did not close');
      },
    };
    await assert.rejects(
      runBrew(setup, shell(behave.succeed(), { awake, openStore: () => failing }), request),
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
      await runBrew(setup, shell(behave.succeed(), { awake, exec }), request),
      0,
      lines.join('\n'),
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
    store.withTransaction((tx) => tx.putBatchLease({ batchId: '13-1', owner: 'ann', expiresAt }));
    assert.equal(await runBrew(setup, shell(behave.succeed()), request), 0);
    const other = store.batchLeases(t0).find(({ batchId }) => batchId === '13-1');
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
      return api.fetch(input, init);
    };
    const raced = shell(behave.succeed(), { gh: ghOver(racing).exec });
    assert.equal(await runBrew(setup, raced, request), 0, lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes('routed batch')), lines.join('\n'));
  });

  it('routes an Ordered batch it finds by its label, without ordering it again: exit 0', async () => {
    log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    assert.equal(await runBrew(setup, shell(behave.succeed()), request), 0);
    assert.ok(
      lines.includes('foedrum brew: routed batch 12-1 to the recipe stout'),
      lines.join('\n'),
    );
    assert.ok(!lines.some((line) => line.includes('ordered #12')), lines.join('\n'));
    assert.deepStrictEqual([...log().state().batches.keys()], ['12-1']);
  });

  describe('foedrum mash (ADR 0232)', () => {
    // A second recipe like stout, so the Innkeeper has two to offer beside porter and nip.
    const mild = JSON.stringify({ ...JSON.parse(recipe), name: 'mild', description: 'A mild.' });
    /**
     * The test Brewery with Foedrum's defaults under it, mash-in and the Innkeeper among them; with
     * `only`, the Brewery's recipes are that one, and Foedrum's are mash-in alone.
     */
    const mashSetup = (
      fields: { config?: string; only?: string; keep?: string } = {},
    ): ServeSetup => {
      // With `only`, the one default recipe kept: mash-in, unless `keep` names another.
      const kept = `/${fields.keep ?? 'mash-in'}.jsonc`;
      const inputs = serveInputs();
      const { defaults = {} } = readBreweryFiles(join(dir.path, 'no-brewery'));
      const own = [
        ...(inputs.files.brewery.recipes ?? []),
        { path: 'recipes/mild.jsonc', text: mild },
      ];
      const result = serveSetup(
        serveInputs({
          files: {
            ...inputs.files,
            ...(fields.config === undefined ? {} : { config: fields.config }),
            local: local({ workRoot: dir.path }),
            brewery: {
              ...inputs.files.brewery,
              recipes:
                fields.only === undefined
                  ? own
                  : own.filter(({ path }) => path === `recipes/${fields.only}.jsonc`),
              defaults:
                fields.only === undefined
                  ? defaults
                  : {
                      ...defaults,
                      recipes: (defaults.recipes ?? []).filter(({ path }) => path.endsWith(kept)),
                    },
            },
          },
        }),
      );
      return result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    };
    const which = (issue: number): Question => ({
      q: `Which recipe brews #${issue}? Suggested: mild: one small change`,
      options: ['stout', 'mild'],
      recommended: 'mild',
      whyBlocking: 'The recipe decides what runs next',
    });
    const mash = (issue: number): BrewRequest => ({ ...request, target: { issue }, mash: true });

    it('orders and routes an issue with no batch to mash-in, and stops with its question: exit 4', async () => {
      const asks = shell(behave.needInput([which(13)]));
      assert.equal(await runBrew(mashSetup(), asks, mash(13)), 4, lines.join('\n'));
      assert.deepStrictEqual(started, ['innkeep#1']);
      assert.deepStrictEqual(log().state().batches.get('13-1')?.recipe, {
        name: 'mash-in',
        reason: 'the engineer ran foedrum mash',
        source: 'human',
        by: 'ann',
        via: 'terminal',
      });
      assert.ok(lines.includes('foedrum mash: ordered #13 as batch 13-1'), lines.join('\n'));
      assert.deepStrictEqual(lines.slice(-4), [
        'foedrum mash: batch 13-1 needs input at innkeep:',
        'foedrum mash:   1. Which recipe brews #13? Suggested: mild: one small change (stout, mild; recommended: mild)',
        'foedrum mash:      why it blocks: The recipe decides what runs next',
        'foedrum mash: answer them in order with foedrum answer 13-1 <answer 1>, then brew again',
      ]);
    });

    for (const choice of ['stout', 'mild']) {
      it(`labels the issue recipe:${choice} once when the answer is ${choice}, and brews it from its first step`, async () => {
        const brewing = mashSetup();
        assert.equal(await runBrew(brewing, shell(behave.needInput([which(13)])), mash(13)), 4);
        const answered = createCommandLog({ store, recipes: brewing.recipes }).issue(
          {
            kind: 'answer',
            batchId: '13-1',
            by: 'ann',
            via: 'terminal',
            answers: [{ q: which(13).q, answer: choice }],
          },
          t0,
        );
        assert.equal(answered.kind, 'accepted', JSON.stringify(answered));
        const brew = { ...request, target: { issue: 13 } };
        // The next process of the same owner takes the lock again.
        const again = shell(behave.succeed(), { lock: () => fakeLock('ann') });
        assert.equal(await runBrew(brewing, again, brew), 0, lines.join('\n'));
        assert.deepStrictEqual(started, ['innkeep#1', 'brew#1']);
        assert.equal(log().state().batches.get('13-1')?.recipe?.name, choice);
        const labels = api.issue('acme/brewery', 13)?.labels ?? [];
        assert.deepStrictEqual(
          labels.filter((label) => label.startsWith('recipe:')),
          [`recipe:${choice}`],
        );
      });
    }

    for (const [issue, stuck] of [
      [13, false],
      [12, true],
    ] as const) {
      it(`routes ${stuck ? 'a batch Stuck on routing' : 'an Ordered batch'}, ordering it not again: exit 4`, async () => {
        const id = `${issue}-1`;
        log().issue({ kind: 'order', batchId: id, order: { issue } }, t0);
        // Past its routing deadline (ADR 0032).
        const late = new Date(t0.getTime() + 24 * 3_600_000);
        if (stuck) log().issue({ kind: 'unrouted', batchId: id }, late);
        assert.equal(log().state().batches.get(id)?.lane.kind, stuck ? 'stuck' : 'ordered');
        const asks = shell(behave.needInput([which(issue)]));
        assert.equal(await runBrew(mashSetup(), asks, mash(issue)), 4, lines.join('\n'));
        assert.equal(log().state().batches.get(id)?.recipe?.name, 'mash-in');
        assert.ok(!lines.some((line) => line.includes(`ordered #${issue}`)), lines.join('\n'));
      });
    }

    it("links a plan's out doc on the Brewery's own GitHub host: regression test (#659)", async () => {
      const subOrder = {
        id: 'one',
        title: 'One',
        repo: 'acme/web',
        size: { lines: 10, mechanism: 'a flag' },
        doneWhen: 'a test passes',
        touches: [{ path: 'src' }],
        recipe: 'stout',
        why: 'small',
        ready: true,
      };
      const brewing = { ...mashSetup(), github: { hostname: 'github.localhost' } };
      const mashLog = createCommandLog({ store, recipes: brewing.recipes });
      mashLog.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
      mashLog.issue(
        { kind: 'route', batchId: '13-1', recipe: 'mash', reason: 'label', source: 'label' },
        t0,
      );
      const plans = behave.succeedWith({ assumptions: ['Kept the flag'], subOrders: [subOrder] });
      await runBrew(brewing, shell(plans), { ...request, target: { issue: 13 } });
      const bodies = (api.comments.get('acme/brewery#13') ?? []).map(({ body }) => body);
      const link = `<https://github.localhost/${setup.brewery}/blob/foedrum/state/batches/13-1/plan-1.md?plain=1>`;
      assert.ok(
        bodies.some((body) => body.includes(`Full plan: ${link}`)),
        bodies.join('\n---\n'),
      );
    });

    it("links a plan's out doc on the Brewery's state branch from its comments (#659)", async () => {
      const subOrder = {
        id: 'one',
        title: 'One',
        repo: 'acme/web',
        size: { lines: 10, mechanism: 'a flag' },
        doneWhen: 'a test passes',
        touches: [{ path: 'src' }],
        recipe: 'stout',
        why: 'small',
        ready: true,
      };
      const brewing = mashSetup();
      const mashLog = createCommandLog({ store, recipes: brewing.recipes });
      for (const command of [
        { kind: 'order', batchId: '13-1', order: { issue: 13 } },
        { kind: 'route', batchId: '13-1', recipe: 'mash', reason: 'label', source: 'label' },
      ] as const) {
        const decision = mashLog.issue(command, t0);
        assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
      }
      const plans = behave.succeedWith({ assumptions: ['Kept the flag'], subOrders: [subOrder] });
      await runBrew(brewing, shell(plans), { ...request, target: { issue: 13 } });
      const link = `<https://github.com/${setup.brewery}/blob/foedrum/state/batches/13-1/plan-1.md?plain=1>`;
      const bodies = (api.comments.get('acme/brewery#13') ?? []).map(({ body }) => body);
      const shown = bodies.join('\n---\n');
      assert.ok(
        bodies.some((body) => body.includes(`- \`plan\`: full plan: ${link}`)),
        shown,
      );
      assert.ok(
        bodies.some((body) => body.includes(`Full plan: ${link}`)),
        shown,
      );
    });

    it('routes a claimed order through its Brewery issue: exit 4', async () => {
      const web = { alias: 'web', intake: { labels: ['foedrum'] } };
      api = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            { number: 40, labels: [], author: 'ann', title: 'Dark theme', body: 'web#7' },
          ],
          'acme/web': [
            { number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark theme', body: 'Dark.' },
          ],
        },
      });
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      log().issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } }, t0);
      const claimed = mashSetup({ config: config({}, web) });
      const asks = shell(behave.needInput([which(40)]));
      assert.equal(await runBrew(claimed, asks, mash(40)), 4, lines.join('\n'));
      assert.equal(log().state().batches.get('web-7')?.recipe?.name, 'mash-in');
      assert.deepStrictEqual([...log().state().batches.keys()], ['web-7']);
    });

    it('mashes a claimed issue with no batch: claims it, orders it and routes it to mash-in, exit 4 (ADR 0232)', async () => {
      const web = { alias: 'web', intake: { labels: ['foedrum'] } };
      api = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/web': [
            { number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark theme', body: 'Dark.' },
          ],
        },
      });
      const claimed = mashSetup({ config: config({}, web) });
      const asks = shell(behave.needInput([which(7)]));
      const fresh = { ...request, target: { alias: 'web', issue: 7 }, mash: true } as const;
      assert.equal(await runBrew(claimed, asks, fresh), 4, lines.join('\n'));
      assert.equal(log().state().batches.get('web-7')?.recipe?.name, 'mash-in');
      assert.ok(
        lines.includes('foedrum mash: ordered acme/web#7 as batch web-7'),
        lines.join('\n'),
      );
    });

    it('refuses a batch that started a recipe, naming foedrum recipe: exit 5', async () => {
      log().issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
      const route = { kind: 'route', batchId: '12-1', recipe: 'stout', reason: 'label' } as const;
      log().issue({ ...route, source: 'label' }, t0);
      assert.equal(await runBrew(mashSetup(), shell(behave.succeed()), mash(12)), 5);
      assert.deepStrictEqual(started, []);
      assert.equal(
        lines.at(-1),
        'foedrum mash: batch 12-1 of #12 already brews the recipe stout; foedrum recipe 12-1 <recipe> <reason> brews it with another',
      );
    });

    it('refuses a Brewery with one recipe to offer, ordering nothing: exit 5', async () => {
      const one = mashSetup({ only: 'stout' });
      assert.equal(await runBrew(one, shell(behave.succeed()), mash(13)), 5, lines.join('\n'));
      assert.equal(log().state().batches.size, 0);
      assert.equal(
        lines.at(-1),
        'foedrum mash: the Brewery has one recipe to offer, stout: label #13 recipe:stout to brew it (decoction comes with #587)',
      );
    });

    const refusals: [string, Parameters<typeof mashSetup>[0], string][] = [
      ['without mash-in', { only: 'stout', keep: 'nip' }, 'the Brewery has no recipe mash-in'],
      [
        'with no recipe to offer',
        { only: 'none' },
        'the Brewery has no recipe to offer but mash-in (decoction comes with #587)',
      ],
    ];
    for (const [what, fields, line] of refusals) {
      it(`refuses a Brewery ${what}, ordering nothing: exit 5`, async () => {
        const refusing = mashSetup(fields);
        assert.equal(await runBrew(refusing, shell(behave.succeed()), mash(13)), 5);
        assert.equal(log().state().batches.size, 0);
        assert.equal(lines.at(-1), `foedrum mash: ${line}`);
      });
    }

    it("labels a claimed order's Brewery issue once its question is answered, never the target issue", async () => {
      const web = { alias: 'web', intake: { labels: ['foedrum'] } };
      api = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            { number: 40, labels: [], author: 'ann', title: 'Dark theme', body: 'web#7' },
          ],
          'acme/web': [
            { number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark theme', body: 'Dark.' },
          ],
        },
      });
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      log().issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } }, t0);
      const claimed = mashSetup({ config: config({}, web) });
      assert.equal(await runBrew(claimed, shell(behave.needInput([which(40)])), mash(40)), 4);
      const answers = [{ q: which(40).q, answer: 'stout' }];
      const answer = {
        kind: 'answer',
        batchId: 'web-7',
        by: 'ann',
        via: 'terminal',
        answers,
      } as const;
      const answered = createCommandLog({ store, recipes: claimed.recipes }).issue(answer, t0);
      assert.equal(answered.kind, 'accepted', JSON.stringify(answered));
      const again = shell(behave.succeed(), { lock: () => fakeLock('ann') });
      const brew = { ...request, target: { alias: 'web', issue: 7 } };
      assert.equal(await runBrew(claimed, again, brew), 0, lines.join('\n'));
      const recipes = (repo: string, issue: number) =>
        (api.issue(repo, issue)?.labels ?? []).filter((label) => label.startsWith('recipe:'));
      assert.deepStrictEqual(recipes('acme/brewery', 40), ['recipe:stout']);
      assert.deepStrictEqual(recipes('acme/web', 7), []);
    });
  });

  describe('a target issue (ADR 0105)', () => {
    const web = { alias: 'web', intake: { labels: ['foedrum'] } };
    const targetSetup = (): ServeSetup => {
      const result = serveSetup(
        serveInputs({
          files: {
            ...serveInputs().files,
            config: config({}, web),
            local: local({ workRoot: dir.path }),
          },
        }),
      );
      return result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    };
    const github = () =>
      fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/web': [
            {
              number: 7,
              labels: ['foedrum', 'recipe:stout'],
              author: 'ann',
              title: 'Add a dark theme',
              body: 'Add a dark theme.',
            },
          ],
        },
      });
    const target = { ...request, target: { alias: 'web', issue: 7 } };

    /**
     * Brews the claimed web#7, which waits for its Brewery issue's label (ADR 0156), labels that
     * issue `recipe:stout`, and brews it again by it (ADR 0240): the second run's exit code.
     */
    const brewLabelled = async (host: FakeGitHubApi, brewing: ServeSetup): Promise<number> => {
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(brewing, claimed, target), 5, lines.join('\n'));
      const [order] = host.issues['acme/brewery'] ?? [];
      assert.ok(order !== undefined, 'its Brewery issue is opened');
      order.labels.push('recipe:stout');
      const again = shell(behave.succeed(), {
        gh: ghOver(host.fetch).exec,
        lock: () => fakeLock('ann'),
      });
      return runBrew(brewing, again, { ...request, target: { issue: order.number } });
    };

    it('claims it before it orders it, as foedrum order does, and brews it on tap by its Brewery issue: exit 0', async () => {
      const host = github();
      assert.equal(await brewLabelled(host, targetSetup()), 0, lines.join('\n'));
      assert.deepStrictEqual(host.created, ['acme/web refs/foedrum/claims/issues/7']);
      const batches = [...log().state().batches.values()];
      assert.deepStrictEqual(
        batches.map(({ id, repo, issue, lane }) => ({ id, repo, issue, lane: lane.kind })),
        [{ id: 'web-7', repo: 'acme/web', issue: 7, lane: 'on_tap' }],
      );
      assert.ok(
        lines.includes('foedrum brew: ordered acme/web#7 as batch web-7'),
        lines.join('\n'),
      );
    });

    it("prints the link to the status comment on the claimed issue's Brewery issue (#413)", async () => {
      const host = github();
      const brewing = targetSetup();
      assert.equal(await brewLabelled(host, brewing), 0, lines.join('\n'));
      const [order] = host.issues['acme/brewery'] ?? [];
      const [comment] = host.comments.get(`acme/brewery#${order?.number}`) ?? [];
      assert.ok(comment !== undefined, 'a status comment on the Brewery issue');
      const link = `https://github.com/${brewing.brewery}/issues/${order?.number}#issuecomment-${comment.id}`;
      const shown = lines.filter((line) => line === `foedrum brew: status comment: ${link}`);
      assert.equal(shown.length, 1, lines.join('\n'));
    });

    it('brews a claimed order by its Brewery issue, as its claimed batch, on tap: exit 0 (ADR 0240)', async () => {
      const host = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            { number: 40, labels: ['recipe:stout'], author: 'ann', title: 'Dark', body: 'web#7' },
          ],
          'acme/web': [
            { number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark', body: 'Dark.' },
          ],
        },
      });
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      log().issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } }, t0);
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      const byOrder = { ...request, target: { issue: 40 } };
      assert.equal(await runBrew(targetSetup(), claimed, byOrder), 0, lines.join('\n'));
      const batches = [...log().state().batches.values()];
      assert.deepStrictEqual(
        batches.map(({ id, lane }) => ({ id, lane: lane.kind })),
        [{ id: 'web-7', lane: 'on_tap' }],
      );
    });

    it("routes an Ordered claimed batch by its recorded Brewery issue's label, brewed by its target issue: exit 0 (ADR 0156)", async () => {
      const host = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            { number: 40, labels: ['recipe:stout'], author: 'ann', title: 'Dark', body: 'web#7' },
          ],
          'acme/web': [
            { number: 7, labels: ['foedrum', 'recipe:nip'], author: 'ann', title: 'Dark' },
          ],
        },
      });
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      log().issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } }, t0);
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 0, lines.join('\n'));
      assert.equal(log().state().batches.get('web-7')?.recipe?.name, 'stout');
    });

    it('brews a claimed batch routed before its Brewery issue is recorded, without waiting for a label: exit 0', async () => {
      const host = github();
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const route = { kind: 'route', batchId: 'web-7', recipe: 'stout', reason: 'label' } as const;
      log().issue({ ...route, source: 'label' }, t0);
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 0, lines.join('\n'));
      assert.equal(log().state().batches.get('web-7')?.lane.kind, 'on_tap');
      assert.ok(!lines.some((line) => line.includes('waits for')), lines.join('\n'));
    });

    it('orders a claimed issue, opens its Brewery issue and waits there for its recipe label, never routing by the target issue: exit 5 (ADR 0156)', async () => {
      const host = github();
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 5, lines.join('\n'));
      const [order] = host.issues['acme/brewery'] ?? [];
      assert.ok(order !== undefined, 'its Brewery issue is opened');
      const batch = log().state().batches.get('web-7');
      assert.deepStrictEqual(
        { lane: batch?.lane.kind, recipe: batch?.recipe },
        { lane: 'ordered', recipe: undefined },
      );
      assert.deepStrictEqual(started, []);
      assert.equal(
        lines.at(-1),
        `foedrum brew: acme/web#7 waits for a recipe:<name> label on its Brewery issue #${order.number}; label it and brew ${order.number}, or foedrum mash web#7`,
      );
    });

    it('never routes an Ordered claimed batch whose Brewery issue is not recorded yet by the label of its target issue (ADR 0156)', async () => {
      const host = github();
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 5, lines.join('\n'));
      // Its target issue carries recipe:stout: a run that read it to route would say so.
      assert.ok(!lines.some((line) => line.includes('routed')), lines.join('\n'));
      assert.equal(log().state().batches.get('web-7')?.recipe, undefined);
      const [order] = host.issues['acme/brewery'] ?? [];
      assert.equal(
        lines.at(-1),
        `foedrum brew: acme/web#7 waits for a recipe:<name> label on its Brewery issue #${order?.number}; label it and brew ${order?.number}, or foedrum mash web#7`,
      );
    });

    it('fails, routing nothing, when the Brewery issue of a claimed order cannot be opened: exit 1', async () => {
      const host = fakeGitHubApi({
        login: 'ann',
        issues: github().issues,
        instead: (method, url) =>
          method === 'POST' && url.pathname.toLowerCase() === '/repos/acme/brewery/issues'
            ? { status: 500, body: { message: 'Server Error' } }
            : undefined,
      });
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 1, lines.join('\n'));
      assert.equal(log().state().batches.get('web-7')?.recipe, undefined);
      assert.deepStrictEqual(host.issues['acme/brewery'] ?? [], []);
      assert.ok(
        lines.some((line) => line.includes('"order.issue"] failed: GitHub answered 500')),
        lines.join('\n'),
      );
      assert.equal(
        lines.at(-1),
        'foedrum brew: acme/web#7 waits for its Brewery issue, which is not open yet; brew web#7 again',
      );
    });

    /** The live lease of the claimed batch web-7. */
    const webLease = () => store.batchLeases(t0).find(({ batchId }) => batchId === 'web-7');

    it('lets a claimed batch go once it waits for a label on its Brewery issue, holding no lease: exit 5 (ADR 0123)', async () => {
      const host = github();
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 5, lines.join('\n'));
      assert.match(lines.at(-1) ?? '', /waits for a recipe:<name> label on its Brewery issue #/);
      assert.equal(webLease(), undefined);
    });

    it('lets a claimed batch go when its Brewery issue is not open yet, holding no lease: exit 1 (ADR 0123)', async () => {
      const host = fakeGitHubApi({
        login: 'ann',
        issues: github().issues,
        instead: (method, url) =>
          method === 'POST' && url.pathname.toLowerCase() === '/repos/acme/brewery/issues'
            ? { status: 500, body: { message: 'Server Error' } }
            : undefined,
      });
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 1, lines.join('\n'));
      assert.match(lines.at(-1) ?? '', /waits for its Brewery issue, which is not open yet/);
      assert.equal(webLease(), undefined);
    });

    it('refuses it, ordering nothing, when another holds its claim: exit 5', async () => {
      const host = github();
      // Another Brewery's claim: its record as a commit, and the ref at it (ADR 0043).
      const api = 'https://api.github.com/repos/acme/web/git';
      const claimedAt = t0.toISOString();
      const record = JSON.stringify({ brewery: 'other/brewery', issue: 7, claimedAt });
      const commit = await host.fetch(`${api}/commits`, {
        method: 'POST',
        body: JSON.stringify({ message: record, tree: 'x', parents: [] }),
      });
      const { sha } = (await commit.json()) as { sha: string };
      await host.fetch(`${api}/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: 'refs/foedrum/claims/issues/7', sha }),
      });
      const taken = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), taken, target), 5, lines.join('\n'));
      assert.equal(log().state().batches.size, 0);
      assert.equal(lines.at(-1), 'foedrum brew: acme/web#7 is claimed by other/brewery');
    });
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
    assert.equal(await runBrew(setup, broken, request), 1);
    assert.equal(lines.at(-1), 'foedrum brew: the state branch is gone');
    assert.equal(lock.held, false);
  });

  it('refuses a recipe label that names no recipe of the Brewery, ordering nothing: exit 5', async () => {
    const typo = { ...request, target: { issue: 15 } };
    assert.equal(await runBrew(setup, shell(behave.succeed()), typo), 5);
    assert.equal(log().state().batches.size, 0);
    assert.equal(
      lines.at(-1),
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
    assert.equal(await runBrew(setup, shell(behave.needInput([sneaky])), request), 4);
    // The brewer's lines stay three, each with its breaks escaped: none is the forged one.
    assert.ok(!lines.includes(forged), lines.join('\n'));
    const breaks = [0x0a, 0x2028, 0x2029];
    assert.ok(
      lines.every((line) => [...line].every((char) => !breaks.includes(char.codePointAt(0) ?? 0))),
      lines.join('\n'),
    );
    assert.deepStrictEqual(lines.slice(-3), [
      `foedrum brew:   1. Which name?\\u000a${forged} (a, b\\u2028${forged}; recommended: a)`,
      `foedrum brew:      why it blocks: It matters\\u2029${forged}`,
      'foedrum brew: answer them in order with foedrum answer 12-1 <answer 1>, then brew again',
    ]);
  });

  describe('an interactive step (ADR 0222)', () => {
    // A cellarman with attempts to spare, whose refine step is a person's session.
    const lauter = JSON.stringify({
      name: 'lauter',
      description: 'Refines an order with a person, then opens its pull request.',
      steps: [
        { id: 'refine', brewer: 'steward', interactive: true, prompt: 'Refine it with me.' },
        { action: 'openPullRequest' },
      ],
      testFirst: false,
    });
    const steward = brewer
      .replace('"cellarman"', '"steward"')
      .replace('"maxAttempts": 1', '"maxAttempts": 3');
    /** The Brewery with the lauter recipe and `stewardText` as its steward. */
    const lauterSetup = (stewardText: string): ServeSetup => {
      const inputs = serveInputs({
        files: { ...serveInputs().files, local: local({ workRoot: dir.path }) },
      });
      const { brewery } = inputs.files;
      const result = serveSetup({
        ...inputs,
        files: {
          ...inputs.files,
          brewery: {
            ...brewery,
            recipes: [...brewery.recipes, { path: 'recipes/lauter.jsonc', text: lauter }],
            brewers: [...brewery.brewers, { path: 'brewers/steward.md', text: stewardText }],
          },
        },
      });
      return result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    };
    beforeEach(() => {
      setup = lauterSetup(steward);
      api = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            {
              number: 12,
              labels: ['recipe:lauter'],
              author: 'ann',
              title: 'Lauter',
              body: 'Plan it.',
            },
          ],
        },
      });
    });
    const resumedBy = () =>
      store
        .eventsAfter(0)
        .flatMap(({ event }) =>
          event.type === 'batch.resumed' ? [`${event.action} by ${event.by} via ${event.via}`] : [],
        );

    it('opens the session on a terminal and goes on from its out doc to on tap: exit 0', async () => {
      assert.equal(await runBrew(setup, shell(behave.succeed('Refined')), request), 0);
      assert.deepStrictEqual(started, ['refine#1']);
      const opened = store
        .eventsAfter(0)
        .find(({ event }) => event.type === 'step.started' && event.stepId === 'refine');
      assert.equal(
        opened?.event.type === 'step.started' ? opened.event.interactiveSince : undefined,
        t0.toISOString(),
      );
    });

    it('parks the batch without a terminal, starting nothing, and says why: exit 3', async () => {
      const piped = { ...request, noSessions: 'no-terminal' } as const;
      assert.equal(await runBrew(setup, shell(behave.succeed()), piped), 3);
      assert.deepStrictEqual(started, []);
      assert.match(
        lines.at(-2) ?? '',
        /^foedrum brew: batch 12-1 is stuck: waiting for a session at refine: foedrum brew 12 --take opens it in a terminal; reminder [^;]+; options: retry, /,
      );
      assert.equal(
        lines.at(-1),
        'foedrum brew: stdin is not a terminal, and claude needs one: run foedrum brew #12 in a terminal',
      );
    });

    it('parks the batch inside Claude Code, and names the brew to run in a terminal: exit 3', async () => {
      const inside = { ...request, noSessions: 'claude-code' } as const;
      assert.equal(await runBrew(setup, shell(behave.succeed()), inside), 3);
      assert.equal(
        lines.at(-1),
        'foedrum brew: run foedrum brew #12 in a terminal to open its session',
      );
    });

    it('waits for a session again, never retrying by itself, when the session closes without an out doc: exit 3', async () => {
      assert.equal(await runBrew(setup, shell(behave.fail(true)), request), 3);
      assert.deepStrictEqual(started, ['refine#1']);
      assert.equal(log().state().batches.get('12-1')?.lane.kind, 'stuck');
      assert.equal(lines.at(-1), 'foedrum brew: run foedrum brew #12 again to reopen the session');
    });

    it('retries a batch it finds waiting for a session at its start, as the person, and opens the session: exit 0', async () => {
      const piped = { ...request, noSessions: 'no-terminal' } as const;
      assert.equal(await runBrew(setup, shell(behave.succeed()), piped), 3);
      const again = shell(behave.succeed('Refined'), { lock: () => fakeLock('ann') });
      assert.equal(await runBrew(setup, again, request), 0);
      assert.deepStrictEqual(resumedBy(), ['retry by ann via terminal']);
      assert.deepStrictEqual(started, ['refine#2']);
      assert.ok(
        lines.includes('foedrum brew: batch 12-1 waits for a session at refine; opening it'),
        String(lines),
      );
    });

    it('reopens the session fresh, with the whole prompt, also for a brewer with retryMode resume (ADR 0222)', async () => {
      setup = lauterSetup(
        steward.replace('"maxAttempts": 3', '"maxAttempts": 3,\n  "retryMode": "resume"'),
      );
      assert.equal(await runBrew(setup, shell(behave.fail(true)), request), 3);
      const again = shell(behave.succeed('Refined'), { lock: () => fakeLock('ann') });
      assert.equal(await runBrew(setup, again, request), 0, String(lines));
      const reopened = store
        .eventsAfter(0)
        .flatMap(({ event }) =>
          event.type === 'step.started' && event.stepId === 'refine' && event.attempt === 2
            ? [event]
            : [],
        );
      assert.equal(reopened.length, 1);
      assert.equal(reopened[0]?.session?.resumes, undefined);
      // Never even asked to resume: a fallback would say why it could not (ADR 0117).
      assert.equal(reopened[0]?.session?.fallback, undefined);
      assert.ok(reopened[0]?.worktree !== undefined, 'a fresh session gets a worktree of its own');
    });

    it('leaves a batch waiting for a session to the person when it opens none: exit 3', async () => {
      const piped = { ...request, noSessions: 'no-terminal' } as const;
      assert.equal(await runBrew(setup, shell(behave.succeed()), piped), 3);
      const again = shell(behave.succeed(), { lock: () => fakeLock('ann') });
      assert.equal(await runBrew(setup, again, piped), 3, String(lines));
      assert.deepStrictEqual(resumedBy(), []);
      assert.deepStrictEqual(started, []);
    });
  });

  it('drives on, as the same owner, the batch it left needing input once it is answered: exit 0', async () => {
    assert.equal(await runBrew(setup, shell(behave.needInput()), request), 4);
    const answers = [{ q: question.q, answer: 'sqlite' }];
    log().issue({ kind: 'answer', batchId: '12-1', by: 'ann', via: 'terminal', answers }, t0);
    const before = lines.length;
    // The next process of the same owner takes the lock again.
    const again = shell(behave.succeed(), { lock: () => fakeLock('ann') });
    assert.equal(await runBrew(setup, again, request), 0);
    const second = lines.slice(before);
    assert.ok(!second.some((line) => /ordered|routed|driven by/.test(line)), second.join('\n'));
    assert.deepStrictEqual(started, ['brew#1', 'brew#2']);
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
        local: local({ workRoot: dir.path }),
        brewery: { ...files.brewery, brewers: [{ path: 'brewers/cellarman.md', text }] },
      },
    });
    const ready = serveSetup(inputs);
    const answering = ready.kind === 'ready' ? ready.setup : assert.fail(JSON.stringify(ready));
    const runnerOf = (brew: Behaviour) =>
      fakeBrewerRunner(
        (attempt) => {
          started.push(`${attempt.ref.stepId}#${attempt.ref.attempt}`);
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
    return store
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
        if (waits > 20) assert.fail(`brew did not stop:\n${lines.join('\n')}`);
      },
    });
    assert.equal(await runBrew(setup, cancelled, request), 6);
    assert.equal(lines.at(-1), 'foedrum brew: batch 12-1 was cancelled by bob via terminal');
  });

  it('refuses the batch, naming its new driver, when another driver takes it while it brews: exit 5', async () => {
    const expiresAt = new Date(t0.getTime() + 60_000);
    const running = behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0 });
    const taken = shell(running, {
      wait: async () => {
        // The lease of a driver that took the batch, as an expired lease of this one would let it.
        store.withTransaction((tx) =>
          tx.putBatchLease({ batchId: '12-1', owner: 'cellar', expiresAt }),
        );
      },
    });
    assert.equal(await runBrew(setup, taken, request), 5);
    assert.equal(
      lines.at(-1),
      `foedrum brew: batch 12-1 is driven by cellar until ${expiresAt.toISOString()}`,
    );
  });

  it('records the end of the run it stops when the batch is taken over to resume its step, before it refuses the batch (ADR 0127)', async () => {
    // A run whose stop ends it a wait later, as a process tree takes a moment to go.
    let ending: (() => void) | undefined;
    const runner = {
      start: ({ ref }: { ref: { stepId: string; attempt: number } }) => {
        started.push(`${ref.stepId}#${ref.attempt}`);
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
        if (waits > 20) assert.fail(`brew did not stop:\n${lines.join('\n')}`);
      },
    });
    assert.equal(await runBrew(setup, taken, request), 5);
    assert.ok(
      store
        .eventsAfter(0)
        .some(({ event }) => event.type === 'step.finished' && event.stepId === 'brew'),
      'the stopped brew#1 is recorded',
    );
    assert.deepStrictEqual(store.currentLeases(t0), [], 'and its lease let go');
    assert.equal(lines.at(-1)?.startsWith('foedrum brew: batch 12-1 is driven by bob until'), true);
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
        if (waits > 20) assert.fail(`brew did not stop:\n${lines.join('\n')}`);
      },
    });
    assert.equal(await runBrew(setup, taken, request), 5);
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
        if (waits.length > 400) assert.fail(`brew did not stop:\n${lines.join('\n')}`);
      },
    });
    assert.equal(await runBrew(setup, taken, request), 5);
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
    assert.equal(await runBrew(setup, taken, request), 1);
    assert.ok(flushes >= 5, `${flushes} ticks in ${waits} redraws`);
  });

  it('refuses at once a batch taken over to resume no step, waiting for no run (ADR 0124)', async () => {
    assert.equal(await takenWithEndlessRun(false), 1);
  });

  it('refuses at once a batch whose resuming owner let it go to another driver (ADR 0127)', async () => {
    const until = new Date(t0.getTime() + 600_000);
    const third = () =>
      store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: '12-1', owner: 'session-7', expiresAt: until }),
      );
    assert.equal(await takenWithEndlessRun(true, third), 1);
  });

  it('goes on recording the end of the run it stopped when a tick fails while it waits (ADR 0127)', async () => {
    // The two ticks after the takeover fail: the main loop's, then the first of the wait's.
    let failing = 0;
    const inner = store;
    store = {
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
        if (waits > 20) assert.fail(`brew did not stop:\n${lines.join('\n')}`);
      },
    });
    assert.equal(await runBrew(setup, taken, request), 5, lines.join('\n'));
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
      store.withTransaction((tx) =>
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
      assert.equal(await runBrew(setup, moving, takes), 0);
      const handovers = store
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
      assert.ok(lines.includes('foedrum brew: took batch 12-1 over from cellar'), lines.join('\n'));
      assert.equal(started.length > 0, true);
    });

    it('takes nothing over when it refuses the batch for its labels: exit 5', async () => {
      log().issue({ kind: 'order', batchId: '14-1', order: { issue: 14 } }, t0);
      store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: '14-1', owner: 'cellar', expiresAt: cellarUntil }),
      );
      const two = { ...takes, target: { issue: 14 } };
      assert.equal(await runBrew(setup, shell(behave.succeed()), two), 5);
      assert.ok(!store.eventsAfter(0).some(({ event }) => event.type === 'batch.taken_over'));
      assert.equal(
        store.batchLeases(t0).find(({ batchId }) => batchId === '14-1')?.owner,
        'cellar',
      );
    });

    /** serve's shell whose gh read of issue 12, for its labels, does `meanwhile` first. */
    const readingLabels = (meanwhile: () => void): Partial<ServeShell> => {
      const gh = ghOver(api.fetch).exec;
      return {
        gh: (...args: Parameters<typeof gh>) => {
          if (JSON.stringify(args).includes('issues/12')) meanwhile();
          return gh(...args);
        },
      };
    };

    it("brews on, taking nothing over, when the holder's lease lapsed while it read the labels: exit 0", async () => {
      const lapsed = readingLabels(() =>
        store.withTransaction((tx) => tx.releaseBatchLease('12-1')),
      );
      assert.equal(await runBrew(setup, shell(behave.succeed(), lapsed), takes), 0);
      assert.ok(!store.eventsAfter(0).some(({ event }) => event.type === 'batch.taken_over'));
    });

    it('refuses with the reason, leaving the lease, when the takeover is refused while the holder still holds it: exit 5', async () => {
      const cancelled = readingLabels(() => {
        log().issue({ kind: 'cancel', batchId: '12-1', by: 'bob', via: 'terminal' }, t0);
      });
      assert.equal(await runBrew(setup, shell(behave.succeed(), cancelled), takes), 5);
      assert.equal(
        lines.at(-1),
        'foedrum brew: batch 12-1 is cancelled; take over needs it ordered, brewing, conditioning or stuck',
      );
      assert.equal(leaseOf()?.owner, 'cellar');
    });

    it('brews as before when no other driver holds the batch, recording no handover', async () => {
      store.withTransaction((tx) => tx.releaseBatchLease('12-1'));
      assert.equal(await runBrew(setup, shell(behave.succeed()), takes), 0);
      assert.ok(!store.eventsAfter(0).some(({ event }) => event.type === 'batch.taken_over'));
    });
  });
});
