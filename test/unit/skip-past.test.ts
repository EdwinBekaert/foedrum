// What a pull request and a status comment say of a step a person's skip went past (ADR 0345), through
// the real driver, the default nip and the real pull request and status comment effects on a fake host.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { effectMarker } from '../../src/engine/claim-effects.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { openDriver } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { pullRequestText, stepReports } from '../../src/engine/pull-request.ts';
import { pullRequestActions } from '../../src/engine/pull-request-actions.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { pastBySkip } from '../../src/engine/skip-past.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { statusEffects } from '../../src/engine/status-comment.ts';
import type { Event } from '../../src/schemas/events.ts';
import { PullRequestOutDoc, TastingOutDoc } from '../../src/schemas/out-doc.ts';
import { StatusRevision } from '../../src/schemas/status-comment.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { type Behaviour, behave, fakeBrewerRunner } from '../helpers/fake-brewer-runner.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeWorktrees } from '../helpers/fake-worktrees.ts';

const loaded = loadRecipes(readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')));
assert.ok(loaded.valid);
const { brewers, recipes } = loaded;
const clock = () => new Date('2026-11-07T12:00:00.000Z');
const url = 'https://github.com/acme/api/pull/9';
const done = behave.succeed();
const approve = behave.succeedWith({ verdict: 'approve', findings: [] }, 'Nothing found');
const cellar = behave.succeedWith({ howItWorks: 'It works.', seeIt: 'Run it.' });
const token = ['ghp', 'A1b2'.repeat(9)].join('_');
const finding = (why: string) => ({ severity: 'major', why, introduced: true, file: 'src/a.ts' });
const changes = (...whys: string[]) =>
  behave.succeedWith({ verdict: 'changes', findings: whys.map(finding) }, 'It asks for changes');
const tasters = ['acceptance', 'security', 'design-conformance'];
/** Every Taster's answers but correctness's, for `rounds` rounds. */
const others = (rounds: number): Record<string, Behaviour[]> =>
  Object.fromEntries(tasters.map((id) => [id, Array.from({ length: rounds }, () => approve)]));

/** A batch of the default nip on the real driver, with its pull request and its comment on fakes. */
const brewed = async (scripts: Record<string, Behaviour[]>) => {
  const store = openSqliteEventStore(':memory:');
  const remote: Record<string, string> = {};
  const opened: { draft: boolean | undefined; body: string }[] = [];
  const updates: unknown[][] = [];
  const comments = new Map<number, string>();
  const writes: string[] = [];
  const during: { edit?: () => void } = {};
  let pushes = 0;
  const actions = pullRequestActions({
    brewery: 'acme/brewery',
    repositories: [
      {
        repo: 'acme/api',
        base: 'main',
        push: {
          commit: async () => String(pushes + 1).repeat(40),
          baseTip: async () => 'b'.repeat(40),
          isAncestor: async (commit, of) => commit === of,
          remoteTip: async (name) => remote[name],
          push: async (commit, name) => {
            pushes++;
            remote[name] = commit;
          },
          secretScan: async () => [],
          touchedFiles: async () => [],
        },
      },
    ],
    host: {
      find: async () => undefined,
      open: async (_repo, request) => {
        opened.push({ draft: request.draft, body: request.body });
        return url;
      },
      body: async () => opened.at(-1)?.body ?? '',
      update: async (...args: unknown[]) => {
        updates.push(args);
      },
    },
    orderTitle: async () => 'A title',
    visibility: () => 'public',
  });
  let nextComment = 100;
  const effects = statusEffects({
    brewery: 'acme/brewery',
    recipes,
    clock,
    comments: {
      find: async () => undefined,
      read: async (_repo, comment) => comments.get(comment),
      create: async (_repo, _issue, body) => {
        const id = nextComment++;
        comments.set(id, String(body));
        writes.push(`create ${id}`);
        return id;
      },
      edit: async (_repo, comment, body) => {
        comments.set(comment, String(body));
        writes.push(`edit ${comment}`);
        const now = during.edit;
        delete during.edit;
        now?.();
        return 'edited';
      },
    },
  });
  const driver = await openDriver({
    store,
    runner: fakeBrewerRunner((attempt) => scripts[attempt.ref.stepId]?.shift() ?? done),
    worktrees: [{ repo: 'acme/api', base: 'origin/main', manager: fakeWorktrees() }],
    recipes,
    limits: ({ stepId }) => {
      if (stepId === 'implement') return { outDoc: { file: 'out.md', schema: PullRequestOutDoc } };
      const step = brewers.find('nip', stepId);
      if (step?.brewer.output.schema !== 'tasting') return defaultLimits;
      const outDoc = { file: 'out.md', schema: TastingOutDoc };
      return step.blocking === true ? { outDoc, blocking: true } : { outDoc };
    },
    clock,
    lock: () => fakeLock('cellar'),
    takes: () => true,
    stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
    effects,
    actions,
  });
  const log = createCommandLog({ store, recipes });
  log.issue({ kind: 'order', batchId: 'b1', order: { issue: 1 } }, clock());
  log.issue(
    { kind: 'route', batchId: 'b1', recipe: 'nip', reason: 'label', source: 'label' },
    clock(),
  );
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await driver.drive();
      await driver.tick();
    }
  };
  await settle();
  return {
    log,
    settle,
    opened,
    updates,
    writes,
    comments,
    during,
    head: () => String(pushes).repeat(40),
    lane: () => driver.state().batches.get('b1')?.lane,
    state: () => {
      const batch = driver.state().batches.get('b1');
      assert.ok(batch !== undefined);
      return batch;
    },
    comment: () => [...comments.values()].at(-1) ?? '',
    skip: async () => {
      log.issue({ kind: 'skip', batchId: 'b1', by: 'ada', via: 'terminal' }, clock());
      await settle();
    },
    merge: () =>
      log.issue(
        {
          kind: 'record',
          event: { type: 'pull_request.ended', batchId: 'b1', pullRequest: url, state: 'merged' },
        },
        clock(),
      ),
    /** As after an upgrade: the latest revision showed another text than this version renders. */
    asIfOlderText: () => {
      const [last] = store
        .eventsAfter(0)
        .flatMap(({ event }) =>
          event.type === 'effect.applied' && event.key.includes('"status') ? [event] : [],
        )
        .slice(-1);
      assert.ok(last !== undefined);
      const key = effectKey.decode(last.key);
      const n = Number(key.effect.split('.')[1]);
      const { comment } = last.result as { comment: number };
      store.withTransaction((tx) =>
        tx.append({
          type: 'effect.applied',
          key: effectKey.encode({ batchId: 'b1', effect: `status.${n + 1}` }),
          result: { comment, digest: '0123456789abcdef' },
        }),
      );
    },
  };
};

/** A batch whose correctness asked for changes in all three rounds, past which a person skipped. */
const pastItsRounds = async (...last: string[]) => {
  const batch = await brewed({
    implement: [cellar, cellar, cellar],
    correctness: [
      changes('Round one: an Ordered sub-order holds nothing'),
      changes('Round two: an Ordered sub-order holds nothing'),
      changes(...last),
    ],
    ...others(3),
  });
  assert.equal(batch.lane()?.kind, 'stuck');
  await batch.skip();
  assert.equal(batch.lane()?.kind, 'on_tap');
  return batch;
};

describe('what a pull request says of a step a skip went past', () => {
  it('a pull request past a skipped blocking Taster does not say every Taster approved', async () => {
    const { opened, comment } = await pastItsRounds(
      'Round three: an Ordered sub-order holds nothing',
    );
    assert.equal(opened.length, 1);
    const [{ draft, body }] = opened as [{ draft: boolean; body: string }];
    assert.equal(draft, true);
    assert.doesNotMatch(body, /every Taster approved/);
    const line = /`correctness` is left open by a skip: its attempt 3 was blocked by its findings/;
    assert.match(body, line);
    assert.match(body, /left open by a skip: major in src\/a\.ts: Round three: an Ordered/);
    // Its latest round's, as the merge brief lists them: an earlier round's are no longer current.
    assert.doesNotMatch(body, /Round two: an Ordered/);
    assert.match(comment(), line);
    assert.match(comment(), /left open by a skip: major in src\/a\.ts: Round three: an Ordered/);
    assert.doesNotMatch(comment(), /every Taster approved/);
  });

  it('holds a finding to the filters and limits of a Taster finding', async () => {
    const many = Array.from({ length: 12 }, (_, n) => `Finding number ${n + 1}.`);
    const { opened, comment } = await pastItsRounds(`Holds ${token} and @ann`, ...many);
    const body = opened[0]?.body ?? '';
    assert.match(body, /Finding number 12\./);
    assert.doesNotMatch(body, new RegExp(token));
    assert.doesNotMatch(comment(), new RegExp(token));
    // Ten in the status comment, as the merge brief has it, and how many more.
    assert.match(comment(), /Finding number 9\./);
    assert.doesNotMatch(comment(), /Finding number 10\./);
    assert.match(comment(), /left open by a skip: and 3 more/);
  });

  it('says a skipped failing check did not pass', async () => {
    const failing = behave.read([
      { result: 'exited', check: 'test', command: 'npm test', exitCode: 1, tail: '1 failing' },
    ]);
    const batch = await brewed({
      implement: [cellar],
      // Its attempts: a check that fails is tried again before the batch goes Stuck.
      green: [failing, failing],
      correctness: [approve],
      ...others(1),
    });
    assert.equal(batch.lane()?.kind, 'stuck');
    await batch.skip();
    const [{ draft, body }] = batch.opened as [{ draft: boolean; body: string }];
    assert.equal(draft, true);
    assert.doesNotMatch(body, /every Taster approved/);
    const line = /`green` did not pass: its attempt 2 failed, and a person's skip went past it/;
    assert.match(body, line);
    assert.match(batch.comment(), line);
  });

  it('waits for every Taster of the last round before it is Stuck, so a skip stops none of them (ADR 0354)', async () => {
    const { opened, comment } = await pastItsRounds('Round three');
    const body = opened[0]?.body ?? '';
    const line = /`acceptance` (did not pass|is left open)/;
    assert.doesNotMatch(body, line);
    assert.doesNotMatch(comment(), line);
    assert.match(
      body,
      /`correctness` is left open by a skip: its attempt 3 was blocked by its findings/,
    );
    assert.match(body, /acceptance: Nothing found\n\s+verdict: approve/);
  });

  it('does not count a step that ran again after the skip', async () => {
    const batch = await brewed({
      implement: [cellar, behave.blocked('environment', 'No disk left')],
      correctness: [changes('Round one: an Ordered sub-order holds nothing'), approve],
      ...others(2),
    });
    const lane = batch.lane();
    assert.ok(lane?.kind === 'stuck' && lane.reason.kind === 'blocked');
    assert.equal(lane.reason.stepId, 'implement');
    await batch.skip();
    const body = batch.opened[0]?.body ?? '';
    assert.match(
      body,
      /`implement` did not pass: its attempt 2 failed, and a person's skip went past it/,
    );
    const line = /`correctness` (is left open|did not pass)/;
    assert.doesNotMatch(body, line);
    assert.doesNotMatch(batch.comment(), line);
  });

  it('keeps the How it works of a Cellarman left open by a skip', async () => {
    const batch = await brewed({
      implement: [
        cellar,
        behave.blocked('findings', 'The test is wrong'),
        behave.blocked('findings', 'Still wrong'),
      ],
      gauge: [done, done, done],
      red: [done, done, done],
      correctness: [changes('Round one: an Ordered sub-order holds nothing'), approve],
      ...others(2),
    });
    assert.equal(batch.lane()?.kind, 'stuck');
    await batch.skip();
    const body = batch.opened[0]?.body ?? '';
    assert.match(body, /`implement` is left open by a skip/);
    assert.match(body, /It works\./);
    assert.doesNotMatch(body, /the Cellarman wrote none/);
  });

  it('drops the verdict of an earlier round of a Taster left open by a skip: regression test', async () => {
    const batch = await brewed({
      implement: [cellar, cellar, cellar, cellar],
      correctness: [
        // An approval with no finding, as any finding would send it back (ADR 0354).
        behave.succeedWith({ verdict: 'approve', riskLeft: ['A stale risk'] }, 'Nothing found'),
        changes('Round two'),
        changes('Round three'),
        changes('Round four'),
      ],
      ...others(4),
    });
    // Every brewed pull request opens as a draft; its merge brief marks it ready (ADR 0350).
    assert.equal(batch.opened[0]?.draft, true);
    const head = batch.head();
    batch.log.issue(
      {
        kind: 'record',
        event: {
          type: 'pull_request.checks_finished',
          batchId: 'b1',
          pullRequest: url,
          head,
          checks: [{ name: 'ci', kind: 'check_run', conclusion: 'failure' }],
        },
      },
      clock(),
    );
    batch.log.issue(
      {
        kind: 'fix_pull_request',
        batchId: 'b1',
        pullRequest: url,
        head,
        cause: { kind: 'checks' },
      },
      clock(),
    );
    await batch.settle();
    assert.equal(batch.lane()?.kind, 'stuck');
    await batch.skip();
    const text = JSON.stringify(batch.updates.at(-1));
    assert.match(text, /`correctness` is left open by a skip/);
    assert.doesNotMatch(text, /correctness: Nothing found/);
    assert.doesNotMatch(text, /A stale risk/);
    const batchState = batch.state();
    const reports = stepReports(batchState);
    const correctness = reports.find(({ stepId }) => stepId === 'correctness');
    assert.ok(correctness !== undefined);
    assert.equal(correctness.tasting, undefined);
  });

  it('lists how many more findings the round recorded than it kept: regression test', () => {
    const past = { line: '`correctness` is left', findings: [], more: 2, open: true };
    const reports = [{ stepId: 'correctness', summary: 'Blocked', assumptions: [], past }];
    const { body } = pullRequestText({ title: 'A title', reports });
    assert.match(body, /left open by a skip: and 2 more/);
  });

  it('puts what a skip went past before the sections that grow: regression test', async () => {
    const assuming = behave.succeedWith({
      howItWorks: 'It works.',
      seeIt: 'Run it.',
      assumptions: ['An assumption'],
    });
    const batch = await brewed({
      implement: [assuming, assuming, assuming],
      correctness: [changes('One'), changes('Two'), changes('Three')],
      ...others(3),
    });
    await batch.skip();
    const comment = batch.comment();
    const place = comment.indexOf('**Past a skip**');
    assert.ok(place >= 0);
    assert.ok(place < comment.indexOf('**Assumptions**'));
  });

  it('leaves a pull request that is ready as it is, and tells it in its body and comment', async () => {
    const batch = await brewed({
      implement: [cellar, behave.blocked('environment', 'No disk left')],
      correctness: [approve, approve],
      ...others(2),
    });
    // Every brewed pull request opens as a draft; its merge brief marks it ready (ADR 0350).
    assert.equal(batch.opened[0]?.draft, true);
    const head = batch.head();
    batch.log.issue(
      {
        kind: 'record',
        event: {
          type: 'pull_request.checks_finished',
          batchId: 'b1',
          pullRequest: url,
          head,
          checks: [{ name: 'ci', kind: 'check_run', conclusion: 'failure' }],
        },
      },
      clock(),
    );
    batch.log.issue(
      {
        kind: 'fix_pull_request',
        batchId: 'b1',
        pullRequest: url,
        head,
        cause: { kind: 'checks' },
      },
      clock(),
    );
    await batch.settle();
    assert.equal(batch.lane()?.kind, 'stuck');
    await batch.skip();
    assert.equal(batch.opened.length, 1);
    assert.equal(batch.updates.length, 1);
    // Worded to hold of a ready pull request: nothing turns it back into a draft (ADR 0227).
    const text = JSON.stringify(batch.updates[0]);
    assert.match(text, /`implement` did not pass: its attempt 2 failed/);
    assert.doesNotMatch(text, /every Taster approved/);
    assert.doesNotMatch(text, /before it is marked ready/);
    assert.match(batch.comment(), /`implement` did not pass: its attempt 2 failed/);
  });
});

describe('a status comment once its batch ended', () => {
  it("keeps saying what a skip went past in the merge's own last revision", async () => {
    const batch = await pastItsRounds('Round three');
    const before = batch.writes.length;
    // No checks are recorded on its head, so its brief is still to come (#940).
    assert.match(batch.comment(), /Next: wait for <[^>]+>'s merge brief/);
    batch.merge();
    await batch.settle();
    assert.equal(batch.writes.length, before + 1);
    assert.doesNotMatch(batch.comment(), /Next: review and merge/);
    assert.match(batch.comment(), /`correctness` is left open by a skip/);
  });

  it('is not edited for a text that only differs after an upgrade', async () => {
    const batch = await brewed({ implement: [cellar], correctness: [approve], ...others(1) });
    batch.merge();
    await batch.settle();
    const before = batch.writes.length;
    batch.asIfOlderText();
    await batch.settle();
    assert.equal(batch.writes.length, before);
  });

  it('is edited for such a text while its pull request is open: regression test', async () => {
    const batch = await brewed({ implement: [cellar], correctness: [approve], ...others(1) });
    const before = batch.writes.length;
    batch.asIfOlderText();
    await batch.settle();
    assert.equal(batch.writes.length, before + 1);
  });

  it('is written again when the merge is recorded while an edit is on its way: regression test', async () => {
    const batch = await brewed({ implement: [cellar], correctness: [approve], ...others(1) });
    const before = batch.writes.length;
    let merged = false;
    batch.during.edit = () => {
      batch.merge();
      merged = true;
    };
    batch.asIfOlderText();
    await batch.settle();
    assert.equal(merged, true);
    assert.equal(batch.writes.length, before + 2);
    assert.doesNotMatch(batch.comment(), /Next: review and merge/);
  });

  it('shows a failing mark, and its recovery, on a merged batch: regression test', async () => {
    const batch = await brewed({ implement: [cellar], correctness: [approve], ...others(1) });
    batch.merge();
    await batch.settle();
    batch.asIfOlderText();
    await batch.settle();
    const before = batch.writes.length;
    batch.log.issue(
      {
        kind: 'mark_failing',
        batchId: 'b1',
        pass: 'effects',
        summary: 'The Brewery issue will not close',
        since: clock().toISOString(),
        reading: false,
      },
      clock(),
    );
    await batch.settle();
    assert.equal(batch.writes.length, before + 2);
    assert.doesNotMatch(batch.comment(), /will not close/);
  });

  it('is not made again after it was deleted by hand: regression test', async () => {
    const batch = await brewed({ implement: [cellar], correctness: [approve], ...others(1) });
    batch.merge();
    await batch.settle();
    const before = batch.writes.length;
    assert.ok(before > 0);
    // A text that differs, so a revision would be due and would make it again.
    batch.asIfOlderText();
    batch.comments.clear();
    await batch.settle();
    assert.equal(batch.writes.length, before);
  });
});

describe('which batches have ended, for their status comment', () => {
  const routeBy = '2026-11-07T13:00:00.000Z';
  const a = 'https://github.com/acme/api/pull/1';
  const b = 'https://github.com/acme/api/pull/2';
  const first: Event = { type: 'batch.ordered', batchId: 'b1', order: { issue: 1 }, routeBy };
  /** The batch's log, its comment's revisions applied by the real effects on a fake host. */
  const logged = (...events: Event[]) => {
    const log = [first, ...events];
    const effects = statusEffects({
      brewery: 'acme/brewery',
      recipes,
      clock,
      comments: {
        find: async () => undefined,
        read: async () => undefined,
        create: async () => 100,
        edit: async () => 'edited',
      },
    });
    const due = () => effects.due(fold(log), 'b1');
    const record = (n: number, result: unknown) =>
      log.push({
        type: 'effect.applied',
        key: effectKey.encode({ batchId: 'b1', effect: `status.${n}` }),
        result,
      });
    return {
      add: (...more: Event[]) => log.push(...more),
      due,
      /** Applies the revision due, as it is. */
      shown: async () => {
        const [key] = due();
        assert.ok(key !== undefined);
        const applied = await effects.target.apply(
          effectKey.encode(key),
          AbortSignal.timeout(5_000),
        );
        record(Number(key.effect.split('.')[1]), applied);
      },
      /** Applies the revision due, then records another that showed an older version's text. */
      written: async () => {
        const [key] = due();
        assert.ok(key !== undefined);
        const applied = await effects.target.apply(
          effectKey.encode(key),
          AbortSignal.timeout(5_000),
        );
        const n = Number(key.effect.split('.')[1]);
        record(n, applied);
        record(n + 1, { comment: 100, digest: '0123456789abcdef' });
      },
    };
  };
  const onTap = (...pullRequests: string[]): Event => ({
    type: 'batch.on_tap',
    batchId: 'b1',
    pullRequests,
  });
  const ended = (pullRequest: string): Event => ({
    type: 'pull_request.ended',
    batchId: 'b1',
    pullRequest,
    state: 'merged',
  });

  it('has none due for a cancelled batch whose comment showed it', async () => {
    const log = logged({ type: 'batch.cancelled', batchId: 'b1', by: 'ada', via: 'terminal' });
    await log.written();
    assert.deepEqual(log.due(), []);
  });

  it('has none due for a batch whose pull requests all ended', async () => {
    const log = logged(onTap(a, b), ended(a), ended(b));
    await log.written();
    assert.deepEqual(log.due(), []);
  });

  it('has one due while one of its two pull requests is open: regression test', async () => {
    const log = logged(onTap(a, b), ended(a));
    await log.written();
    assert.equal(log.due().length, 1);
  });

  it('has one due for a split order on tap with no pull request: regression test', async () => {
    const log = logged(onTap());
    await log.written();
    assert.equal(log.due().length, 1);
  });

  it('counts a revision a run before made as showing the end only when it is the text due: regression test', async () => {
    let body = '';
    const effects = statusEffects({
      brewery: 'acme/brewery',
      recipes,
      clock,
      comments: {
        find: async () => ({ id: 100, body }),
        read: async () => undefined,
        create: async (_repo, _issue, text) => {
          body = String(text);
          return 100;
        },
        edit: async () => 'edited',
      },
    });
    const state = fold([first, onTap(a), ended(a)]);
    const [key] = effects.due(state, 'b1');
    assert.ok(key !== undefined);
    const encoded = effectKey.encode(key);
    const signal = AbortSignal.timeout(5_000);
    const applied = await effects.target.apply(encoded, signal);
    assert.equal(StatusRevision.parse(applied).open, undefined);
    const same = await effects.target.find(encoded, signal);
    assert.equal(StatusRevision.parse(same?.result).open, undefined);
    body = `Before the merge\n\n${effectMarker(encoded)}`;
    const older = await effects.target.find(encoded, signal);
    assert.equal(StatusRevision.parse(older?.result).open, true);
  });

  it('keeps the name a handover line gave a batch once an order of it came after it ended', async () => {
    const step = { batchId: 'b1', stepId: 'gauge', attempt: 1 };
    const handedOver = (...more: Event[]) =>
      logged(
        { type: 'step.scheduled', ...step, deadlineAt: routeBy },
        { type: 'step.started', ...step },
        {
          type: 'step.finished',
          ...step,
          outcome: {
            kind: 'succeeded',
            output: { status: 'done', summary: 'Done', assumptions: [] },
          },
          handover: ['A lesson'],
        },
        onTap(a),
        ...more,
      );
    const later: Event = { type: 'batch.ordered', batchId: 'b2', order: { issue: 1 }, routeBy };
    // While it is open, the later order changes that line, and so its text.
    const open = handedOver();
    await open.shown();
    assert.deepEqual(open.due(), []);
    open.add(later);
    assert.equal(open.due().length, 1);
    const done = handedOver(ended(a));
    await done.shown();
    done.add(later);
    assert.deepEqual(done.due(), []);
  });

  it('does not count a plan comment revision as showing the end: regression test', () => {
    const log = logged(onTap(a), ended(a));
    log.add({
      type: 'effect.applied',
      key: effectKey.encode({ batchId: 'b1', effect: 'plan.1' }),
      result: { comment: 5, digest: '0123456789abcdef' },
    });
    assert.equal(log.due().length, 1);
  });
});

describe('what a skip records in the fold', () => {
  const routeBy = '2026-11-07T13:00:00.000Z';
  const ordered: Event = { type: 'batch.ordered', batchId: 'b1', order: { issue: 1 }, routeBy };
  const chosen = (recipe: string): Event => ({
    type: 'batch.recipe_chosen',
    batchId: 'b1',
    recipe,
    reason: 'label',
    source: 'label',
  });
  /** `stepId`'s attempt that failed, and the batch Stuck on it. */
  const stuckOn = (stepId: string): Event[] => {
    const step = { batchId: 'b1', stepId, attempt: 1 };
    return [
      { type: 'step.scheduled', ...step, deadlineAt: routeBy },
      { type: 'step.started', ...step },
      {
        type: 'step.finished',
        ...step,
        outcome: { kind: 'failed', retryable: false, reason: 'It failed' },
      },
      {
        type: 'batch.stuck',
        batchId: 'b1',
        reason: { kind: 'blocked', stepId, blockerKind: 'environment', summary: 'It failed' },
        options: ['skip'],
        remindAt: routeBy,
      },
    ];
  };
  const skip: Event = {
    type: 'batch.resumed',
    batchId: 'b1',
    by: 'ada',
    via: 'terminal',
    action: 'skip',
  };
  const pastIn = (...events: Event[]) => {
    const batch = fold([ordered, ...events]).batches.get('b1');
    assert.ok(batch !== undefined);
    return pastBySkip(batch).map(({ stepId }) => stepId);
  };

  it('keeps what an earlier skip went past: regression test', () => {
    assert.deepEqual(pastIn(chosen('a'), ...stuckOn('x'), skip, ...stuckOn('y'), skip), ['x', 'y']);
  });

  it('drops what a skip went past when a recipe is chosen: regression test', () => {
    const skipped = [chosen('a'), ...stuckOn('x'), skip];
    assert.deepEqual(pastIn(...skipped), ['x']);
    assert.deepEqual(pastIn(...skipped, chosen('b')), []);
  });

  it('does not count a step of a recipe the batch left', () => {
    assert.deepEqual(pastIn(chosen('a'), ...stuckOn('x'), chosen('b'), ...stuckOn('y'), skip), [
      'y',
    ]);
  });

  const done = { status: 'done', summary: 'An earlier summary', assumptions: [] };
  /** A step that succeeded, then was blocked by its findings, past which a skip went. */
  const leftOpen = (more = 0) => {
    const step = { batchId: 'b1', stepId: 'x' };
    const batch = fold([
      ordered,
      chosen('a'),
      { type: 'step.scheduled', ...step, attempt: 1, deadlineAt: routeBy },
      { type: 'step.started', ...step, attempt: 1 },
      {
        type: 'step.finished',
        ...step,
        attempt: 1,
        outcome: { kind: 'succeeded', output: done },
        mutants: [
          {
            file: 'src/a.ts',
            line: 1,
            original: 'a',
            replacement: 'b',
            description: 'A stale mutant',
            verdict: { kind: 'survived' },
          },
        ],
      },
      { type: 'step.scheduled', ...step, attempt: 2, deadlineAt: routeBy },
      { type: 'step.started', ...step, attempt: 2 },
      {
        type: 'step.finished',
        ...step,
        attempt: 2,
        outcome: { kind: 'failed', retryable: false, reason: 'blocked (findings): It asks' },
        findings: { kept: [], more },
      },
      {
        type: 'batch.stuck',
        batchId: 'b1',
        reason: { kind: 'blocked', stepId: 'x', blockerKind: 'findings', summary: 'It asks' },
        options: ['skip'],
        remindAt: routeBy,
      },
      skip,
    ]).batches.get('b1');
    assert.ok(batch !== undefined);
    return stepReports(batch);
  };

  it("drops the mutants of a left-open step's earlier round: regression test", () => {
    const [report] = leftOpen();
    assert.equal(report?.summary, 'blocked (findings): It asks');
    assert.equal(report?.mutants, undefined);
  });

  it('counts the findings a round recorded past those it kept: regression test', () => {
    const reports = leftOpen(2);
    assert.equal(reports[0]?.past?.more, 2);
    const { body } = pullRequestText({ title: 'A title', reports });
    assert.match(body, /left open by a skip: and 2 more/);
  });

  it('counts a step whose attempt recorded no recipe: regression test', () => {
    assert.deepEqual(pastIn(...stuckOn('x'), chosen('b'), skip), ['x']);
  });

  it('records nothing for a skip of a batch Stuck on its pull request: regression test', () => {
    const [scheduled, started, finished] = stuckOn('x');
    assert.ok(scheduled && started && finished);
    const stuck: Event = {
      type: 'batch.stuck',
      batchId: 'b1',
      reason: {
        kind: 'pull_request_failed',
        stepId: 'x',
        pullRequest: 'https://github.com/acme/api/pull/9',
        head: 'c'.repeat(40),
        rounds: 2,
        failed: [],
        more: 0,
      },
      options: ['skip'],
      remindAt: routeBy,
    };
    assert.deepEqual(pastIn(chosen('a'), scheduled, started, finished, stuck, skip), []);
  });
});
