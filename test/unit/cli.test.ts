// The `foedrum` command line through runCli with fake facts and an in-memory event store
// (ADR 0021): the command registry, argument errors, and each command's output as a snapshot
// (cli.test.ts.snapshot; `node --test --test-update-snapshots` rewrites it, so review the diff).
// The real program is in test/integration/doctor.test.ts.

import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { commands } from '../../src/cli/commands.ts';
import { type CliContext, type CliResult, runCli } from '../../src/cli/run.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';
import { linux, ran, windows } from '../helpers/doctor-facts.ts';

const cwd = join(sep, 'work', 'brewery');
const storePath = join(cwd, '.foedrum', 'index.db');

// The same text on every platform: the store's path is the one thing built with node:path.
const normalise = (text: string): string =>
  text.replaceAll(storePath, '<brewery>/.foedrum/index.db');

const snapshot = (t: TestContext, text: string): void =>
  t.assert.snapshot(normalise(text), { serializers: [(value) => String(value)] });

const storeWith = (events: readonly Event[]): EventStore => {
  const store = openSqliteEventStore(':memory:');
  store.withTransaction((tx) => {
    for (const event of events) tx.append(event);
  });
  return store;
};

// A store whose close is counted instead of done, so the test can still read it afterwards.
const watchedStore = (events: readonly Event[]) => {
  const inner = storeWith(events);
  let closed = 0;
  const store: EventStore = {
    ...inner,
    close: () => {
      closed++;
    },
  };
  const afterRun = () => {
    const lastEventId = inner.lastEventId();
    inner.close();
    return { closed, lastEventId };
  };
  return { store, afterRun };
};

const context = (overrides: Partial<CliContext> = {}): CliContext => ({
  cwd,
  gatherDoctorFacts: async () => linux(),
  openStore: () => undefined,
  openWritableStore: () => undefined,
  recipes: () => ({ find: () => undefined }),
  brewers: () => assert.fail('no brewer files to read'),
  user: () => 'ada',
  surface: 'terminal',
  now: () => new Date(D1),
  zone: () => 'UTC',
  readKeptBranches: async () => assert.fail('no kept branch to read'),
  config: () => assert.fail('no foedrum.jsonc to read'),
  claims: () => assert.fail('no claim host to reach'),
  queue: () => assert.fail('no queue to read'),
  serve: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  brew: async () => assert.fail('no brew here'),
  watch: async () => assert.fail('no watch here'),
  resume: async () => assert.fail('no session to resume'),
  init: async () => assert.fail('no init here'),
  env: {},
  ...overrides,
});

const run = (argv: string[], overrides: Partial<CliContext> = {}): Promise<CliResult> =>
  runCli(argv, context(overrides));

// A command line error: exit 2, one line on stderr, nothing on stdout.
const assertUsageError = (result: CliResult, line: string): void => {
  assert.deepEqual(result, { exitCode: 2, stdout: '', stderr: `${line}\n` });
};

const D1 = '2026-10-15T10:00:00.000Z';
const D2 = '2026-10-15T12:00:00.000Z';
const REMIND = '2026-10-17T09:00:00.000Z';
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const ordered = (issue: number, parentBatchId?: string): Event => ({
  type: 'batch.ordered',
  batchId: `${issue}-1`,
  order: { issue },
  routeBy: '2026-12-31T00:00:00.000Z',
  ...(parentBatchId === undefined ? {} : { parentBatchId }),
});

const stuck = (
  issue: number,
  reason: Extract<Event, { type: 'batch.stuck' }>['reason'],
): Event => ({
  type: 'batch.stuck',
  batchId: `${issue}-1`,
  reason,
  options: ['retry', 'cancel'],
  remindAt: REMIND,
});

const waiting = (issue: number, on: Extract<Event, { type: 'batch.waiting' }>['on']): Event => ({
  type: 'batch.waiting',
  batchId: `${issue}-1`,
  on,
  remindAt: REMIND,
});

// A batch in every lane, with every reason a batch waits or is Stuck. Store ids are positions + 1.
const brewery: Event[] = [
  ordered(11),
  // 12-1: brewing, after a failed and a succeeded plan; ids 2 to 12.
  ordered(12),
  {
    type: 'batch.recipe_chosen',
    batchId: '12-1',
    recipe: 'feature',
    reason: 'label recipe:feature',
    source: 'label',
  },
  { type: 'step.scheduled', batchId: '12-1', stepId: 'plan', attempt: 1, deadlineAt: D1 },
  { type: 'step.started', batchId: '12-1', stepId: 'plan', attempt: 1 },
  {
    type: 'step.finished',
    batchId: '12-1',
    stepId: 'plan',
    attempt: 1,
    outcome: { kind: 'failed', retryable: true, reason: 'the out doc is missing' },
  },
  { type: 'step.scheduled', batchId: '12-1', stepId: 'plan', attempt: 2, deadlineAt: D1 },
  { type: 'step.started', batchId: '12-1', stepId: 'plan', attempt: 2 },
  {
    type: 'step.finished',
    batchId: '12-1',
    stepId: 'plan',
    attempt: 2,
    outcome: { kind: 'succeeded', output: {} },
  },
  { type: 'step.scheduled', batchId: '12-1', stepId: 'implement', attempt: 1, deadlineAt: D2 },
  { type: 'step.started', batchId: '12-1', stepId: 'implement', attempt: 1 },
  {
    type: 'effect.applied',
    key: JSON.stringify(['12-1', 'implement', 1, 'push']),
    result: { commit: SHA },
  },
  ordered(13),
  waiting(13, { kind: 'release', repo: 'acme/lib', package: '@acme/lib', minVersion: '2.4.0' }),
  // 14-1: a sub-order batch rewound after its deadline passed; ids 15 to 19.
  ordered(14, '12-1'),
  {
    type: 'batch.recipe_chosen',
    batchId: '14-1',
    recipe: 'bugfix',
    reason: 'a smaller fix will do',
    source: 'human',
    by: 'alice',
    via: 'terminal',
  },
  { type: 'step.scheduled', batchId: '14-1', stepId: 'plan', attempt: 1, deadlineAt: D1 },
  {
    type: 'batch.stuck',
    batchId: '14-1',
    reason: { kind: 'deadline_passed', stepId: 'plan', deadlineAt: D1 },
    options: ['retry', 'rewind', 'cancel'],
    remindAt: REMIND,
  },
  {
    type: 'batch.rewound',
    batchId: '14-1',
    toStepId: 'plan',
    by: 'alice',
    via: 'plugin',
    shas: { 'acme/app': SHA },
  },
  ordered(15),
  stuck(15, {
    kind: 'needs_input',
    stepId: 'plan',
    questions: [
      {
        q: 'Which database?',
        options: ['sqlite', 'postgres'],
        recommended: 'sqlite',
        whyBlocking: 'The schema depends on it',
      },
    ],
  }),
  ordered(16),
  { type: 'batch.on_tap', batchId: '16-1', pullRequests: ['https://github.com/acme/app/pull/7'] },
  ordered(17),
  { type: 'batch.cancelled', batchId: '17-1', by: 'bob', via: 'comment' },
  ordered(18),
  waiting(18, { kind: 'merge', pullRequest: 'https://github.com/acme/app/pull/8' }),
  ordered(19),
  waiting(19, { kind: 'sibling', batchId: '13-1' }),
  ordered(20),
  stuck(20, {
    kind: 'blocked',
    stepId: 'review',
    blockerKind: 'environment',
    summary: 'denied Bash(curl)',
  }),
  ordered(21),
  stuck(21, { kind: 'attempts_exhausted', stepId: 'test', attempts: 3, lastReason: 'tests fail' }),
  ordered(22),
  stuck(22, { kind: 'waiting_for_session', stepId: 'analyze' }),
  ordered(23),
  stuck(23, {
    kind: 'stalled',
    stepId: 'implement',
    lastProgressAt: '2026-10-15T11:00:00.000Z',
    turnsWithoutProgress: 12,
  }),
  ordered(24),
  stuck(24, { kind: 'deadline_passed', stepId: 'plan', deadlineAt: D1 }),
  ordered(25),
  stuck(25, { kind: 'routing', deadlineAt: D1 }),
];

// The fold refuses it: an attempt that was never scheduled starts.
const invalidLog: Event[] = [
  ordered(11),
  { type: 'step.started', batchId: '11-1', stepId: 'plan', attempt: 1 },
];

describe('foedrum: the command line', () => {
  it('lists the commands for --help and -h', async (t) => {
    const help = await run(['--help']);
    assert.equal(help.exitCode, 0);
    assert.equal(help.stderr, '');
    snapshot(t, help.stdout);
    assert.deepEqual(await run(['-h']), help);
    // The option every command of the registry takes (ADR 0125).
    assert.match(help.stdout, /^Every command takes --via <plugin\|terminal>/m);
  });

  it('runs foedrum serve through its context, with its exit code (ADR 0063)', async () => {
    const result = { exitCode: 1, stdout: '', stderr: 'foedrum serve: no brewery\n' };
    let served = 0;
    const serve = async () => {
      served++;
      return result;
    };
    assert.deepEqual(await run(['serve'], { serve }), result);
    assert.equal(served, 1);
  });

  it('runs foedrum init through its context, with no argument (ADR 0199)', async () => {
    const result = { exitCode: 1, stdout: '', stderr: '' };
    let ran = 0;
    const init = async () => {
      ran++;
      return result;
    };
    assert.deepEqual(await run(['init'], { init }), result);
    assert.equal(ran, 1);
    assertUsageError(
      await run(['init', 'now'], { init }),
      'foedrum init: unexpected argument "now"',
    );
    const command = commands.find(({ name }) => name === 'init');
    assert.equal(command?.changesState, false);
  });

  it('gives foedrum init its answers as options, repeated ones as lists, and carries it in the plugin (ADR 0212)', async () => {
    const inputs: unknown[] = [];
    const init = async (input: unknown) => {
      inputs.push(input);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const argv = [
      'init',
      '--brewery',
      'acme/brewery',
      '--visibility',
      'private',
      '--targets',
      'acme/web acme/api',
      '--alias',
      'acme/web=web',
      '--alias',
      'acme/api=api',
      '--use-checks',
      'acme/web=y',
      '--check',
      'acme/api:build=make',
      '--change',
      '.gitignore=n',
      '--label',
      'acme/web=y',
      '--push',
      'y',
      '--shim',
      '1',
      '--repoint',
      'n',
      '--no-input',
      '--via',
      'plugin',
    ];
    assert.equal((await run(argv, { init })).exitCode, 0);
    assert.deepStrictEqual(inputs, [
      {
        command: 'init',
        brewery: 'acme/brewery',
        visibility: 'private',
        targets: 'acme/web acme/api',
        alias: ['acme/web=web', 'acme/api=api'],
        'use-checks': ['acme/web=y'],
        check: ['acme/api:build=make'],
        change: ['.gitignore=n'],
        label: ['acme/web=y'],
        push: 'y',
        shim: '1',
        repoint: 'n',
        'no-input': true,
      },
    ]);
    assert.equal(commands.find(({ name }) => name === 'init')?.terminalOnly, undefined);
  });

  it('runs foedrum resume through its context, with or without its step (ADR 0126)', async () => {
    const inputs: unknown[] = [];
    const resume = async (input: unknown) => {
      inputs.push(input);
      return { exitCode: 3, stdout: '', stderr: '' };
    };
    assert.equal((await run(['resume', '12-1'], { resume })).exitCode, 3);
    assert.equal((await run(['resume', '12-1', 'plan#2'], { resume })).exitCode, 3);
    assert.deepEqual(inputs, [
      { command: 'resume', batch: '12-1' },
      { command: 'resume', batch: '12-1', step: 'plan#2' },
    ]);
    assertUsageError(
      await run(['resume', '12-1', 'plan', 'now'], { resume }),
      'foedrum resume: unexpected argument "now"',
    );
    assertUsageError(await run(['resume'], { resume }), 'foedrum resume: missing <batch>');
  });

  it('refuses an argument to foedrum serve, which takes none', async () => {
    assertUsageError(await run(['serve', 'now']), 'foedrum serve: unexpected argument "now"');
    assertUsageError(await run(['serve', '--now']), 'foedrum serve: unknown option "--now"');
    // --via is the registry's commands' (ADR 0125).
    assertUsageError(
      await run(['serve', '--via', 'plugin']),
      'foedrum serve: unknown option "--via"',
    );
  });

  it('lists the commands for --help after a command', async () => {
    assert.deepEqual(await run(['replay', '--help']), await run(['--help']));
  });

  it('refuses a missing command', async () => {
    assertUsageError(
      await run([]),
      'foedrum: no command given; run foedrum --help for the commands',
    );
  });

  it('refuses an unknown command', async () => {
    assertUsageError(
      await run(['pour', '13']),
      'foedrum: unknown command "pour"; run foedrum --help for the commands',
    );
  });

  it('refuses an unknown option before the command', async () => {
    assertUsageError(
      await run(['--verbose', 'status']),
      'foedrum: unknown option "--verbose"; run foedrum --help for the commands',
    );
  });

  it('refuses an unknown option of a command, long or short', async () => {
    assertUsageError(await run(['status', '--json']), 'foedrum status: unknown option "--json"');
    assertUsageError(await run(['doctor', '-v']), 'foedrum doctor: unknown option "-v"');
    assertUsageError(
      await run(['replay', '12-1', '--batch=12-1']),
      'foedrum replay: unknown option "--batch"',
    );
  });

  it('refuses an argument a command does not take', async () => {
    assertUsageError(await run(['status', 'now']), 'foedrum status: unexpected argument "now"');
    assertUsageError(
      await run(['replay', '12-1', '14-1']),
      'foedrum replay: unexpected argument "14-1"',
    );
  });

  it('refuses a missing argument', async () => {
    assertUsageError(await run(['replay']), 'foedrum replay: missing <batch>');
  });

  it('refuses an argument its command schema rejects, with the reason', async () => {
    assertUsageError(
      await run(['replay', 'B1']),
      'foedrum replay: invalid <batch> "B1": Must be 1 to 64 lower-case letters, digits, ".", "_" or "-", start and end with a letter or digit, and not be a Windows device name',
    );
  });

  it('takes what follows -- as arguments', async () => {
    assertUsageError(
      await run(['replay', '--', '-1']),
      'foedrum replay: invalid <batch> "-1": Must be 1 to 64 lower-case letters, digits, ".", "_" or "-", start and end with a letter or digit, and not be a Windows device name',
    );
  });
});

describe('foedrum doctor', () => {
  it('reports every tool, a sandbox and a container runtime on Linux, and exits 0', async (t) => {
    const facts = linux({ podman: ran('/usr/bin/podman', 'podman version 5.2.0\n') });
    const result = await run(['doctor'], { gatherDoctorFacts: async () => facts });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    snapshot(t, result.stdout);
  });

  it('reports permissions only on native Windows, recommends WSL2, and exits 0', async (t) => {
    const result = await run(['doctor'], { gatherDoctorFacts: async () => windows });
    assert.equal(result.exitCode, 0);
    snapshot(t, result.stdout);
  });

  it('reports what is missing, and exits 1 when a required tool is', async (t) => {
    const facts = linux({ claude: undefined, bwrap: undefined });
    const result = await run(['doctor'], { gatherDoctorFacts: async () => facts });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, '');
    snapshot(t, result.stdout);
  });

  it('opens no event store', async () => {
    let opened = 0;
    await run(['doctor'], {
      openStore: () => {
        opened++;
        return undefined;
      },
    });
    assert.equal(opened, 0);
  });
});

describe('foedrum status', () => {
  it('opens the event store in .foedrum of the working directory', async () => {
    const opened: string[] = [];
    await run(['status'], {
      openStore: (path) => {
        opened.push(path);
        return storeWith([]);
      },
    });
    assert.deepEqual(opened, [storePath]);
  });

  it('says there are no batches yet in a Brewery without an event store', async () => {
    assert.deepEqual(await run(['status']), {
      exitCode: 0,
      stdout: 'No batches yet.\n',
      stderr: '',
    });
  });

  it('says there are no batches in an empty store', async () => {
    assert.deepEqual(await run(['status'], { openStore: () => storeWith([]) }), {
      exitCode: 0,
      stdout: 'No batches.\n',
      stderr: '',
    });
  });

  it('lists every batch with its issue, lane and what it waits for', async (t) => {
    const result = await run(['status'], { openStore: () => storeWith(brewery) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    snapshot(t, result.stdout);
  });

  it('escapes control characters in what brewers wrote, so they cannot drive the terminal', async () => {
    // An OSC 52 clipboard write and a cursor move, in a model-written summary and reason.
    const events: Event[] = [
      ordered(11),
      { type: 'step.scheduled', batchId: '11-1', stepId: 'plan', attempt: 1, deadlineAt: D1 },
      { type: 'step.started', batchId: '11-1', stepId: 'plan', attempt: 1 },
      {
        type: 'step.finished',
        batchId: '11-1',
        stepId: 'plan',
        attempt: 1,
        outcome: { kind: 'failed', retryable: false, reason: 'red\u001b[1A\u001b[2Kgreen' },
      },
      stuck(11, {
        kind: 'blocked',
        stepId: 'plan',
        blockerKind: 'findings',
        summary: 'copy\u001b]52;c;aGk=\u0007\u009b done',
      }),
    ];
    const status = await run(['status'], { openStore: () => storeWith(events) });
    assert.match(status.stdout, /copy\\u001b\]52;c;aGk=\\u0007\\u009b done/);
    const replay = await run(['replay', '11-1'], { openStore: () => storeWith(events) });
    assert.match(replay.stdout, /failed: red\\u001b\[1A\\u001b\[2Kgreen\n/);
    // Nothing but line feeds below U+0020, and no DEL or C1 control.
    const control = (text: string) =>
      [...text].filter((char) => {
        const code = char.codePointAt(0) ?? 0;
        return (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
      });
    for (const { stdout } of [status, replay]) assert.deepEqual(control(stdout), []);
  });

  it('counts one batch as one', async () => {
    const result = await run(['status'], { openStore: () => storeWith([ordered(11)]) });
    assert.equal(
      result.stdout,
      '1 batch\n\n  11-1  #11  ordered  to be routed by 2026-12-31T00:00:00.000Z\n',
    );
  });

  // The Brewery issue that is the order of a claimed issue (ADR 0144).
  const opened: Event = {
    type: 'effect.applied',
    key: '["app-11","order.issue"]',
    result: 200,
  };

  it('names a claimed target-repository issue by its alias until its Brewery issue is opened (ADR 0144)', async () => {
    const target: Event = {
      type: 'batch.ordered',
      batchId: 'app-11',
      order: { issue: 11, repo: 'acme/app' },
      routeBy: '2026-12-31T00:00:00.000Z',
    };
    const result = await run(['status'], { openStore: () => storeWith([ordered(11), target]) });
    assert.match(result.stdout, /^ +11-1 +#11 +ordered/m);
    assert.match(result.stdout, /^ +app-11 +app#11 +ordered/m);
    const after = await run(['status'], {
      openStore: () => storeWith([ordered(11), target, opened]),
    });
    assert.match(after.stdout, /^ +app-11 +#200 \(app#11\) +ordered/m);
  });

  it('names both issues of a claimed issue in stuck, and its repository in replay (ADR 0144)', async () => {
    const events: Event[] = [
      {
        type: 'batch.ordered',
        batchId: 'app-11',
        order: { issue: 11, repo: 'acme/app' },
        routeBy: '2026-12-31T00:00:00.000Z',
      },
      opened,
      {
        ...stuck(11, { kind: 'routing', deadlineAt: '2026-12-31T00:00:00.000Z' }),
        batchId: 'app-11',
      } as Event,
    ];
    const listed = await run(['stuck'], { openStore: () => storeWith(events) });
    assert.match(listed.stdout, /app-11 +#200 \(app#11\) /);
    const replayed = await run(['replay', 'app-11'], { openStore: () => storeWith(events) });
    assert.match(replayed.stdout, /^Batch app-11, issue acme\/app#11$/m);
  });

  // #238, ADR 0091: the limit and its reset, as claude gave them, tell a human when to retry.
  it('shows the usage limit a batch is Stuck on, with its reset', async () => {
    const summary =
      'claude hit its weekly limit, which resets Mon 12:00am: retry the step after that';
    const events: Event[] = [
      ordered(11),
      stuck(11, { kind: 'blocked', stepId: 'brew', blockerKind: 'environment', summary }),
    ];
    const listed = await run(['stuck'], { openStore: () => storeWith(events) });
    assert.match(listed.stdout, /blocked at brew \(environment\): claude hit its weekly limit/);
    assert.ok(listed.stdout.includes('resets Mon 12:00am: retry the step after that'));
  });

  it('says in one line, escaped, and exits 1, when reading the store throws', async () => {
    // A stored event that no longer validates: the message repeats text from the store.
    // An error that escaped runCli becomes the result, so the assertion below shows it.
    const result = await run(['status'], {
      openStore: () => {
        throw new Error('Stored event 3 is invalid: unrecognized key "\u001b]52;c;aGk=\u0007"');
      },
    }).catch((error: unknown) => ({ escaped: String(error) }));
    assert.deepEqual(result, {
      exitCode: 1,
      stdout: '',
      stderr:
        'foedrum status: Stored event 3 is invalid: unrecognized key "\\u001b]52;c;aGk=\\u0007"\n',
    });
  });

  it('refuses an event log the fold rejects, in one line, and exits 1', async () => {
    const result = await run(['status'], { openStore: () => storeWith(invalidLog) });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /^foedrum status: Invalid event log at event 1 \(step\.started\): [^\n]+\n$/,
    );
  });

  describe('the task-tree branches the cleanup keeps (ADR 0084, ADR 0092)', () => {
    const START = 'b'.repeat(40);
    const TIP = 'c'.repeat(40);
    // 11-1 brewed a commit and was cancelled before its pull request; 12-1 is still ordered.
    const cancelledWithCommits: Event[] = [
      ordered(11),
      ordered(12),
      { type: 'step.scheduled', batchId: '11-1', stepId: 'brew', attempt: 1, deadlineAt: D1 },
      {
        type: 'step.started',
        batchId: '11-1',
        stepId: 'brew',
        attempt: 1,
        worktree: {
          repo: 'acme/app',
          path: '/work/acme.app/attempts/11-1/brew/1',
          branch: 'foedrum/11-1/brew/1',
          commit: START,
        },
      },
      {
        type: 'step.finished',
        batchId: '11-1',
        stepId: 'brew',
        attempt: 1,
        outcome: { kind: 'succeeded', output: {} },
      },
      { type: 'batch.cancelled', batchId: '11-1', by: 'ann', via: 'terminal' },
    ];

    it("lists them after the batches, from the claims and git's readings", async () => {
      const asked: [string[], [string, string][]][] = [];
      const result = await run(['status'], {
        openStore: () => storeWith(cancelledWithCommits),
        readKeptBranches: async (state, unpushed) => {
          asked.push([[...state.batches.keys()], [...unpushed]]);
          return new Map([
            ['foedrum/11-1/brew/1', { kind: 'read', clone: '/src/app', tip: TIP, ahead: 2 }],
          ]);
        },
      });
      assert.deepEqual(asked, [[['11-1', '12-1'], [['foedrum/11-1/brew/1', START]]]]);
      assert.deepEqual(result, {
        exitCode: 0,
        stdout: [
          '2 batches',
          '',
          '  11-1  #11  cancelled  by ann via terminal',
          '  12-1  #12  ordered    to be routed by 2026-12-31T00:00:00.000Z',
          '',
          '1 kept branch: commits of ended batches that no push recorded (ADR 0084); take them, then drop the branch',
          '',
          '  11-1  foedrum/11-1/brew/1  2 commits past the start  in /src/app: git branch -D foedrum/11-1/brew/1',
          '',
        ].join('\n'),
        stderr: '',
      });
    });

    it('adds nothing when the branch is gone, and reads no git when no ended batch has one', async () => {
      let reads = 0;
      const gone = await run(['status'], {
        openStore: () => storeWith(cancelledWithCommits),
        readKeptBranches: async () => {
          reads++;
          return new Map([['foedrum/11-1/brew/1', { kind: 'gone' }]]);
        },
      });
      assert.equal(reads, 1);
      assert.doesNotMatch(gone.stdout, /kept/);
      assert.equal(gone.stdout.endsWith('2026-12-31T00:00:00.000Z\n'), true);
      // The default context fails any read of the kept branches.
      const none = await run(['status'], { openStore: () => storeWith([ordered(11)]) });
      assert.equal(none.exitCode, 0, none.stderr);
    });
  });

  it('closes the event store, and appends nothing to it (ADR 0030)', async () => {
    const watched = watchedStore(brewery);
    await run(['status'], { openStore: () => watched.store });
    assert.deepEqual(watched.afterRun(), { closed: 1, lastEventId: brewery.length });
  });

  it('closes the event store when the fold rejects its log', async () => {
    const watched = watchedStore(invalidLog);
    await run(['status'], { openStore: () => watched.store });
    assert.deepEqual(watched.afterRun(), { closed: 1, lastEventId: invalidLog.length });
  });

  it('shows a batch an interactive driver leases as such, but not the Cellar or a lease that ended (ADR 0123)', async () => {
    const store = storeWith([ordered(11), ordered(12), ordered(13)]);
    const expiresAt = new Date(new Date(D1).getTime() + 60_000);
    store.withTransaction((tx) => {
      tx.putBatchLease({ batchId: '11-1', owner: 'session-abc', expiresAt });
      tx.putBatchLease({ batchId: '12-1', owner: 'cellar', expiresAt });
      tx.putBatchLease({ batchId: '13-1', owner: 'ann', expiresAt: new Date(D1) });
    });
    const result = await run(['status'], { openStore: () => store });
    assert.match(result.stdout, /^ +11-1 +#11 +ordered +.*; brewed interactively by session-abc$/m);
    assert.equal(result.stdout.match(/interactively/g)?.length, 1, result.stdout);
  });
});

describe('foedrum brew (ADR 0123)', () => {
  it("hands the issue and the --as name to the terminal's brew, and answers with what it did", async () => {
    const asked: unknown[] = [];
    const done = { exitCode: 4, stdout: '', stderr: '' };
    const brew = async (input: unknown) => {
      asked.push(input);
      return done;
    };
    assert.deepEqual(await run(['brew', '12', '--as', 'ann'], { brew }), done);
    assert.deepEqual(await run(['brew', '--as=ann', 'web#7'], { brew }), done);
    assert.deepEqual(await run(['brew', '#3'], { brew }), done);
    assert.deepEqual(asked, [
      { command: 'brew', issue: { issue: 12 }, as: 'ann' },
      { command: 'brew', issue: { alias: 'web', issue: 7 }, as: 'ann' },
      { command: 'brew', issue: { issue: 3 } },
    ]);
  });

  it('refuses a command line it cannot read, without brewing', async () => {
    assertUsageError(await run(['brew']), 'foedrum brew: missing <issue>');
    assertUsageError(await run(['brew', '12', '--as']), 'foedrum brew: --as needs a value');
    assertUsageError(
      await run(['brew', '12', '--as', 'cellar']),
      'foedrum brew: invalid <as> "cellar": Must not be cellar, the Cellar\'s own',
    );
    assertUsageError(
      await run(['brew', '12', '--recipe', 'x']),
      'foedrum brew: unknown option "--recipe"',
    );
    // No other command takes --as.
    assertUsageError(
      await run(['retry', '12-1', '--as', 'ann']),
      'foedrum retry: unknown option "--as"',
    );
  });

  it('hands --take on as a flag, which takes no value (ADR 0124)', async () => {
    const asked: unknown[] = [];
    const brew = async (input: unknown) => {
      asked.push(input);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    assert.equal((await run(['brew', '12', '--take', '--as', 'ann'], { brew })).exitCode, 0);
    assert.deepEqual(asked, [{ command: 'brew', issue: { issue: 12 }, as: 'ann', take: true }]);
    assertUsageError(
      await run(['brew', '12', '--take=yes'], { brew }),
      'foedrum brew: --take takes no value',
    );
    assertUsageError(
      await run(['cancel', '12-1', '--take']),
      'foedrum cancel: unknown option "--take"',
    );
  });
});

describe('foedrum replay', () => {
  it("shows a batch's events, with their store ids, and its folded state", async (t) => {
    const result = await run(['replay', '12-1'], { openStore: () => storeWith(brewery) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    snapshot(t, result.stdout);
  });

  it("shows a sub-order batch's parent, a human's recipe choice, a rewind and an abandoned attempt", async (t) => {
    const result = await run(['replay', '14-1'], { openStore: () => storeWith(brewery) });
    assert.equal(result.exitCode, 0);
    snapshot(t, result.stdout);
  });

  it('points at the out docs on the state branch once an attempt finished, and not before (ADR 0103)', async () => {
    const finished = await run(['replay', '12-1'], { openStore: () => storeWith(brewery) });
    assert.match(
      finished.stdout,
      /^ {2}out docs {2}on the state branch at batches\/12-1\/<step>-<attempt>\.md$/m,
    );
    const none = await run(['replay', '14-1'], { openStore: () => storeWith(brewery) });
    assert.doesNotMatch(none.stdout, /out docs/);
  });

  it('shows an attempt that needs input and one that was cancelled', async () => {
    const step = { batchId: '11-1', stepId: 'plan' };
    const finished = (attempt: number, outcome: StepOutcome): Event[] => [
      { type: 'step.scheduled', ...step, attempt, deadlineAt: D1 },
      { type: 'step.started', ...step, attempt },
      { type: 'step.finished', ...step, attempt, outcome },
    ];
    const question = {
      q: 'Which?',
      options: ['a', 'b'],
      recommended: 'a',
      whyBlocking: 'It matters',
    };
    const events = [
      ordered(11),
      ...finished(1, { kind: 'needs_input', questions: [question] }),
      ...finished(2, { kind: 'cancelled' }),
    ];
    const { stdout } = await run(['replay', '11-1'], { openStore: () => storeWith(events) });
    assert.ok(
      stdout.endsWith('  steps\n    plan  #1 finished: needs input; #2 finished: cancelled\n'),
      stdout,
    );
  });

  it('refuses an unknown batch in one line, and exits 1', async () => {
    assert.deepEqual(await run(['replay', '99-1'], { openStore: () => storeWith(brewery) }), {
      exitCode: 1,
      stdout: '',
      stderr: 'foedrum replay: no batch 99-1 in the event store\n',
    });
  });

  it('says so in one line, and exits 1, when there is no event store', async () => {
    const result = await run(['replay', '12-1']);
    assert.equal(result.exitCode, 1);
    assert.equal(
      normalise(result.stderr),
      'foedrum replay: no event store at <brewery>/.foedrum/index.db\n',
    );
  });

  it('refuses an event log the fold rejects, in one line, and exits 1', async () => {
    const result = await run(['replay', '11-1'], { openStore: () => storeWith(invalidLog) });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^foedrum replay: Invalid event log at event 1 [^\n]+\n$/);
  });

  it('closes the event store, and appends nothing to it (ADR 0030)', async () => {
    for (const batch of ['12-1', '99-1']) {
      const watched = watchedStore(brewery);
      await run(['replay', batch], { openStore: () => watched.store });
      assert.deepEqual(watched.afterRun(), { closed: 1, lastEventId: brewery.length });
    }
  });

  it('closes the event store when the fold rejects its log', async () => {
    const watched = watchedStore(invalidLog);
    await run(['replay', '11-1'], { openStore: () => watched.store });
    assert.deepEqual(watched.afterRun(), { closed: 1, lastEventId: invalidLog.length });
  });
});
