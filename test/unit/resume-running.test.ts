// `foedrum resume` on a running batch (ADR 0127): runResumeRunning on serve's shell with an
// in-memory store, fake worktrees, a fake GitHub and the scripted runner. The Cellar runs brew#1;
// resume takes the batch over for that step, the Cellar stops its run (as the driver tests show),
// and resume continues its session as brew#2, then lets the batch go once brew#2 ended. No process
// starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type RunningResume, runResumeRunning } from '../../src/cli/resume-running.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { type Behaviour, behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { FAKE_COMMIT, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { brewer, local, serveInputs } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const t0 = new Date('2026-10-23T12:00:00.000Z');
const session = '0f8fad5b-d9cb-469f-a165-70867728950e';
const claude = { version: '2.1.301', model: 'claude-haiku-5-5' };

describe('runResumeRunning (ADR 0127)', () => {
  let dir: TempDir;
  let store: EventStore;
  let lines: string[];
  let started: string[];
  let api: FakeGitHubApi;
  let lock: ReturnType<typeof fakeLock>;
  const brew1 = { batchId: '12-1', stepId: 'brew', attempt: 1 };
  const folder = () => join(dir.path, 'acme.web', 'attempts', '12-1', 'brew', '1');

  /** Serve's setup with the cellarman allowed `maxAttempts` attempts. */
  const setupWith = (maxAttempts: number): ServeSetup => {
    const files = serveInputs().files;
    const text = brewer.replace('"maxAttempts": 1', `"maxAttempts": ${maxAttempts}`);
    const ready = serveSetup(
      serveInputs({
        files: {
          ...files,
          local: local({ workRoot: dir.path }),
          brewery: { ...files.brewery, brewers: [{ path: 'brewers/cellarman.md', text }] },
        },
      }),
    );
    return ready.kind === 'ready' ? ready.setup : assert.fail(JSON.stringify(ready));
  };

  beforeEach(() => {
    dir = makeTempDir('resume-running');
    const inner = openSqliteEventStore(':memory:');
    store = { ...inner, close: () => {} };
    lines = [];
    started = [];
    lock = fakeLock('resume-4242');
    api = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: ['recipe:stout'], author: 'ann', title: 'Add', body: 'Add it.' },
        ],
      },
    });
  });
  afterEach(() => dir.remove());

  /** Batch 12-1 brews with `recipe`, and the Cellar runs brew#1 in `session`. */
  const cellarRuns = (setup: ServeSetup, recipe = 'stout'): void => {
    const log = createCommandLog({ store, recipes: setup.recipes });
    const issue = (command: Parameters<typeof log.issue>[0]) =>
      assert.equal(log.issue(command, t0).kind, 'accepted', JSON.stringify(command));
    issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } });
    issue({ kind: 'route', batchId: '12-1', recipe, reason: 'label', source: 'label' });
    const path = folder();
    issue({
      kind: 'record',
      event: {
        type: 'step.started',
        ...brew1,
        session: { id: session, worktree: path },
        worktree: { repo: 'acme/web', path, branch: 'foedrum/12-1/brew/1', commit: FAKE_COMMIT },
      },
    });
    store.withTransaction((tx) => {
      const expiresAt = new Date(t0.getTime() + 60_000);
      tx.putBatchLease({ batchId: '12-1', owner: 'cellar', expiresAt });
      tx.putLease({ attemptKey: attemptKey.encode(brew1), owner: 'cellar', expiresAt });
    });
  };

  /**
   * The Cellar at its next tick, once the batch was taken over to resume brew: it stops its run of
   * brew#1, which ends cancelled after claude's init, and lets its lease go (ADR 0127). With
   * `ending`, the run ended by itself that way first.
   */
  const cellarStops =
    (setup: ServeSetup, ending: Ending = { kind: 'cancelled' }) =>
    (): void => {
      const handed = store
        .eventsAfter(0)
        .some(({ event }) => event.type === 'batch.taken_over' && event.resumes === 'brew');
      const log = createCommandLog({ store, recipes: setup.recipes });
      const state = log.state().batches.get('12-1')?.steps.get('brew')?.attempts.get(1);
      if (!handed || state?.phase !== 'started') return;
      assert.equal(log.issue({ kind: 'finish', ...brew1, ending, claude }, t0).kind, 'accepted');
      store.withTransaction((tx) => tx.releaseLease(attemptKey.encode(brew1)));
    };

  const shell = (
    brew: Behaviour,
    meanwhile: () => void,
    overrides: Partial<ServeShell> = {},
  ): ServeShell => {
    let ticks = 0;
    const runner = fakeBrewerRunner((attempt) => {
      started.push(`${attempt.ref.stepId}#${attempt.ref.attempt}`);
      return brew;
    });
    return {
      out: (line) => lines.push(line),
      signal: new AbortController().signal,
      clock: () => t0,
      wait: async () => {
        ticks++;
        meanwhile();
        if (ticks > 20) assert.fail(`resume did not stop:\n${lines.join('\n')}`);
      },
      lock: () => lock,
      openStore: () => store,
      stateBranch: () => ({
        start: async () => ({ decision: 'ready' }),
        flush: async () => ({ kind: 'unchanged' }),
      }),
      worktrees: async () => fakeWorktrees({ root: join(dir.path, 'acme.web', 'attempts') }),
      push: () => ({
        commit: async () => FAKE_COMMIT,
        baseTip: async () => 'b'.repeat(40),
        isAncestor: async (commit, of) => commit === of,
        remoteTip: async () => undefined,
        push: async () => {},
        secretScan: async () => [],
      }),
      runner: () => runner,
      exec: () => Promise.reject(new Error('no check step runs here')),
      setup: () => Promise.reject(new Error('no repository setup runs here')),
      gh: ghOver(api.fetch).exec,
      git: () => Promise.reject(new Error('no red proof or guarded step runs here')),
      ...overrides,
    };
  };
  const resumeLease = (at: Date) =>
    store
      .batchLeases(at)
      .find(({ batchId, owner }) => batchId === '12-1' && owner === 'resume-4242');

  const request: RunningResume = {
    batchId: '12-1',
    stepId: 'brew',
    owner: 'resume-4242',
    by: 'ann',
    via: 'terminal',
  };
  const events = () => store.eventsAfter(0).map(({ event }) => event);

  it('takes the batch over for the step, continues its session as the next attempt, and lets the batch go once it ended', async () => {
    const setup = setupWith(2);
    cellarRuns(setup);
    const result = await runResumeRunning(
      setup,
      shell(behave.succeed(), cellarStops(setup)),
      request,
    );
    assert.equal(result, 0, lines.join('\n'));
    const handover = events().find((event) => event.type === 'batch.taken_over');
    assert.deepStrictEqual(handover, {
      type: 'batch.taken_over',
      batchId: '12-1',
      by: 'ann',
      via: 'terminal',
      from: 'cellar',
      to: 'resume-4242',
      until: new Date(t0.getTime() + 60_000).toISOString(),
      resumes: 'brew',
    });
    // The resumed attempt names the session it continues, in the worktree brew#1 made.
    assert.deepStrictEqual(started, ['brew#2']);
    const resumed = events().find((event) => event.type === 'step.started' && event.attempt === 2);
    assert.deepStrictEqual(resumed?.type === 'step.started' ? resumed.session : undefined, {
      id: session,
      resumes: session,
      worktree: folder(),
    });
    // The engine went on from the out doc it wrote: brew succeeded, its next step was scheduled.
    const finished = events().find(
      (event) => event.type === 'step.finished' && event.attempt === 2,
    );
    assert.equal(
      finished?.type === 'step.finished' ? finished.outcome.kind : undefined,
      'succeeded',
    );
    assert.ok(
      events().some((event) => event.type === 'step.scheduled' && event.stepId !== 'brew'),
      'the step after brew is scheduled',
    );
    // Let go for the driver that takes it next, and the lock with it.
    assert.equal(
      store.batchLeases(t0).find(({ batchId }) => batchId === '12-1'),
      undefined,
    );
    assert.equal(lock.held, false);
    assert.ok(
      lines.includes('foedrum resume: took batch 12-1 over from cellar to resume step brew'),
      lines.join('\n'),
    );
    assert.equal(
      lines.at(-1),
      'foedrum resume: brew#2 succeeded; batch 12-1 goes on from its next step under the driver that takes it',
    );
  });

  it('says why and lets the batch go when the stopped run left it Stuck, resuming nothing: exit 1', async () => {
    const setup = setupWith(1);
    cellarRuns(setup);
    const result = await runResumeRunning(
      setup,
      shell(behave.succeed(), cellarStops(setup)),
      request,
    );
    assert.equal(result, 1);
    assert.deepStrictEqual(started, []);
    assert.equal(
      store.batchLeases(t0).find(({ batchId }) => batchId === '12-1'),
      undefined,
    );
    assert.match(
      lines.at(-1) ?? '',
      /^foedrum resume: batch 12-1 is stuck: .*; nothing was resumed$/,
    );
  });

  it('continues a retry that waits to resume the session, with no driver to take the batch from: exit 0', async () => {
    const setup = setupWith(1);
    cellarRuns(setup);
    const log = createCommandLog({ store, recipes: setup.recipes });
    const ending = { kind: 'failed', retryable: true, reason: 'claude crashed' } as const;
    assert.equal(log.issue({ kind: 'finish', ...brew1, ending, claude }, t0).kind, 'accepted');
    const retry = { kind: 'retry', batchId: '12-1', by: 'ann', via: 'terminal' } as const;
    assert.equal(log.issue(retry, t0).kind, 'accepted');
    store.withTransaction((tx) => {
      tx.releaseBatchLease('12-1');
      tx.releaseLease(attemptKey.encode(brew1));
    });
    const result = await runResumeRunning(
      setup,
      shell(behave.succeed(), () => {}),
      request,
    );
    assert.equal(result, 0, lines.join('\n'));
    assert.deepStrictEqual(started, ['brew#2']);
    const resumed = events().find((event) => event.type === 'step.started' && event.attempt === 2);
    assert.equal(resumed?.type === 'step.started' ? resumed.session?.resumes : undefined, session);
    assert.ok(!events().some((event) => event.type === 'batch.taken_over'));
  });

  it('says so and lets its lease go when another driver takes the batch while it waits: exit 1', async () => {
    const setup = setupWith(2);
    cellarRuns(setup);
    const until = new Date(t0.getTime() + 120_000);
    const taken = () =>
      store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: '12-1', owner: 'session-7', expiresAt: until }),
      );
    const result = await runResumeRunning(setup, shell(behave.succeed(), taken), request);
    assert.equal(result, 1);
    assert.equal(
      lines.at(-1),
      `foedrum resume: batch 12-1 is driven by session-7 until ${until.toISOString()}`,
    );
    assert.equal(resumeLease(t0), undefined);
  });

  it('lets the batch go on a stop while it waits: exit 1', async () => {
    const setup = setupWith(2);
    cellarRuns(setup);
    const stop = new AbortController();
    const stopping = shell(behave.succeed(), () => {}, {
      signal: stop.signal,
      wait: async () => {
        stop.abort();
      },
    });
    assert.equal(await runResumeRunning(setup, stopping, request), 1);
    assert.equal(
      lines.at(-1),
      'foedrum resume: stopped; batch 12-1 is left for the driver that takes it',
    );
    assert.equal(resumeLease(t0), undefined);
  });

  it('starts nothing after the resumed attempt ended, though the next step is due: the driver that takes the batch starts it', async () => {
    const setup = setupWith(2);
    cellarRuns(setup, 'porter');
    const result = await runResumeRunning(
      setup,
      shell(behave.succeed(), cellarStops(setup)),
      request,
    );
    assert.equal(result, 0, lines.join('\n'));
    assert.ok(
      events().some((event) => event.type === 'step.scheduled' && event.stepId === 'green'),
      'the check after brew is due',
    );
    assert.ok(
      !events().some((event) => event.type === 'step.started' && event.stepId === 'green'),
      'and resume did not start it',
    );
  });

  it('resumes nothing, says so and lets go when the run ended by itself before it was stopped: exit 1', async () => {
    const setup = setupWith(2);
    cellarRuns(setup);
    const done: Ending = {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Brewed', assumptions: [] },
    };
    const result = await runResumeRunning(
      setup,
      shell(behave.succeed(), cellarStops(setup, done)),
      request,
    );
    assert.equal(result, 1);
    assert.deepStrictEqual(started, []);
    assert.equal(
      lines.at(-1),
      'foedrum resume: brew#1 succeeded before it was stopped; nothing was resumed',
    );
    assert.equal(resumeLease(t0), undefined);
  });

  it('keeps its lease of the batch while it waits for the stopped run to end, with no effect due', async () => {
    const setup = setupWith(2);
    cellarRuns(setup);
    // The Cellar applied every effect before the takeover, which makes none due.
    store = { ...store, findEffect: () => ({ result: null }) };
    // Two minutes a wait: the takeover's lease of five would lapse by the third.
    let now = t0;
    let waits = 0;
    const held: boolean[] = [];
    const stops = cellarStops(setup);
    const slow = shell(behave.succeed(), () => {}, {
      clock: () => now,
      wait: async () => {
        waits++;
        now = new Date(now.getTime() + 2 * 60_000);
        held.push(resumeLease(now) !== undefined);
        // The Cellar's heartbeat renews brew#1's lease until its run ends.
        if (waits < 4) {
          const expiresAt = new Date(now.getTime() + 5 * 60_000);
          store.withTransaction((tx) =>
            tx.putLease({ attemptKey: attemptKey.encode(brew1), owner: 'cellar', expiresAt }),
          );
        }
        if (waits === 4) stops();
        if (waits > 20) assert.fail(`resume did not stop:\n${lines.join('\n')}`);
      },
    });
    assert.equal(await runResumeRunning(setup, slow, request), 0, lines.join('\n'));
    assert.deepStrictEqual(held.slice(0, 3), [true, true, true]);
  });

  it('refuses when its owner holds the batch already, taking nothing over: exit 1', async () => {
    const setup = setupWith(2);
    cellarRuns(setup);
    store.withTransaction((tx) =>
      tx.putBatchLease({
        batchId: '12-1',
        owner: 'resume-4242',
        expiresAt: new Date(t0.getTime() + 60_000),
      }),
    );
    const result = await runResumeRunning(
      setup,
      shell(behave.succeed(), () => {}),
      {
        ...request,
        owner: 'resume-4242',
      },
    );
    assert.equal(result, 1);
    assert.ok(!events().some((event) => event.type === 'batch.taken_over'));
    assert.equal(lines.at(-1), 'foedrum resume: resume-4242 holds batch 12-1 already');
  });
});
