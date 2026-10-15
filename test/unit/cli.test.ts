// The `foedrum` command line through runCli with fake facts and an in-memory event store
// (ADR 0021): the command registry, argument errors, and each command's output as a snapshot
// (cli.test.ts.snapshot; `node --test --test-update-snapshots` rewrites it, so review the diff).
// The real program is in test/integration/doctor.test.ts.

import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
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
      await run(['brew', '13']),
      'foedrum: unknown command "brew"; run foedrum --help for the commands',
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

  it('says so in one line, and exits 1, when there is no event store', async () => {
    const result = await run(['status']);
    assert.deepEqual(
      { ...result, stderr: normalise(result.stderr) },
      {
        exitCode: 1,
        stdout: '',
        stderr: 'foedrum status: no event store at <brewery>/.foedrum/index.db\n',
      },
    );
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

  it('counts one batch as one', async () => {
    const result = await run(['status'], { openStore: () => storeWith([ordered(11)]) });
    assert.equal(result.stdout, '1 batch\n\n  11-1  #11  ordered\n');
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

  it('closes the event store, and appends nothing to it (ADR 0029)', async () => {
    const watched = watchedStore(brewery);
    await run(['status'], { openStore: () => watched.store });
    assert.deepEqual(watched.afterRun(), { closed: 1, lastEventId: brewery.length });
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

  it('closes the event store, and appends nothing to it (ADR 0029)', async () => {
    for (const batch of ['12-1', '99-1']) {
      const watched = watchedStore(brewery);
      await run(['replay', batch], { openStore: () => watched.store });
      assert.deepEqual(watched.afterRun(), { closed: 1, lastEventId: brewery.length });
    }
  });
});
