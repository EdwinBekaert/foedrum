// The checks GitHub runs on an open pull request's head (ADR 0213): a fake reader answers the head
// and its checks, and the command log is the real one on a store in memory (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { formatReplay } from '../../src/cli/replay.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import type { Batch } from '../../src/engine/fold.ts';
import {
  checkPassed,
  type PullRequestCheckReader,
  type ReadCheck,
  recordChecks,
} from '../../src/engine/pr-checks.ts';
import { pullRequestKey, pushKey } from '../../src/engine/pull-request.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { checkLines, renderStatus } from '../../src/engine/status-comment.ts';
import { type CheckConclusion, type Event, MAX_HEAD_CHECKS } from '../../src/schemas/events.ts';
import type { PushResult } from '../../src/schemas/store.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const web = 'acme/web';
const pullRequest = 'https://github.com/acme/web/pull/12';
const head = 'a'.repeat(40);
const moved = 'f'.repeat(40);
const first = new Date('2026-10-26T09:00:00.000Z');
const recipes = fakeRecipes({
  half: fakeRecipe({ steps: ['plan'], pullRequests: [pullRequest] }),
});
const succeeded: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};

const passed = (name: string, url?: string): ReadCheck => ({
  name,
  kind: 'check_run',
  conclusion: 'success',
  ...(url === undefined ? {} : { url }),
});
const running = (name: string): ReadCheck => ({ name, kind: 'check_run' });
const failing = (name: string, conclusion: CheckConclusion, url?: string): ReadCheck => ({
  name,
  kind: 'check_run',
  conclusion,
  ...(url === undefined ? {} : { url }),
});

/** A reader whose pull request heads `state.head`, with the checks of each head in `checks`. */
const fakeReader = (checks: Record<string, readonly ReadCheck[] | Error>) => {
  const state = { head: head as string | Error };
  const calls: string[] = [];
  const reader: PullRequestCheckReader = {
    head: async (url) => {
      calls.push(`head ${url}`);
      if (state.head instanceof Error) throw state.head;
      return state.head;
    },
    checks: async (url, sha) => {
      calls.push(`checks ${url} ${sha.slice(0, 1)}`);
      const found = checks[sha];
      if (found === undefined) throw new Error(`no checks for ${sha}`);
      if (found instanceof Error) throw found;
      return found;
    },
  };
  return { reader, state, calls };
};

describe('recordChecks', () => {
  let store: EventStore;
  let log: CommandLog;
  let failures: { what: string; error: unknown }[];
  let now: Date;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    failures = [];
    now = first;
  });
  afterEach(() => store.close());

  const accept = (command: Parameters<CommandLog['issue']>[0]): void =>
    assert.equal(log.issue(command, now).kind, 'accepted');
  const ledger = (key: Parameters<typeof effectKey.encode>[0], result: unknown): void =>
    accept({
      kind: 'record',
      event: { type: 'effect.applied', key: effectKey.encode(key), result },
    });
  /** `web-7` on tap with the pull request its ledger opened and the commit its push recorded. */
  const onTap = (batchId = 'web-7', issue = 7): void => {
    accept({ kind: 'order', batchId, order: { issue, repo: web } });
    accept({ kind: 'route', batchId, recipe: 'half', reason: 'label', source: 'label' });
    const ref = { batchId, stepId: 'plan', attempt: 1 };
    accept({ kind: 'record', event: { type: 'step.started', ...ref } });
    accept({ kind: 'finish', ...ref, ending: succeeded });
    const pushed: PushResult = { branch: 'foedrum/x/acme.web', commit: head, from: 'start' };
    ledger(pushKey(batchId), pushed);
    ledger(pullRequestKey(batchId), pullRequest);
  };
  const batch = (batchId = 'web-7'): Batch => {
    const found = log.state().batches.get(batchId);
    assert.ok(found);
    return found;
  };
  const types = (): string[] =>
    store
      .eventsAfter(0)
      .map(({ event }) => event.type)
      .filter((type) => type.startsWith('pull_request.checks'));
  const pass = (reader: PullRequestCheckReader, signal = new AbortController().signal) =>
    recordChecks(
      { log, reader, clock: () => now, failed: (what, error) => failures.push({ what, error }) },
      signal,
    );

  it('records nothing but since when while a check runs, and says it waits for them', async () => {
    onTap();
    const { reader } = fakeReader({ [head]: [passed('build'), running('test')] });
    await pass(reader);
    now = new Date('2026-10-26T10:00:00.000Z');
    await pass(reader);
    assert.deepStrictEqual(batch().pullRequestChecks, {
      [pullRequest]: { kind: 'pending', head, since: first.toISOString() },
    });
    assert.deepStrictEqual(types(), ['pull_request.checks_pending']);
    assert.deepStrictEqual(checkLines(batch()), [
      `- <${pullRequest}> waits for its checks on \`aaaaaaaa\` since 2026-10-26T09:00:00.000Z`,
    ]);
    assert.deepStrictEqual(failures, []);
  });

  it('records finished checks once, each with its name, conclusion and link', async () => {
    onTap();
    const checks = [
      passed('build', 'https://github.com/acme/web/actions/runs/1/job/1'),
      { name: 'ci/coverage', kind: 'status', conclusion: 'neutral' } as const,
      failing('docs', 'skipped'),
    ];
    const { reader, calls } = fakeReader({ [head]: [running('build')] });
    await pass(reader);
    const finished = fakeReader({ [head]: checks });
    await pass(finished.reader);
    await pass(finished.reader);
    // The pass itself skips what did not change: nothing is refused and reported.
    assert.deepStrictEqual(failures, []);
    assert.deepStrictEqual(batch().pullRequestChecks, {
      [pullRequest]: { kind: 'finished', head, checks },
    });
    assert.deepStrictEqual(types(), [
      'pull_request.checks_pending',
      'pull_request.checks_finished',
    ]);
    // A head recorded finished is read again each pass, and what did not change records nothing.
    assert.deepStrictEqual(calls, [`head ${pullRequest}`, `checks ${pullRequest} a`]);
    assert.deepStrictEqual(finished.calls, [
      `head ${pullRequest}`,
      `checks ${pullRequest} a`,
      `head ${pullRequest}`,
      `checks ${pullRequest} a`,
    ]);
    assert.deepStrictEqual(checkLines(batch()), [
      `- <${pullRequest}> passed its checks on \`aaaaaaaa\``,
    ]);
  });

  it('records checks that finished before any pass saw them run, without a pending record', async () => {
    onTap();
    await pass(fakeReader({ [head]: [passed('build')] }).reader);
    assert.deepStrictEqual(types(), ['pull_request.checks_finished']);
  });

  it('counts failed, cancelled, timed-out, action-required, stale, startup-failed, errored and unknown as failed', () => {
    const failed: CheckConclusion[] = [
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'stale',
      'startup_failure',
      'error',
      'unknown',
    ];
    for (const conclusion of failed) assert.equal(checkPassed(conclusion), false, conclusion);
    for (const conclusion of ['success', 'neutral', 'skipped'] as const) {
      assert.equal(checkPassed(conclusion), true, conclusion);
    }
  });

  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required'] as const) {
    it(`says a ${conclusion} check failed, with its link`, async () => {
      onTap();
      const url = 'https://github.com/acme/web/actions/runs/1/job/9';
      await pass(
        fakeReader({ [head]: [passed('build'), failing('test', conclusion, url)] }).reader,
      );
      assert.deepStrictEqual(checkLines(batch()), [
        `- <${pullRequest}> failed its checks on \`aaaaaaaa\`: test (${conclusion}) <${url}>`,
      ]);
    });
  }

  it('says a failing commit status failed, and how many more failed', async () => {
    onTap();
    const checks: ReadCheck[] = [
      { name: 'ci/coverage', kind: 'status', conclusion: 'error' },
      {
        name: 'ci/<b>lint</b>',
        kind: 'status',
        conclusion: 'failure',
        url: 'https://ci.example/1',
      },
      failing('test', 'failure'),
    ];
    await pass(fakeReader({ [head]: checks }).reader);
    // The first failing check with a link is named; a name is escaped, as every text from GitHub.
    assert.deepStrictEqual(checkLines(batch()), [
      `- <${pullRequest}> failed its checks on \`aaaaaaaa\`: ci/&lt;b&gt;lint&lt;/b&gt; (failure) <https://ci.example/1>, and 2 more`,
    ]);
  });

  it('records a head with no checks as such, but only on a pass after the one that saw none', async () => {
    onTap();
    const { reader } = fakeReader({ [head]: [] });
    await pass(reader);
    assert.deepStrictEqual(types(), ['pull_request.checks_pending']);
    assert.deepStrictEqual(checkLines(batch()), [
      `- <${pullRequest}> waits for its checks on \`aaaaaaaa\` since 2026-10-26T09:00:00.000Z`,
    ]);
    await pass(reader);
    await pass(reader);
    assert.deepStrictEqual(types(), [
      'pull_request.checks_pending',
      'pull_request.checks_finished',
    ]);
    assert.deepStrictEqual(failures, []);
    assert.deepStrictEqual(batch().pullRequestChecks?.[pullRequest], {
      kind: 'finished',
      head,
      checks: [],
    });
    assert.deepStrictEqual(checkLines(batch()), [
      `- <${pullRequest}> has no checks on \`aaaaaaaa\``,
    ]);
  });

  for (const [what, checks] of [
    ['no checks', []],
    ['a running check', [running('build')]],
  ] as const) {
    it(`waits again for a head that moved while the one before it waited, with ${what} on it`, async () => {
      onTap();
      const { reader, state } = fakeReader({ [head]: [running('build')], [moved]: checks });
      await pass(reader);
      state.head = moved;
      now = new Date('2026-10-26T11:00:00.000Z');
      await pass(reader);
      // The pending record of the head before never counts for this one.
      assert.deepStrictEqual(batch().pullRequestChecks?.[pullRequest], {
        kind: 'pending',
        head: moved,
        since: '2026-10-26T11:00:00.000Z',
      });
      assert.deepStrictEqual(types(), [
        'pull_request.checks_pending',
        'pull_request.checks_pending',
      ]);
    });
  }

  it('names the first failing check when none has a link, and counts the rest', async () => {
    onTap();
    const checks: ReadCheck[] = [
      passed('build'),
      failing('test', 'failure'),
      { name: 'ci/coverage', kind: 'status', conclusion: 'error' },
    ];
    await pass(fakeReader({ [head]: checks }).reader);
    assert.deepStrictEqual(checkLines(batch()), [
      `- <${pullRequest}> failed its checks on \`aaaaaaaa\`: test (failure), and 1 more`,
    ]);
  });

  it('shows no checks line once the pull request ended', async () => {
    onTap();
    await pass(fakeReader({ [head]: [running('build')] }).reader);
    accept({
      kind: 'record',
      event: { type: 'pull_request.ended', batchId: 'web-7', pullRequest, state: 'merged' },
    });
    assert.deepStrictEqual(checkLines(batch()), []);
  });

  it('reads a head that moved from the start, and an old record never counts for it', async () => {
    onTap();
    const { reader, state } = fakeReader({
      [head]: [passed('build')],
      [moved]: [running('build')],
    });
    await pass(reader);
    state.head = moved;
    now = new Date('2026-10-26T11:00:00.000Z');
    await pass(reader);
    assert.deepStrictEqual(batch().pullRequestChecks?.[pullRequest], {
      kind: 'pending',
      head: moved,
      since: '2026-10-26T11:00:00.000Z',
    });
    assert.deepStrictEqual(checkLines(batch()), [
      `- <${pullRequest}> waits for its checks on \`ffffffff\` since 2026-10-26T11:00:00.000Z`,
    ]);
    // Back on the first head: read again, since the latest record names another.
    state.head = head;
    await pass(reader);
    assert.deepStrictEqual(batch().pullRequestChecks?.[pullRequest]?.head, head);
    assert.deepStrictEqual(types(), [
      'pull_request.checks_finished',
      'pull_request.checks_pending',
      'pull_request.checks_finished',
    ]);
  });

  it('reads no pull request that ended, nor one whose branch someone else pushed to', async () => {
    onTap('web-7');
    onTap('web-8', 8);
    accept({
      kind: 'record',
      event: { type: 'pull_request.ended', batchId: 'web-7', pullRequest, state: 'closed' },
    });
    accept({
      kind: 'record',
      event: {
        type: 'pull_request.base_checked',
        batchId: 'web-8',
        pullRequest,
        branch: 'main',
        tip: 'c'.repeat(40),
        branchMoved: moved,
      },
    });
    const { reader, calls } = fakeReader({ [head]: [passed('build')] });
    await pass(reader);
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(types(), []);
  });

  it('reports a read that fails, records nothing, and tries again next pass', async () => {
    onTap();
    const { reader, state } = fakeReader({ [head]: new Error('GitHub answered 502') });
    await pass(reader);
    state.head = new Error('no network');
    await pass(reader);
    assert.deepStrictEqual(
      failures.map(({ what, error }) => [what, (error as Error).message]),
      [
        [`reading the checks of ${pullRequest}`, 'GitHub answered 502'],
        [`reading the checks of ${pullRequest}`, 'no network'],
      ],
    );
    assert.deepStrictEqual(types(), []);
    state.head = head;
    await pass(fakeReader({ [head]: [passed('build')] }).reader);
    assert.deepStrictEqual(types(), ['pull_request.checks_finished']);
  });

  it('records nothing once its pass is given up', async () => {
    onTap();
    const stop = new AbortController();
    const reader: PullRequestCheckReader = {
      head: async () => head,
      checks: async () => {
        stop.abort();
        return [passed('build')];
      },
    };
    await pass(reader, stop.signal);
    assert.deepStrictEqual(types(), []);
  });

  it(`keeps the first ${MAX_HEAD_CHECKS} checks, failed first, and counts the rest`, async () => {
    onTap();
    const checks = [
      ...Array.from({ length: MAX_HEAD_CHECKS + 5 }, (_, n) => passed(`job ${n}`)),
      failing('late', 'failure'),
    ];
    await pass(fakeReader({ [head]: checks }).reader);
    const record = batch().pullRequestChecks?.[pullRequest];
    assert.equal(record?.kind, 'finished');
    assert.equal(record.checks.length, MAX_HEAD_CHECKS);
    assert.equal(record.checks[0]?.name, 'late');
    assert.equal(record.checks[1]?.name, 'job 0');
    assert.equal(record.more, 6);
  });

  it('counts the failed checks a record left out when every check it kept failed', async () => {
    onTap();
    const checks = [
      ...Array.from({ length: MAX_HEAD_CHECKS + 20 }, (_, n) => failing(`job ${n}`, 'failure')),
      ...Array.from({ length: 10 }, (_, n) => passed(`ok ${n}`)),
    ];
    await pass(fakeReader({ [head]: checks }).reader);
    // 120 failed, but the record keeps 100 and counts 30 left out, failed or not: at least 99 more.
    assert.deepStrictEqual(checkLines(batch()), [
      `- <${pullRequest}> failed its checks on \`aaaaaaaa\`: job 0 (failure), and at least 99 more`,
    ]);
  });

  it(`records exactly ${MAX_HEAD_CHECKS} checks with no count of more, and one more again`, async () => {
    onTap();
    const checks = Array.from({ length: MAX_HEAD_CHECKS }, (_, n) => passed(`job ${n}`));
    await pass(fakeReader({ [head]: checks }).reader);
    const record = batch().pullRequestChecks?.[pullRequest];
    assert.equal(record?.kind, 'finished');
    assert.equal(record.more, undefined);
    // Only the count of the rest differs: still a change of what GitHub says.
    await pass(fakeReader({ [head]: [...checks, passed('one more')] }).reader);
    const again = batch().pullRequestChecks?.[pullRequest];
    assert.equal(again?.kind, 'finished');
    assert.equal(again.more, 1);
    assert.deepStrictEqual(types(), [
      'pull_request.checks_finished',
      'pull_request.checks_finished',
    ]);
    assert.deepStrictEqual(failures, []);
  });

  it('refuses a record of a head that says what its latest record says', () => {
    onTap();
    const finished = {
      type: 'pull_request.checks_finished',
      batchId: 'web-7',
      pullRequest,
      head,
      checks: [],
    } satisfies Extract<Event, { type: 'pull_request.checks_finished' }>;
    const pending = {
      type: 'pull_request.checks_pending',
      batchId: 'web-7',
      pullRequest,
      head,
      since: first.toISOString(),
    } satisfies Extract<Event, { type: 'pull_request.checks_pending' }>;
    accept({ kind: 'record', event: pending });
    assert.equal(log.issue({ kind: 'record', event: pending }, now).kind, 'refused');
    accept({ kind: 'record', event: finished });
    assert.equal(log.issue({ kind: 'record', event: finished }, now).kind, 'refused');
    // The same checks in another order say the same.
    const two = [passed('b'), passed('a')].map((check) => ({
      ...check,
      conclusion: 'success' as const,
    }));
    accept({ kind: 'record', event: { ...finished, checks: two } });
    assert.equal(
      log.issue({ kind: 'record', event: { ...finished, checks: [...two].reverse() } }, now).kind,
      'refused',
    );
    // A check that came late, and a re-run that passed, are each recorded on the same head.
    accept({ kind: 'record', event: pending });
    accept({ kind: 'record', event: finished });
    // Nor a record of a pull request the batch did not open.
    const stranger = {
      ...finished,
      head: moved,
      pullRequest: 'https://github.com/acme/web/pull/99',
    };
    assert.equal(log.issue({ kind: 'record', event: stranger }, now).kind, 'refused');
  });

  it('records a re-run on the same head that passed after its checks failed', async () => {
    onTap();
    const url = 'https://github.com/acme/web/actions/runs/1/job/9';
    await pass(fakeReader({ [head]: [failing('test', 'failure', url)] }).reader);
    await pass(fakeReader({ [head]: [passed('test', url)] }).reader);
    assert.deepStrictEqual(types(), [
      'pull_request.checks_finished',
      'pull_request.checks_finished',
    ]);
    assert.deepStrictEqual(checkLines(batch()), [
      `- <${pullRequest}> passed its checks on \`aaaaaaaa\``,
    ]);
  });

  it('waits again for a check that registers on a head after its checks finished', async () => {
    onTap();
    await pass(fakeReader({ [head]: [passed('build')] }).reader);
    now = new Date('2026-10-26T09:01:00.000Z');
    await pass(fakeReader({ [head]: [passed('build'), running('test')] }).reader);
    assert.deepStrictEqual(batch().pullRequestChecks?.[pullRequest], {
      kind: 'pending',
      head,
      since: '2026-10-26T09:01:00.000Z',
    });
    assert.deepStrictEqual(checkLines(batch()), [
      `- <${pullRequest}> waits for its checks on \`aaaaaaaa\` since 2026-10-26T09:01:00.000Z`,
    ]);
    await pass(fakeReader({ [head]: [passed('build'), failing('test', 'failure')] }).reader);
    assert.deepStrictEqual(types(), [
      'pull_request.checks_finished',
      'pull_request.checks_pending',
      'pull_request.checks_finished',
    ]);
    assert.deepStrictEqual(checkLines(batch()), [
      `- <${pullRequest}> failed its checks on \`aaaaaaaa\`: test (failure)`,
    ]);
  });

  it('shows no checks line once someone else pushed to the branch, since they are read no more', async () => {
    onTap();
    await pass(fakeReader({ [head]: [running('build')] }).reader);
    accept({
      kind: 'record',
      event: {
        type: 'pull_request.base_checked',
        batchId: 'web-7',
        pullRequest,
        branch: 'main',
        tip: 'c'.repeat(40),
        branchMoved: moved,
      },
    });
    assert.deepStrictEqual(checkLines(batch()), []);
  });

  it('shows its line in the status comment and its events in replay', async () => {
    onTap();
    await pass(fakeReader({ [head]: [running('build')] }).reader);
    const text = renderStatus(batch());
    assert.match(
      text,
      /\*\*Pull requests\*\*\n- <https:\/\/github\.com\/acme\/web\/pull\/12>\n- <https:\/\/github\.com\/acme\/web\/pull\/12> waits for its checks on `aaaaaaaa` since 2026-10-26T09:00:00\.000Z/,
    );
    assert.match(formatReplay(batch(), store.eventsAfter(0)), /pull_request\.checks_pending/);
  });
});
