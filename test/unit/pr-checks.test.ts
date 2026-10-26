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
  const onTap = (batchId = 'web-7'): void => {
    accept({ kind: 'order', batchId, order: { issue: 7, repo: web } });
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
    assert.deepStrictEqual(batch().pullRequestChecks, {
      [pullRequest]: { kind: 'finished', head, checks },
    });
    assert.deepStrictEqual(types(), [
      'pull_request.checks_pending',
      'pull_request.checks_finished',
    ]);
    // A head recorded finished is not read again: only the head is.
    assert.deepStrictEqual(calls, [`head ${pullRequest}`, `checks ${pullRequest} a`]);
    assert.deepStrictEqual(finished.calls, [
      `head ${pullRequest}`,
      `checks ${pullRequest} a`,
      `head ${pullRequest}`,
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
    assert.deepStrictEqual(batch().pullRequestChecks?.[pullRequest], {
      kind: 'finished',
      head,
      checks: [],
    });
    assert.deepStrictEqual(checkLines(batch()), [
      `- <${pullRequest}> has no checks on \`aaaaaaaa\``,
    ]);
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
    onTap('web-8');
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

  it('refuses a second record of the same head, so a head is recorded once', () => {
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
    assert.equal(log.issue({ kind: 'record', event: pending }, now).kind, 'refused');
    // Nor a record of a pull request the batch did not open.
    const stranger = {
      ...finished,
      head: moved,
      pullRequest: 'https://github.com/acme/web/pull/99',
    };
    assert.equal(log.issue({ kind: 'record', event: stranger }, now).kind, 'refused');
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
