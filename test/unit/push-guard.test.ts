// The noPush guard around the brewer runner (ADR 0106): it reads the refs of the target
// repository's remote before an attempt of a guarded step and after it, and fails the attempt when
// a ref the engine did not write changed, whatever the attempt's own ending: as a divergence, so
// the batch is Stuck however its recipe routes a failure. Runs with the fake
// brewer runner and a fake remote (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { guardPushes } from '../../src/checks/push-guard.ts';
import { remoteWrites } from '../../src/checks/remote-writes.ts';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { type Behaviour, behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';

const deadlineAt = '2026-10-21T12:30:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const ref: AttemptRef = { batchId: '12-1', stepId: 'implement', attempt: 1 };
const events: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'nip', reason: 'l', source: 'label' },
  { type: 'step.scheduled', ...ref, deadlineAt },
  {
    type: 'step.started',
    ...ref,
    worktree: {
      repo: 'acme/api',
      path: join('/work', 'acme.api', 'attempts', '12-1', 'implement', '1'),
      branch: 'foedrum/12-1/implement/1',
      commit: A,
    },
  },
];

/** A remote whose refs the brewer and the engine change while the attempt runs. */
const fakeRemote = (initial: Record<string, string> = { 'refs/heads/main': A }) => {
  const refs = new Map(Object.entries(initial));
  const reads: string[] = [];
  const signals: AbortSignal[] = [];
  const listing = () => [...refs].map(([name, sha]) => `${sha}\t${name}\n`).join('');
  return { refs, reads, signals, listing };
};

const setup = ({
  behaviour = (): Behaviour => behave.succeed(),
  guarded = true,
  remote = fakeRemote(),
  read,
  exempt,
  history = events,
  stop,
}: {
  /** What the brewer does to the remote, then how its attempt ends. */
  behaviour?: (remote: ReturnType<typeof fakeRemote>) => Behaviour;
  guarded?: boolean;
  remote?: ReturnType<typeof fakeRemote>;
  /** Answers each read in place of the fake remote, by its number from 1. */
  read?: (n: number, signal: AbortSignal) => Promise<string> | undefined;
  exempt?: (repo: string, ref: string) => boolean;
  /** The events the driver has recorded. */
  history?: Event[];
  /** Aborts when serve stops. */
  stop?: AbortSignal;
} = {}) => {
  const writes = remoteWrites();
  const order: string[] = [];
  const inner = fakeBrewerRunner(() => {
    order.push('brewer');
    return behaviour(remote);
  });
  const runner = guardPushes({
    runner: inner,
    state: () => fold(history),
    guarded: (attempt) => {
      assert.deepEqual(attempt, ref);
      return guarded;
    },
    refs: (repo, signal) => {
      remote.reads.push(repo);
      remote.signals.push(signal);
      order.push('read');
      return read?.(remote.reads.length, signal) ?? Promise.resolve(remote.listing());
    },
    writes,
    ...(exempt === undefined ? {} : { exempt }),
    ...(stop === undefined ? {} : { signal: stop }),
  });
  return { runner, inner, order, writes, remote };
};

const start = (runner: ReturnType<typeof setup>['runner']) =>
  runner.start({ ref, limits: defaultLimits });

describe('guardPushes (ADR 0106)', () => {
  it('fails an attempt whose brewer moved a ref of the remote, naming it and both commits (done when, #173)', async () => {
    const { runner, order, remote } = setup({
      behaviour: (remote) => {
        remote.refs.set('refs/heads/main', B);
        return behave.succeed();
      },
    });
    const end = await start(runner).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'divergence',
      summary: `the guard noPush: the remote of acme/api changed during the attempt: refs/heads/main moved from ${A} to ${B}`,
    });
    // The remote is read before the brewer starts, and again after it ended.
    assert.deepEqual(order, ['read', 'brewer', 'read']);
    assert.deepEqual(remote.reads, ['acme/api', 'acme/api']);
  });

  it('fails it for a ref created or deleted, whatever the attempt itself ended with', async () => {
    const { runner } = setup({
      remote: fakeRemote({ 'refs/heads/main': A, 'refs/tags/v1': B }),
      behaviour: (remote) => {
        remote.refs.delete('refs/tags/v1');
        remote.refs.set('refs/heads/sneaky', C);
        return behave.blocked('findings', 'The test is wrong');
      },
    });
    const end = await start(runner).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'divergence',
      summary: `the guard noPush: the remote of acme/api changed during the attempt: refs/heads/sneaky was created at ${C} (and 1 more)`,
    });
  });

  it('passes the ending through when the remote is as it was', async () => {
    const { runner } = setup({ behaviour: () => behave.needInput() });
    const end = await start(runner).ended;
    assert.equal(end.ending.kind, 'needs_input');
  });

  it('never fails an attempt for a ref the engine wrote meanwhile: another batch’s push, the state branch', async () => {
    const bottle = 'refs/heads/foedrum/acme.brewery/9-1/acme.api';
    const state = 'refs/heads/foedrum/state';
    let writes: ReturnType<typeof remoteWrites> | undefined;
    const made = setup({
      remote: fakeRemote({ 'refs/heads/main': A, [state]: A }),
      behaviour: (remote) => {
        // The driver pushes another batch's bottle while this attempt runs.
        const done = writes?.writing('acme/api', bottle);
        remote.refs.set(bottle, C);
        done?.();
        remote.refs.set(state, B);
        remote.refs.set('refs/pull/3/merge', B);
        return behave.succeed();
      },
      exempt: (repo, name) => repo === 'acme/api' && name === state,
    });
    writes = made.writes;
    const end = await start(made.runner).ended;
    assert.equal(end.ending.kind, 'succeeded');
  });

  for (const during of [1, 2]) {
    it(`never fails an attempt for a ref the engine wrote during its read ${during === 1 ? 'before' : 'after'} it`, async () => {
      const bottle = 'refs/heads/foedrum/acme.brewery/9-1/acme.api';
      let writes: ReturnType<typeof remoteWrites> | undefined;
      const remote = fakeRemote();
      const made = setup({
        remote,
        read: (n) => {
          if (n !== during) return undefined;
          // The driver's push lands while the guard lists the remote: in this listing or the next.
          const done = writes?.writing('acme/api', bottle);
          if (n === 2) remote.refs.set(bottle, C);
          const listed = remote.listing();
          if (n === 1) remote.refs.set(bottle, C);
          done?.();
          return Promise.resolve(listed);
        },
      });
      writes = made.writes;
      assert.equal((await start(made.runner).ended).ending.kind, 'succeeded');
    });
  }

  it('reads nothing for a step without the guard', async () => {
    const { runner, remote, inner } = setup({ guarded: false });
    const end = await start(runner).ended;
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepEqual(remote.reads, []);
    assert.equal(inner.started.length, 1);
  });

  it('starts an attempt with no worktree recorded unguarded: its plan fails it before anything runs', async () => {
    const { runner, remote, inner } = setup({ history: events.slice(0, 3) });
    const end = await start(runner).ended;
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepEqual(remote.reads, []);
    assert.equal(inner.started.length, 1);
  });

  it('reports progress while it reads after the attempt, so its lease holds', async () => {
    let release: (listed: string) => void = () => {};
    let after = false;
    const { runner, remote } = setup({
      read: (n) =>
        n === 2
          ? new Promise((resolve) => {
              after = true;
              release = resolve;
            })
          : undefined,
    });
    const running = start(runner);
    while (!after) await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(runner.progress(ref), undefined);
    release(remote.listing());
    assert.equal((await running.ended).ending.kind, 'succeeded');
    assert.equal(runner.progress(ref), undefined);
  });

  it('blocks the attempt on its environment, and never starts the brewer, when the remote cannot be read before', async () => {
    const { runner, inner } = setup({
      read: (n) =>
        n === 1 ? Promise.reject(new Error('git ls-remote failed: fatal: x')) : undefined,
    });
    const end = await start(runner).ended;
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the guard noPush cannot read the refs of the remote of acme/api before the attempt: git ls-remote failed: fatal: x',
    });
    assert.deepEqual(inner.started, []);
  });

  it('blocks it, and never passes it, when the remote cannot be read after, or its listing is bent', async () => {
    const down = setup({
      read: (n) =>
        n === 2 ? Promise.reject(new Error('git timed out after 60000 ms')) : undefined,
    });
    assert.deepEqual((await start(down.runner).ended).ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the guard noPush cannot read the refs of the remote of acme/api after the attempt: git timed out after 60000 ms',
    });
    const bent = setup({ read: (n) => (n === 2 ? Promise.resolve('hello\n') : undefined) });
    assert.deepEqual((await start(bent.runner).ended).ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the guard noPush cannot read the refs of the remote of acme/api after the attempt: git ls-remote printed a line that names no ref: hello',
    });
  });

  it('reports progress while it reads before, and a stop then cancels the attempt before the brewer starts', async () => {
    let signal: AbortSignal | undefined;
    const { runner, inner } = setup({
      read: (_n, given) => {
        signal = given;
        return new Promise((_resolve, reject) =>
          given.addEventListener('abort', () => reject(new Error('stopped'))),
        );
      },
    });
    const running = start(runner);
    while (signal === undefined) await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(runner.progress(ref), undefined);
    running.stop();
    const end = await running.ended;
    assert.equal(signal.aborted, true);
    assert.deepEqual(end.ending, { kind: 'cancelled' });
    assert.deepEqual(inner.started, []);
    assert.equal(runner.progress(ref), undefined);
  });

  it('aborts the read after the attempt when serve stops, so no git outlives it, and never passes the attempt', async () => {
    const serving = new AbortController();
    let given: AbortSignal | undefined;
    const { runner } = setup({
      stop: serving.signal,
      read: (n, signal) => {
        if (n !== 2) return undefined;
        given = signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('git was stopped'))),
        );
      },
    });
    const running = start(runner);
    while (given === undefined) await new Promise((resolve) => setImmediate(resolve));
    serving.abort();
    // An abort reaches its listeners at once: git is stopped before anything else runs.
    assert.equal(given.aborted, true);
    assert.deepEqual((await running.ended).ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the guard noPush cannot read the refs of the remote of acme/api after the attempt: git was stopped',
    });
  });

  it('cancels the attempt before the brewer starts when serve stops during the read before', async () => {
    const serving = new AbortController();
    let given: AbortSignal | undefined;
    const { runner, inner } = setup({
      stop: serving.signal,
      read: (_n, signal) => {
        given = signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('git was stopped'))),
        );
      },
    });
    const running = start(runner);
    while (given === undefined) await new Promise((resolve) => setImmediate(resolve));
    serving.abort();
    assert.equal(given.aborted, true);
    assert.deepEqual((await running.ended).ending, { kind: 'cancelled' });
    assert.deepEqual(inner.started, []);
  });

  it('still reads after an attempt the engine stopped, and fails it when its brewer pushed', async () => {
    const remote = fakeRemote();
    const { runner, inner } = setup({
      remote,
      behaviour: (remote) => {
        remote.refs.set('refs/heads/main', B);
        return behave.hang({ lastProgressAt: new Date(0), turnsWithoutProgress: 0 });
      },
    });
    const running = start(runner);
    while (inner.started.length === 0) await new Promise((resolve) => setImmediate(resolve));
    running.stop();
    const end = await running.ended;
    assert.equal(end.ending.kind === 'blocked' && end.ending.blockerKind, 'divergence');
    assert.equal(remote.reads.length, 2);
    assert.equal(remote.signals[1]?.aborted, false);
  });
});
