// A pre-existing finding becomes a Brewery issue once its batch's pull request merged (ADR 0356):
// one issue per finding the step its findings route went back to left as there before the change,
// through the ledger, with the label that marks it and no recipe, and the status comment links it.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { effectMarker } from '../../src/engine/claim-effects.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { type Driver, type DriverNotice, openDriver } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { combineEffects } from '../../src/engine/effects.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import {
  PRE_EXISTING,
  type PreExistingHost,
  preExistingIssueEffects,
} from '../../src/engine/pre-existing-issues.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { type StatusComments, statusEffects } from '../../src/engine/status-comment.ts';
import type { Disposition, TastingFinding } from '../../src/schemas/out-doc.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const brewery = 'alice/brewery';
const web = 'https://github.com/acme/web/pull/31';
const now = new Date('2026-11-08T09:00:00.000Z');
const recipes = fakeRecipes({
  // One Taster whose findings go back to implement once.
  lined: fakeRecipe({
    steps: ['implement', 'taste'],
    routes: { taste: { findings: 'implement' } },
    maxRounds: 1,
    pullRequests: [web],
  }),
});

/** A finding there before the change, and one the change made. */
const old: TastingFinding = {
  file: 'src/old.ts',
  line: 9,
  severity: 'minor',
  lens: 'diff/correctness',
  why: 'The retry loop sleeps without a jitter',
  introduced: false,
};
const made: TastingFinding = {
  file: 'src/new.ts',
  line: 3,
  severity: 'major',
  why: 'The flag is read twice',
  introduced: true,
};
const leftAsIt: Disposition = {
  file: 'src/old.ts',
  line: 9,
  disposition: 'pre-existing',
  why: 'The loop is on main as it was',
};
const fixedIt: Disposition = { file: 'src/new.ts', line: 3, disposition: 'fixed' };

const done = (dispositions: Disposition[] = []): Ending => ({
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [], dispositions },
});
const blocked = (findings: TastingFinding[]): Ending => ({
  kind: 'blocked',
  blockerKind: 'findings',
  summary: 'Changes asked',
  findings,
});
const approved: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Tasted', assumptions: [], verdict: 'approve', findings: [] },
};

interface Opened {
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
}

/**
 * The Brewery's issues and labels in memory, numbered from 40 so no number is the order's; an open
 * that `lost` names lands and then throws, as an answer lost on the way back.
 */
const breweryInMemory = (lost = 0) => {
  const issues: Opened[] = [];
  const labels: string[] = [];
  let opens = 0;
  const host: PreExistingHost = {
    findIssue: async (marker) => {
      const found = issues.find(({ body }) => body.includes(marker));
      return found === undefined ? undefined : { number: found.number, id: found.number * 100 };
    },
    openIssue: async (title, body, on) => {
      const number = 40 + issues.length;
      issues.push({ number, title, body, labels: on });
      if (++opens === lost) throw new Error('killed before the answer came');
      return { number, id: number * 100 };
    },
    createLabel: async (repo, label) => {
      assert.equal(repo, brewery);
      if (!labels.includes(label)) labels.push(label);
    },
  };
  return { host, issues, labels };
};

/** Status comments kept in memory, and their bodies. */
const commentsInMemory = () => {
  const bodies = new Map<number, string>();
  const comments: StatusComments = {
    find: async (_repo, _issue, marker) => {
      const found = [...bodies].find(([, body]) => body.endsWith(marker));
      return found === undefined ? undefined : { id: found[0], body: found[1] };
    },
    read: async (_repo, id) => bodies.get(id),
    create: async (_repo, _issue, body) => {
      bodies.set(bodies.size + 1, body);
      return bodies.size;
    },
    edit: async (_repo, id, body) => {
      bodies.set(id, body);
      return 'edited';
    },
  };
  return { comments, latest: () => [...bodies.values()].at(-1) ?? '' };
};

describe('preExistingIssueEffects (ADR 0356)', () => {
  let store: EventStore;
  let log: CommandLog;
  let notices: DriverNotice[];
  const drivers: Driver[] = [];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    notices = [];
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  const open = async (host: PreExistingHost, comments?: StatusComments): Promise<Driver> => {
    const issues = preExistingIssueEffects({ host, brewery });
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects:
        comments === undefined
          ? issues
          : combineEffects(issues, statusEffects({ brewery, comments, recipes, clock: () => now })),
      report: (notice) => notices.push(notice),
    });
    drivers.push(driver);
    return driver;
  };
  const accept = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = log.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  /** The scheduled attempt of `stepId`, started and ended with `ending`. */
  const run = (stepId: string, ending: Ending, batchId = '12-1'): void => {
    const attempts = log.state().batches.get(batchId)?.steps.get(stepId)?.attempts;
    const attempt = Math.max(...(attempts?.keys() ?? []));
    assert.equal(attempts?.get(attempt)?.phase, 'scheduled', `${stepId} is scheduled`);
    const ref = { batchId, stepId, attempt };
    accept({ kind: 'record', event: { type: 'step.started', ...ref } });
    accept({ kind: 'finish', ...ref, ending });
  };
  /**
   * Batch 12-1 of the Brewery issue #12 brewed on tap: the Taster's first round finds `findings`,
   * implement answers with `dispositions`, and the second round approves.
   */
  const onTap = (findings: TastingFinding[], dispositions: Disposition[]): void => {
    accept({ kind: 'order', batchId: '12-1', order: { issue: 12 } });
    accept({ kind: 'route', batchId: '12-1', recipe: 'lined', reason: 'label', source: 'label' });
    run('implement', done());
    run('taste', blocked(findings));
    run('implement', done(dispositions));
    run('taste', approved);
    assert.equal(log.state().batches.get('12-1')?.lane.kind, 'on_tap');
  };
  /** Whether the status comment showed the end of batch 12-1, as the store folds it now. */
  const shown = (): boolean | undefined =>
    createCommandLog({ store, recipes }).state().batches.get('12-1')?.endShown;
  const ended = (state: 'merged' | 'closed'): void =>
    accept({
      kind: 'record',
      event: { type: 'pull_request.ended', batchId: '12-1', pullRequest: web, state },
    });

  it('opens one Brewery issue with the finding and the label once the pull request merged', async () => {
    onTap([made, old], [fixedIt, leftAsIt]);
    const brewery = breweryInMemory();
    const driver = await open(brewery.host);
    await driver.tick();
    assert.equal(brewery.issues.length, 0, 'none while the pull request is open');
    ended('merged');
    await driver.tick();
    assert.equal(brewery.issues.length, 1);
    const [issue] = brewery.issues;
    assert.equal(issue?.title, 'Pre-existing: diff/correctness, minor in src/old.ts:9');
    assert.deepStrictEqual(issue?.labels, [PRE_EXISTING]);
    assert.ok(brewery.labels.includes(PRE_EXISTING), 'the label is made before the issue');
    const body = issue?.body ?? '';
    assert.match(body, /The retry loop sleeps without a jitter/);
    assert.match(body, /The loop is on main as it was/);
    assert.match(body, /acme\/web#31/);
    assert.match(body, /#12\b/);
    assert.doesNotMatch(body, /The flag is read twice/, 'a fixed finding opens none');
    const key = effectKey.encode({ batchId: '12-1', effect: 'pre-existing.taste.1.2' });
    assert.ok(body.includes(effectMarker(key)), 'the body carries its key');
    assert.deepStrictEqual(
      store.findEffect({ batchId: '12-1', effect: 'pre-existing.taste.1.2' }),
      {
        result: { number: 40, id: 4000 },
      },
    );
    assert.deepStrictEqual(notices, []);
  });

  it('opens none when the pull request closed without merging', async () => {
    onTap([old], [leftAsIt]);
    ended('closed');
    const brewery = breweryInMemory();
    const driver = await open(brewery.host);
    await driver.tick();
    assert.equal(brewery.issues.length, 0);
    assert.equal(
      store.findEffect({ batchId: '12-1', effect: 'pre-existing.taste.1.1' }),
      undefined,
    );
  });

  it('finds an issue whose answer was lost and opens it no second time', async () => {
    onTap([old], [leftAsIt]);
    ended('merged');
    const brewery = breweryInMemory(1);
    const driver = await open(brewery.host);
    await driver.tick();
    await driver.tick();
    assert.equal(brewery.issues.length, 1);
    assert.deepStrictEqual(
      store.findEffect({ batchId: '12-1', effect: 'pre-existing.taste.1.1' }),
      {
        result: { number: 40, id: 4000 },
      },
    );
  });

  it('leaves a secret out of the issue and shows Markdown and mentions as text', async () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;
    onTap(
      [{ ...old, why: `Ping @alice about <b>this</b> loop` }],
      [{ ...leftAsIt, why: `The token ${token} was there` }],
    );
    ended('merged');
    const brewery = breweryInMemory();
    const driver = await open(brewery.host);
    await driver.tick();
    const body = brewery.issues[0]?.body ?? '';
    assert.doesNotMatch(body, /ghp_/);
    assert.match(body, /\\\[left out: a text of step implement that looks like a secret\\\]/);
    assert.match(body, /Ping &#64;alice about &lt;b&gt;this&lt;\/b&gt; loop/);
  });

  it('opens none for a batch whose status comment showed its end before this record', async () => {
    onTap([old], [leftAsIt]);
    ended('merged');
    const { comments, latest } = commentsInMemory();
    const quiet = breweryInMemory();
    // A driver from before ADR 0356: the comment shows the end, and nothing opens the issue.
    const status = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => now,
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects: statusEffects({ brewery, comments, recipes, clock: () => now }),
      report: (notice) => notices.push(notice),
    });
    await status.tick();
    status.close();
    assert.deepStrictEqual(notices, []);
    assert.equal(shown(), true, 'the end is shown');
    assert.match(latest(), /batch `12-1`/);
    const driver = await open(quiet.host);
    await driver.tick();
    assert.equal(quiet.issues.length, 0);
  });

  it('links each opened issue in the status comment', async () => {
    onTap([old], [leftAsIt]);
    ended('merged');
    const brewery = breweryInMemory();
    const { comments, latest } = commentsInMemory();
    const driver = await open(brewery.host, comments);
    await driver.tick();
    assert.equal(brewery.issues.length, 1);
    assert.match(
      latest(),
      /\*\*Filed\*\*\n- #40: diff\/correctness, minor in src\/old\.ts:9, there before the change/,
    );
    assert.equal(shown(), true);
  });

  it('keeps the status comment open until the issue it links is opened', async () => {
    onTap([old], [leftAsIt]);
    ended('merged');
    const brewery = breweryInMemory();
    let down = true;
    const failing: PreExistingHost = {
      ...brewery.host,
      openIssue: async (...args) => {
        if (down) throw new Error('GitHub is down');
        return brewery.host.openIssue(...args);
      },
    };
    const { comments, latest } = commentsInMemory();
    const driver = await open(failing, comments);
    await driver.tick();
    assert.equal(brewery.issues.length, 0);
    assert.equal(notices.length, 1, 'the open failed');
    assert.notEqual(shown(), true, 'the end is not shown without the link');
    down = false;
    await driver.tick();
    assert.equal(brewery.issues.length, 1);
    assert.match(latest(), /\*\*Filed\*\*\n- #40: /);
    assert.equal(shown(), true);
  });
});
