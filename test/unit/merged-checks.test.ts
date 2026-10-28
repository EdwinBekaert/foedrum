// The checks of an open pull request's merged tree (ADR 0203): a fake run answers each due run
// when the test says so, and the command log is the real one on a store in memory (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type BaseCheckRepository, checkBases } from '../../src/engine/base-check.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Batch } from '../../src/engine/fold.ts';
import {
  createMergedChecks,
  type MergedCheckDue,
  type MergedCheckEnd,
  type MergedChecks,
  MOST_RUN_MS,
  mergedCheckStep,
} from '../../src/engine/merged-checks.ts';
import { pullRequestKey, pushKey } from '../../src/engine/pull-request.ts';
import type { StepChecks } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { baseCheckLines } from '../../src/engine/status-comment.ts';
import type { GravityReading } from '../../src/schemas/events.ts';
import { MAX_UNCHECKED_LENGTH } from '../../src/schemas/events.ts';
import type { CheckRef } from '../../src/schemas/recipe.ts';
import type { PushResult } from '../../src/schemas/store.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const now = new Date('2026-10-26T09:00:00.000Z');
const web = 'https://github.com/acme/web/pull/12';
const web2 = 'https://github.com/acme/web/pull/13';
const api = 'https://github.com/acme/api/pull/4';
const head = 'a'.repeat(40);
const tip1 = 'c'.repeat(40);
const tip2 = 'd'.repeat(40);
const recipes = fakeRecipes({
  nip: fakeRecipe({ steps: ['plan', 'green'], merges: ['green'], pullRequests: [web] }),
  nip2: fakeRecipe({ steps: ['plan', 'green'], merges: ['green'], pullRequests: [web2] }),
  nipApi: fakeRecipe({ steps: ['plan', 'green'], merges: ['green'], pullRequests: [api] }),
  plain: fakeRecipe({ steps: ['plan'], pullRequests: [web] }),
});
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const failing: GravityReading = {
  result: 'exited',
  check: 'typecheck',
  command: 'npm run typecheck',
  exitCode: 2,
  tail: "error TS2305: Module has no exported member 'baseFetchRoot'",
};

/** A run whose every call waits until the test ends it. */
const fakeRun = () => {
  const calls: { due: MergedCheckDue; signal: AbortSignal; end: (end: MergedCheckEnd) => void }[] =
    [];
  const run = (due: MergedCheckDue, signal: AbortSignal) =>
    new Promise<MergedCheckEnd>((resolve) => {
      calls.push({ due, signal, end: resolve });
    });
  return { calls, run };
};

/** Lets the run's settled promises and the records after them go first. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('createMergedChecks', () => {
  let store: EventStore;
  let log: CommandLog;
  let failures: { what: string; error: unknown }[];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    failures = [];
  });
  afterEach(() => store.close());

  const accept = (command: Parameters<CommandLog['issue']>[0]): void =>
    assert.equal(log.issue(command, now).kind, 'accepted');
  const ledger = (key: Parameters<typeof effectKey.encode>[0], result: unknown): void =>
    accept({
      kind: 'record',
      event: { type: 'effect.applied', key: effectKey.encode(key), result },
    });
  /** `batchId` on tap with the pull request its ledger opened and the commit its push recorded. */
  const onTap = (batchId: string, recipe: string, url: string, repo = 'acme/web', issue = 7) => {
    accept({ kind: 'order', batchId, order: { issue, repo } });
    accept({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
    for (const stepId of recipe === 'plain' ? ['plan'] : ['plan', 'green']) {
      const ref = { batchId, stepId, attempt: 1 };
      accept({ kind: 'record', event: { type: 'step.started', ...ref } });
      accept({ kind: 'finish', ...ref, ending: succeeded });
    }
    const pushed: PushResult = { branch: `foedrum/${batchId}`, commit: head, from: 'start' };
    ledger(pushKey(batchId), pushed);
    ledger(pullRequestKey(batchId), url);
  };
  const batch = (batchId: string): Batch => {
    const found = log.state().batches.get(batchId);
    assert.ok(found);
    return found;
  };
  const due = (batchId: string, pullRequest: string, tip: string, checked = 0): MergedCheckDue => ({
    batchId,
    pullRequest,
    branch: 'main',
    tip,
    head,
    checked,
  });
  const conflictAt = (batchId: string, pullRequest: string, tip: string) =>
    accept({
      kind: 'record',
      event: {
        type: 'pull_request.base_checked',
        batchId,
        pullRequest,
        branch: 'main',
        tip,
        conflicts: ['src/a.ts'],
      },
    });
  const checks = (run: (due: MergedCheckDue, signal: AbortSignal) => Promise<MergedCheckEnd>) =>
    createMergedChecks({
      log,
      clock: () => now,
      run,
      failed: (what, error) => failures.push({ what, error }),
    });
  const live = new AbortController().signal;

  it('runs a due run on the merged tree once, and records that it passed', async () => {
    onTap('web-7', 'nip', web);
    const { calls, run } = fakeRun();
    const merged = checks(run);
    merged.due(due('web-7', web, tip1));
    merged.poll(live);
    assert.equal(calls.length, 1);
    assert.deepStrictEqual(calls[0]?.due, due('web-7', web, tip1));
    calls[0]?.end({ kind: 'passed' });
    await merged.settled();
    assert.deepStrictEqual(batch('web-7').baseChecks, [
      { pullRequest: web, branch: 'main', tip: tip1, head },
    ]);
    merged.poll(live);
    assert.equal(calls.length, 1);
    assert.deepStrictEqual(failures, []);
  });

  it('records the failing reading, and why checks that could not start did not run', async () => {
    onTap('web-7', 'nip', web);
    const { calls, run } = fakeRun();
    const merged = checks(run);
    merged.due(due('web-7', web, tip1));
    merged.poll(live);
    calls[0]?.end({ kind: 'failed', reading: failing });
    await merged.settled();
    // As the next pass hands it on: after the one check recorded.
    merged.due(due('web-7', web, tip2, 1));
    merged.poll(live);
    calls[1]?.end({ kind: 'unchecked', why: 'git worktree add failed: fatal: disk full' });
    await merged.settled();
    assert.deepStrictEqual(batch('web-7').baseChecks, [
      { pullRequest: web, branch: 'main', tip: tip1, head, failed: failing },
      {
        pullRequest: web,
        branch: 'main',
        tip: tip2,
        head,
        unchecked: 'git worktree add failed: fatal: disk full',
      },
    ]);
  });

  it('records a run that threw as unchecked with its first line, cut to the longest reason, and reports it', async () => {
    onTap('web-7', 'nip', web);
    const merged = checks(async () => {
      throw new Error(`${'x'.repeat(MAX_UNCHECKED_LENGTH + 50)}\nsecond line`);
    });
    merged.due(due('web-7', web, tip1));
    merged.poll(live);
    await merged.settled();
    const [check] = batch('web-7').baseChecks ?? [];
    assert.equal(check?.unchecked?.length, MAX_UNCHECKED_LENGTH);
    assert.ok(check?.unchecked?.startsWith('xxx'));
    assert.equal(failures.length, 1);
  });

  it('records nothing for a run the stop ended, and starts none after the stop', async () => {
    onTap('web-7', 'nip', web);
    onTap('web-8', 'nip2', web2, 'acme/web', 8);
    const { calls, run } = fakeRun();
    const merged = checks(run);
    const stop = new AbortController();
    merged.due(due('web-7', web, tip1));
    merged.due(due('web-8', web2, tip1));
    merged.poll(stop.signal);
    stop.abort();
    assert.equal(calls[0]?.signal.aborted, true);
    calls[0]?.end({ kind: 'stopped' });
    await merged.settled();
    merged.poll(stop.signal);
    assert.equal(calls.length, 1);
    assert.equal(batch('web-7').baseChecks, undefined);
  });

  it("runs one at a time in the Cellar: two repositories' runs never overlap, two pull requests of one run one after the other", async () => {
    onTap('web-7', 'nip', web);
    onTap('web-8', 'nip2', web2, 'acme/web', 8);
    onTap('api-4', 'nipApi', api, 'acme/api', 4);
    const { calls, run } = fakeRun();
    const merged = checks(run);
    merged.due(due('web-7', web, tip1));
    merged.due(due('api-4', api, tip1));
    merged.due(due('web-8', web2, tip1));
    merged.poll(live);
    merged.poll(live);
    assert.deepStrictEqual(
      calls.map(({ due }) => due.batchId),
      ['web-7'],
    );
    calls[0]?.end({ kind: 'passed' });
    await merged.settled();
    merged.poll(live);
    merged.poll(live);
    assert.deepStrictEqual(
      calls.map(({ due }) => due.batchId),
      ['web-7', 'api-4'],
    );
    calls[1]?.end({ kind: 'passed' });
    await merged.settled();
    merged.poll(live);
    assert.deepStrictEqual(
      calls.map(({ due }) => due.batchId),
      ['web-7', 'api-4', 'web-8'],
    );
  });

  it('runs a pull request whose base moved again before its run started once, at the newest tip', async () => {
    onTap('web-7', 'nip', web);
    onTap('web-8', 'nip2', web2, 'acme/web', 8);
    const { calls, run } = fakeRun();
    const merged = checks(run);
    merged.due(due('web-8', web2, tip1));
    merged.poll(live);
    merged.due(due('web-7', web, tip1));
    merged.due(due('web-7', web, tip2));
    // A pull request whose run is underway is queued again at the new tip; once that run
    // recorded, the next pass hands it on after that check.
    merged.due(due('web-8', web2, tip2));
    calls[0]?.end({ kind: 'passed' });
    await merged.settled();
    merged.due(due('web-8', web2, tip2, 1));
    merged.poll(live);
    calls[1]?.end({ kind: 'passed' });
    await merged.settled();
    merged.poll(live);
    calls[2]?.end({ kind: 'passed' });
    await merged.settled();
    merged.poll(live);
    assert.deepStrictEqual(
      calls.map(({ due }) => [due.batchId, due.tip]),
      [
        ['web-8', tip1],
        ['web-7', tip2],
        ['web-8', tip2],
      ],
    );
  });

  it('drops a run whose pull request ended, or whose tip a check recorded, before it starts', async () => {
    onTap('web-7', 'nip', web);
    onTap('web-8', 'nip2', web2, 'acme/web', 8);
    const { calls, run } = fakeRun();
    const merged = checks(run);
    merged.due(due('web-7', web, tip1));
    merged.due(due('web-8', web2, tip1));
    accept({
      kind: 'record',
      event: { type: 'pull_request.ended', batchId: 'web-7', pullRequest: web, state: 'merged' },
    });
    accept({
      kind: 'record',
      event: {
        type: 'pull_request.base_checked',
        batchId: 'web-8',
        pullRequest: web2,
        branch: 'main',
        tip: tip1,
        conflicts: ['src/a.ts'],
      },
    });
    merged.poll(live);
    await merged.settled();
    assert.deepStrictEqual(calls, []);
  });

  it('loses no run to a kill and records none twice: the next pass hands it on again, and it runs once', async () => {
    onTap('web-7', 'nip', web);
    const killed = fakeRun();
    const before = checks(killed.run);
    before.due(due('web-7', web, tip1));
    before.poll(live);
    // Killed mid-run: the run never ends and nothing is recorded.
    assert.equal(batch('web-7').baseChecks, undefined);
    const after = fakeRun();
    const restarted: MergedChecks = checks(after.run);
    restarted.due(due('web-7', web, tip1));
    restarted.due(due('web-7', web, tip1));
    restarted.poll(live);
    restarted.poll(live);
    after.calls[0]?.end({ kind: 'failed', reading: failing });
    await restarted.settled();
    restarted.poll(live);
    assert.equal(after.calls.length, 1);
    assert.deepStrictEqual(batch('web-7').baseChecks, [
      { pullRequest: web, branch: 'main', tip: tip1, head, failed: failing },
    ]);
  });

  // A newer check by the pass, or a moved bottle branch, stands over an older tip's run (review
  // of #528).
  it('records nothing for a run whose pull request was checked again while it ran', async () => {
    onTap('web-7', 'nip', web);
    const { calls, run } = fakeRun();
    const merged = checks(run);
    merged.due(due('web-7', web, tip1));
    merged.poll(live);
    conflictAt('web-7', web, tip2);
    calls[0]?.end({ kind: 'passed' });
    await merged.settled();
    assert.deepStrictEqual(
      batch('web-7').baseChecks?.map(({ tip }) => tip),
      [tip2],
    );
  });

  it('starts no run for a pull request checked again since it was handed on, a moved branch included', async () => {
    onTap('web-7', 'nip', web);
    onTap('web-8', 'nip2', web2, 'acme/web', 8);
    const { calls, run } = fakeRun();
    const merged = checks(run);
    merged.due(due('web-7', web, tip1));
    merged.due(due('web-8', web2, tip1));
    conflictAt('web-7', web, tip2);
    accept({
      kind: 'record',
      event: {
        type: 'pull_request.base_checked',
        batchId: 'web-8',
        pullRequest: web2,
        branch: 'main',
        tip: tip2,
        branchMoved: 'f'.repeat(40),
      },
    });
    // A run starts within the poll, or not at all.
    merged.poll(live);
    assert.deepStrictEqual(calls, []);
    // Handed on after that check, it runs.
    merged.due(due('web-7', web, tip1, 1));
    merged.poll(live);
    assert.equal(calls.length, 1);
  });

  it('starts no run for a batch that is not on tap, nor for a pull request its lane does not hold', () => {
    accept({ kind: 'order', batchId: 'web-9', order: { issue: 9, repo: 'acme/web' } });
    onTap('web-7', 'nip', web);
    const { calls, run } = fakeRun();
    const merged = checks(run);
    merged.due(due('web-9', web, tip1));
    merged.poll(live);
    merged.due(due('web-7', api, tip1));
    merged.poll(live);
    assert.deepStrictEqual(calls, []);
  });

  it('settles at once when no run is underway', async () => {
    const merged = checks(fakeRun().run);
    await merged.settled();
  });

  // #511's own case (#266 and #269): two pull requests that each merge cleanly into main, and
  // together no longer pass the typecheck.
  it('says on the second pull request once the first merges that the merged tree fails its checks', async () => {
    onTap('web-7', 'nip', web);
    onTap('web-8', 'nip2', web2, 'acme/web', 8);
    // main at tip1 holds neither; at tip2 it holds web-7's change, which breaks web-8's.
    const state = { tip: tip1 };
    const merged = checks(async (run) =>
      run.batchId === 'web-8' && run.tip === tip2
        ? { kind: 'failed', reading: failing }
        : { kind: 'passed' },
    );
    const repository: BaseCheckRepository = {
      repo: 'acme/web',
      base: 'main',
      tip: async () => state.tip,
      mergeTree: async () => ({ kind: 'clean' }),
      branchTip: async () => head,
      checks: { wants: () => true, due: (run) => merged.due(run) },
    };
    const pass = async () => {
      await checkBases(
        { log, repositories: [repository], clock: () => now, failed: () => {} },
        live,
      );
      for (let n = 0; n < 4; n += 1) {
        merged.poll(live);
        await merged.settled();
        await settle();
      }
    };
    await pass();
    assert.deepStrictEqual(baseCheckLines(log.state(), batch('web-8')), []);
    // web-7 merges: main moves to tip2.
    accept({
      kind: 'record',
      event: { type: 'pull_request.ended', batchId: 'web-7', pullRequest: web, state: 'merged' },
    });
    state.tip = tip2;
    await pass();
    assert.deepStrictEqual(baseCheckLines(log.state(), batch('web-8')), [
      `- <${web2}> fails on the merged tree with \`main\` at \`dddddddd\`: the check "typecheck" (npm run typecheck) failed with exit code 2`,
    ]);
    assert.deepStrictEqual(
      batch('web-8').baseChecks?.map(({ tip }) => tip),
      [tip1, tip2],
    );
  });
});

describe('mergedCheckStep', () => {
  const stepChecks = (found: Record<string, readonly CheckRef[]>): StepChecks => ({
    find: (_recipe, stepId) => found[stepId],
    any: () => true,
    proves: () => undefined,
    redProof: () => undefined,
  });
  const batchOf = (recipe: string): Batch => ({ recipe: { name: recipe } }) as unknown as Batch;

  it("names the recipe's step that merges the base, its checks and its deadline, at most MOST_RUN_MS", () => {
    assert.deepStrictEqual(
      mergedCheckStep(recipes, stepChecks({ green: ['typecheck', 'test'] }), batchOf('nip')),
      { stepId: 'green', refs: ['typecheck', 'test'], deadlineMs: MOST_RUN_MS },
    );
  });

  it("keeps the step's own deadline under MOST_RUN_MS", () => {
    const short = fakeRecipes({
      nip: { ...fakeRecipe({ steps: ['green'], merges: ['green'] }), deadlineMs: () => 1_800_000 },
    });
    assert.deepStrictEqual(
      mergedCheckStep(short, stepChecks({ green: ['test'] }), batchOf('nip'))?.deadlineMs,
      1_800_000,
    );
  });

  it('names none for a recipe without such a step, an unknown recipe, or a step without checks', () => {
    assert.equal(
      mergedCheckStep(recipes, stepChecks({ plan: ['test'] }), batchOf('plain')),
      undefined,
    );
    assert.equal(mergedCheckStep(recipes, stepChecks({}), batchOf('gone')), undefined);
    assert.equal(mergedCheckStep(recipes, stepChecks({}), batchOf('nip')), undefined);
  });
});
