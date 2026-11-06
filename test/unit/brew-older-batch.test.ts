// A batch that is not its issue's latest, waiting for a session (ADR 0339): what each line offers
// for it, and what that command opens. A batch on tap counts as ended, so a later batch can be
// ordered, and its failed pull request can then send it back along a route through an interactive
// step. serve's shell with an in-memory store, fake worktrees, a fake GitHub and the scripted runner;
// no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type BrewRequest, runBrew } from '../../src/cli/brew.ts';
import { batchTarget, brewRequestOf } from '../../src/cli/brew-main.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { describeLane } from '../../src/cli/status.ts';
import { formatStuck } from '../../src/cli/stuck.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { takeOver } from '../../src/engine/batch-leases.ts';
import { calledAs } from '../../src/engine/claim-orders.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { foldedBatch } from '../../src/engine/fold.ts';
import { BrewCommand } from '../../src/schemas/commands.ts';
import { brewFixture, idle, request, t0 } from '../helpers/brew-fixture.ts';
import { type Behaviour, behave, question } from '../helpers/fake-brewer-runner.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { FAKE_COMMIT } from '../helpers/fake-worktrees.ts';
import { failedCheck } from '../helpers/open-pull-request.ts';
import { brewer, config, local, serveInputs } from '../helpers/serve-brewery.ts';

const RECIPE = JSON.stringify({
  name: 'lauter',
  description: 'A session, then a pull request whose failure goes back to the session.',
  steps: [
    { id: 'refine', brewer: 'steward', interactive: true, prompt: 'Refine it with me.' },
    { action: 'openPullRequest', onPullRequestFail: { goto: 'refine', maxRounds: 2 } },
  ],
  testFirst: false,
});
const STEWARD = brewer
  .replace('"cellarman"', '"steward"')
  .replace('"maxAttempts": 1', '"maxAttempts": 3');

/** What each command a line offers is given: `brew 12-1`. */
const offered = (lines: readonly string[]): string[] =>
  lines.flatMap((line) =>
    [...line.matchAll(/\bfoedrum ([a-z]+) (\S+)/g)].map(([, command, arg]) => `${command} ${arg}`),
  );

describe('an older batch waiting for a session (ADR 0339)', () => {
  const f = brewFixture();
  const issued = { by: 'ann', via: 'terminal' } as const;

  const shell = (behaviour: Behaviour = behave.succeed('Refined')) =>
    f.shell(behaviour, { lock: () => fakeLock('ann') });

  const startedIn = (batchId: string) =>
    f.store
      .eventsAfter(0)
      .flatMap(({ event }) =>
        event.type === 'step.started' && event.batchId === batchId
          ? [`${event.stepId}#${event.attempt}`]
          : [],
      );

  /** What the terminal makes of `foedrum brew <issue> --take`, through its schema and resolver. */
  const brewOf = (issue: string, noSessions?: BrewRequest['noSessions']): BrewRequest => {
    const parsed = BrewCommand.safeParse({ command: 'brew', issue, take: true });
    assert.ok(parsed.success, `foedrum brew ${issue} --take is refused: ${parsed.error?.message}`);
    const found = batchTarget(f.log().state(), parsed.data.issue, []);
    assert.ok(!('refused' in found), JSON.stringify(found));
    return brewRequestOf(parsed.data, 'ann', issued, noSessions, found);
  };

  /** Batch 12-1 sent back by its pull request and parked at refine, with 12-2 ordered after it. */
  const parked = async (): Promise<void> => {
    assert.equal(await runBrew(f.setup, shell(), request), 0, f.lines.join('\n'));
    const log = f.log();
    const onTap = foldedBatch(log.state(), '12-1');
    const [pullRequest] = onTap.lane.kind === 'on_tap' ? onTap.lane.pullRequests : [];
    assert.ok(pullRequest !== undefined, 'batch 12-1 opened its pull request');
    const accept = (command: Parameters<typeof log.issue>[0]): void => {
      const decision = log.issue(command, t0);
      assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    };
    accept({ kind: 'order', batchId: '12-2', order: { issue: 12 }, ...issued });
    accept({
      kind: 'record',
      event: {
        type: 'pull_request.checks_finished',
        batchId: '12-1',
        pullRequest,
        head: FAKE_COMMIT,
        checks: [failedCheck],
      },
    });
    const cause = { kind: 'checks' } as const;
    const head = FAKE_COMMIT;
    accept({ kind: 'fix_pull_request', batchId: '12-1', pullRequest, head, cause });
    accept({ kind: 'await_session', batchId: '12-1', stepId: 'refine', attempt: 2 });
    f.lines.length = 0;
  };

  beforeEach(() => {
    const inputs = serveInputs({
      files: { ...serveInputs().files, local: local({ workRoot: f.dir.path }) },
    });
    const { brewery } = inputs.files;
    const result = serveSetup({
      ...inputs,
      files: {
        ...inputs.files,
        brewery: {
          ...brewery,
          recipes: [...brewery.recipes, { path: 'recipes/lauter.jsonc', text: RECIPE }],
          brewers: [...brewery.brewers, { path: 'brewers/steward.md', text: STEWARD }],
        },
      },
    });
    f.setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    f.api = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: ['recipe:lauter'], author: 'ann', title: 'L', body: 'Plan it.' },
        ],
      },
    });
  });

  describe('the lines that offer its session', () => {
    it('foedrum status names its id: regression test', async () => {
      await parked();
      const state = f.log().state();
      const older = foldedBatch(state, '12-1');
      assert.match(
        describeLane(older, calledAs(state, older)).detail,
        /^waiting for a session at refine: foedrum brew 12-1 --take opens it in a terminal/,
      );
    });

    it('foedrum stuck names its id: regression test', async () => {
      await parked();
      assert.match(formatStuck(f.log().state()), /foedrum brew 12-1 --take opens it in a terminal/);
    });
  });

  it("has a printed command that opens its session and no other's", async () => {
    await parked();
    const line = formatStuck(f.log().state());
    const [, printed] = /foedrum brew (\S+) --take opens it/.exec(line) ?? assert.fail(line);
    const exit = await runBrew(f.setup, shell(), brewOf(printed ?? ''));
    assert.equal(exit, 0, f.lines.join('\n'));
    const sessions = startedIn('12-1').filter((step) => step.startsWith('refine#'));
    assert.deepStrictEqual(sessions, ['refine#1', 'refine#3']);
    assert.deepStrictEqual(startedIn('12-2'), []);
    const state = f.log().state();
    assert.equal(foldedBatch(state, '12-1').lane.kind, 'on_tap');
    assert.equal(foldedBatch(state, '12-2').lane.kind, 'ordered');
    assert.ok(!offered(f.lines).includes('brew 12'), f.lines.join('\n'));
  });

  describe('the lines of a brew that opens no session, or whose session closes', () => {
    it('inside Claude Code, names its id with --take, as its status comment does', async () => {
      await parked();
      const inside = brewOf('12-1', 'claude-code');
      // Past the limit of one edit of a status comment a minute (ADR 0072).
      const minuteOn = f.shell(behave.succeed(), {
        lock: () => fakeLock('ann'),
        clock: () => new Date(t0.getTime() + 120_000),
      });
      assert.equal(await runBrew(f.setup, minuteOn, inside), 3, f.lines.join('\n'));
      assert.equal(
        f.lines.at(-1),
        'foedrum brew: run foedrum brew 12-1 --take in a terminal to open its session',
      );
      const bodies = (f.api.comments.get('acme/brewery#12') ?? []).map(({ body }) => body);
      assert.ok(
        bodies.some((body) => body.includes('run `foedrum brew 12-1 --take` in a terminal')),
        bodies.join('\n---\n'),
      );
    });

    it('without a terminal, names its id with --take', async () => {
      await parked();
      const piped = brewOf('12-1', 'no-terminal');
      assert.equal(await runBrew(f.setup, shell(), piped), 3, f.lines.join('\n'));
      assert.equal(
        f.lines.at(-1),
        'foedrum brew: stdin is not a terminal, and claude needs one: run foedrum brew 12-1 --take in a terminal',
      );
    });

    it('when its session asks, names its id to answer, and no brew that would refuse it or reach another', async () => {
      await parked();
      const asks = shell(behave.needInput());
      assert.equal(await runBrew(f.setup, asks, brewOf('12-1')), 4, f.lines.join('\n'));
      assert.equal(
        f.lines.at(-1),
        'foedrum brew: answer them in order with foedrum answer 12-1 <answer 1>, then foedrum brew 12-1 --take drives it',
      );
    });

    it('once a session closes without its out doc, names its id with --take', async () => {
      await parked();
      assert.equal(await runBrew(f.setup, shell(behave.fail(true)), brewOf('12-1')), 3);
      assert.equal(
        f.lines.at(-1),
        'foedrum brew: run foedrum brew 12-1 --take again to reopen the session',
      );
    });
  });

  describe('its driver', () => {
    const serveHolds = () =>
      f.store.withTransaction((tx) =>
        tx.putBatchLease({
          batchId: '12-1',
          owner: 'serve',
          expiresAt: new Date(t0.getTime() + 60_000),
        }),
      );

    it('takes it from the driver that parked it, and opens its session', async () => {
      await parked();
      serveHolds();
      // Closed without its out doc: effects wait out the lease it took over (ADR 0124).
      const closes = shell(behave.fail(true));
      assert.equal(await runBrew(f.setup, closes, brewOf('12-1')), 3, f.lines.join('\n'));
      assert.ok(f.lines.includes('foedrum brew: took batch 12-1 over from serve'), String(f.lines));
      assert.ok(startedIn('12-1').includes('refine#3'), f.lines.join('\n'));
      assert.deepStrictEqual(startedIn('12-2'), []);
    });

    it('offers no command by the number when another driver takes it during the run', async () => {
      await parked();
      let taken = false;
      const taking = f.shell(behave.hang(idle), {
        lock: () => fakeLock('ann'),
        wait: async () => {
          if (taken) assert.fail(`brew did not stop:\n${f.lines.join('\n')}`);
          taken = true;
          serveHolds();
        },
      });
      assert.equal(await runBrew(f.setup, taking, brewOf('12-1')), 5, f.lines.join('\n'));
      assert.match(f.lines.at(-1) ?? '', /driven by serve until .*; foedrum status shows it$/);
      assert.ok(!offered(f.lines).includes('brew 12'), f.lines.join('\n'));
    });

    it('foedrum takeover, with no driver to take it from, names the command that opens it', async () => {
      await parked();
      const decision = takeOver(f.log(), {
        batchId: '12-1',
        owner: 'bob',
        ...issued,
        now: t0,
        leaseMs: 60_000,
      });
      assert.deepStrictEqual(
        decision.kind === 'refused' ? decision.reason : decision,
        'no driver holds batch 12-1; foedrum brew 12-1 --take opens its session',
      );
    });

    it('foedrum takeover offers it no command once it is Stuck on anything else: regression test', async () => {
      await parked();
      const log = f.log();
      assert.equal(log.issue({ kind: 'retry', batchId: '12-1', ...issued }, t0).kind, 'accepted');
      const expire = { kind: 'expire', batchId: '12-1', stepId: 'refine', attempt: 3 } as const;
      const later = new Date(t0.getTime() + 3_600_000);
      assert.equal(log.issue(expire, later).kind, 'accepted');
      const lane = log.state().batches.get('12-1')?.lane;
      assert.equal(lane?.kind === 'stuck' && lane.reason.kind, 'deadline_passed');
      const decision = takeOver(log, {
        batchId: '12-1',
        owner: 'bob',
        ...issued,
        now: later,
        leaseMs: 60_000,
      });
      assert.deepStrictEqual(
        decision.kind === 'refused' ? decision.reason : decision,
        'no driver holds batch 12-1',
      );
    });
  });

  describe('a batch nothing drives', () => {
    const later = new Date(t0.getTime() + 3_600_000);
    const onceLater = (behaviour: Behaviour) =>
      f.shell(behaviour, { lock: () => fakeLock('ann'), clock: () => later });

    /** foedrum dies with the session of 12-1 open: Brewing, its attempt's lease left to lapse. */
    const died = async (): Promise<void> => {
      await parked();
      const stop = new AbortController();
      let ticks = 0;
      const dying = f.shell(behave.lost(), {
        lock: () => fakeLock('ann'),
        signal: stop.signal,
        wait: async () => {
          ticks++;
          if (ticks > 1) stop.abort();
        },
      });
      assert.equal(await runBrew(f.setup, dying, brewOf('12-1')), 1, f.lines.join('\n'));
      assert.equal(foldedBatch(f.log().state(), '12-1').lane.kind, 'brewing');
      f.lines.length = 0;
    };

    it('takes a batch whose foedrum died once its lease lapsed, records the loss, and the next brew opens it', async () => {
      await died();
      const noted = await runBrew(f.setup, onceLater(behave.succeed()), brewOf('12-1'));
      assert.equal(noted, 3, f.lines.join('\n'));
      const { lane } = foldedBatch(f.log().state(), '12-1');
      assert.equal(lane.kind === 'stuck' && lane.reason.kind, 'waiting_for_session');
      assert.equal(
        f.lines.at(-1),
        'foedrum brew: run foedrum brew 12-1 --take again to reopen the session',
      );
      const again = await runBrew(f.setup, onceLater(behave.succeed('Refined')), brewOf('12-1'));
      assert.equal(again, 0, f.lines.join('\n'));
      assert.ok(startedIn('12-1').includes('refine#4'), String(startedIn('12-1')));
      assert.deepStrictEqual(startedIn('12-2'), []);
    });

    it('refuses while an attempt lease is held, saying until when, and takes nothing over', async () => {
      await died();
      // A session open in another terminal, under an owner of its own.
      const key = attemptKey.encode({ batchId: '12-1', stepId: 'refine', attempt: 3 });
      const expiresAt = new Date(t0.getTime() + 300_000);
      f.store.withTransaction((tx) =>
        tx.putLease({ attemptKey: key, owner: 'other-terminal', expiresAt }),
      );
      assert.equal(await runBrew(f.setup, shell(), brewOf('12-1')), 5, f.lines.join('\n'));
      assert.equal(
        f.lines.at(-1),
        `foedrum brew: refine#3 of batch 12-1 is held by other-terminal until ${expiresAt.toISOString()}; foedrum brew 12-1 --take takes it once that lease ends`,
      );
      assert.ok(!startedIn('12-1').includes('refine#4'), String(startedIn('12-1')));
    });

    it('refuses a batch another driver holds, taking nothing over, though --take is given', async () => {
      await died();
      const expiresAt = new Date(later.getTime() + 60_000);
      f.store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: '12-1', owner: 'serve', expiresAt }),
      );
      const refused = await runBrew(f.setup, onceLater(behave.succeed()), brewOf('12-1'));
      assert.equal(refused, 5, f.lines.join('\n'));
      assert.equal(
        f.lines.at(-1),
        `foedrum brew: batch 12-1 is driven by serve until ${expiresAt.toISOString()}, when its lease ends by itself; foedrum status shows it`,
      );
      const held = f.store.batchLeases(later).find(({ batchId }) => batchId === '12-1');
      assert.equal(held?.owner, 'serve');
      assert.ok(!f.lines.some((line) => line.includes('took batch')), f.lines.join('\n'));
    });

    it('takes a batch once the lease of the driver that held it lapsed', async () => {
      await died();
      f.store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: '12-1', owner: 'serve', expiresAt: later }),
      );
      assert.equal(await runBrew(f.setup, onceLater(behave.succeed()), brewOf('12-1')), 3);
      const { lane } = foldedBatch(f.log().state(), '12-1');
      assert.equal(lane.kind === 'stuck' && lane.reason.kind, 'waiting_for_session');
    });

    it('goes on with one whose session asked, once answered', async () => {
      await parked();
      assert.equal(await runBrew(f.setup, shell(behave.needInput()), brewOf('12-1')), 4);
      const answers = [{ q: question.q, answer: 'sqlite' }];
      const answer = { kind: 'answer', batchId: '12-1', ...issued, answers } as const;
      const decision = f.log().issue(answer, t0);
      assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
      assert.equal(foldedBatch(f.log().state(), '12-1').lane.kind, 'brewing');
      assert.equal(await runBrew(f.setup, shell(), brewOf('12-1')), 0, f.lines.join('\n'));
      assert.equal(foldedBatch(f.log().state(), '12-1').lane.kind, 'on_tap');
      assert.deepStrictEqual(startedIn('12-2'), []);
    });

    it('refuses the id of a latest batch that brews, naming its number: regression test', async () => {
      assert.equal(await runBrew(f.setup, shell(), request), 0, f.lines.join('\n'));
      const log = f.log();
      const onTap = foldedBatch(log.state(), '12-1');
      const [pullRequest] = onTap.lane.kind === 'on_tap' ? onTap.lane.pullRequests : [];
      assert.ok(pullRequest !== undefined);
      const finished = {
        type: 'pull_request.checks_finished' as const,
        batchId: '12-1',
        pullRequest,
        head: FAKE_COMMIT,
        checks: [failedCheck],
      };
      assert.equal(log.issue({ kind: 'record', event: finished }, t0).kind, 'accepted');
      const cause = { kind: 'checks' } as const;
      const fix = {
        kind: 'fix_pull_request',
        batchId: '12-1',
        pullRequest,
        head: FAKE_COMMIT,
        cause,
      };
      assert.equal(log.issue({ ...fix, kind: 'fix_pull_request' }, t0).kind, 'accepted');
      assert.equal(foldedBatch(log.state(), '12-1').lane.kind, 'brewing');
      assert.equal(await runBrew(f.setup, shell(), brewOf('12-1')), 5, f.lines.join('\n'));
      assert.match(f.lines.at(-1) ?? '', /; foedrum brew 12 brews it$/);
    });
  });

  describe('a batch id on foedrum brew', () => {
    it('is taken only with --take or --new-window, and refused alone with the word to add', () => {
      for (const flag of [{ take: true }, { 'new-window': true }]) {
        const parsed = BrewCommand.safeParse({ command: 'brew', issue: '12-1', ...flag });
        assert.ok(parsed.success, JSON.stringify(flag));
        assert.equal(parsed.data.issue, '12-1');
      }
      const alone = BrewCommand.safeParse({ command: 'brew', issue: '12-1' });
      assert.match(alone.error?.issues[0]?.message ?? 'parsed', /--take/);
    });

    it('asks runBrew for that batch, taking it over', () => {
      const parsed = BrewCommand.safeParse({ command: 'brew', issue: '12-1', take: true });
      assert.ok(parsed.success, parsed.error?.message);
      const found = { batchId: '12-1', target: { issue: 12 } };
      assert.deepStrictEqual(brewRequestOf(parsed.data, 'ann', issued, undefined, found), {
        target: { issue: 12 },
        owner: 'ann',
        ...issued,
        take: true,
        batch: '12-1',
      });
    });

    it('opens the session of a latest batch that waits for one, whose lines then say its number', async () => {
      const piped = { ...request, noSessions: 'no-terminal' } as const;
      assert.equal(await runBrew(f.setup, shell(), piped), 3, f.lines.join('\n'));
      const closed = await runBrew(f.setup, shell(behave.fail(true)), brewOf('12-1'));
      assert.equal(closed, 3, f.lines.join('\n'));
      assert.deepStrictEqual(startedIn('12-1'), ['refine#2']);
      assert.equal(f.lines.at(-1), 'foedrum brew: run foedrum brew 12 again to reopen the session');
    });

    it('refuses a latest batch that waits for no session, naming its number', async () => {
      await parked();
      assert.equal(await runBrew(f.setup, shell(), brewOf('12-2')), 5, f.lines.join('\n'));
      assert.equal(
        f.lines.at(-1),
        'foedrum brew: batch 12-2 waits for no session, and foedrum brew takes an id only for one that does or one nothing drives; foedrum brew 12 brews it',
      );
    });

    it('takes nothing over from the driver that holds a batch it refuses: regression test', async () => {
      await parked();
      const expiresAt = new Date(t0.getTime() + 60_000);
      f.store.withTransaction((tx) =>
        tx.putBatchLease({ batchId: '12-2', owner: 'serve', expiresAt }),
      );
      assert.equal(await runBrew(f.setup, shell(), brewOf('12-2')), 5, f.lines.join('\n'));
      const held = f.store.batchLeases(t0).find(({ batchId }) => batchId === '12-2');
      assert.equal(held?.owner, 'serve');
      assert.ok(!f.lines.some((line) => line.includes('took batch')), f.lines.join('\n'));
      assert.match(f.lines.at(-1) ?? '', /waits for no session/);
    });

    it('refuses an older batch on tap, offering no command that reaches a later one', async () => {
      assert.equal(await runBrew(f.setup, shell(), request), 0, f.lines.join('\n'));
      const order = { kind: 'order', batchId: '12-2', order: { issue: 12 }, ...issued } as const;
      assert.equal(f.log().issue(order, t0).kind, 'accepted');
      f.lines.length = 0;
      assert.equal(await runBrew(f.setup, shell(), brewOf('12-1')), 5, f.lines.join('\n'));
      assert.equal(
        f.lines.at(-1),
        'foedrum brew: batch 12-1 waits for no session, and foedrum brew takes an id only for one that does or one nothing drives; its pull requests end it, and foedrum serve reads them',
      );
    });

    it('refuses an older batch Stuck on anything else, naming foedrum stuck', async () => {
      await parked();
      const log = f.log();
      assert.equal(log.issue({ kind: 'retry', batchId: '12-1', ...issued }, t0).kind, 'accepted');
      const expire = { kind: 'expire', batchId: '12-1', stepId: 'refine', attempt: 3 } as const;
      const decision = log.issue(expire, new Date(t0.getTime() + 3_600_000));
      assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
      f.lines.length = 0;
      assert.equal(await runBrew(f.setup, shell(), brewOf('12-1')), 5, f.lines.join('\n'));
      assert.match(f.lines.at(-1) ?? '', /foedrum stuck lists what it offers$/);
    });

    it("opens a claimed batch's session by its number's issue, naming its id: regression test", async () => {
      const inputs = serveInputs({
        files: {
          ...serveInputs().files,
          config: config({}, { alias: 'web', intake: { labels: ['foedrum'] } }),
          local: local({ workRoot: f.dir.path }),
        },
      });
      const { brewery } = inputs.files;
      const result = serveSetup({
        ...inputs,
        files: {
          ...inputs.files,
          brewery: {
            ...brewery,
            recipes: [...brewery.recipes, { path: 'recipes/lauter.jsonc', text: RECIPE }],
            brewers: [...brewery.brewers, { path: 'brewers/steward.md', text: STEWARD }],
          },
        },
      });
      f.setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
      const log = f.log();
      const target = { issue: 7, repo: 'acme/web' };
      const accept = (command: Parameters<typeof log.issue>[0]): void => {
        const decision = log.issue(command, t0);
        assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
      };
      accept({ kind: 'order', batchId: 'web-7-1', order: target, ...issued });
      const key = effectKey.encode({ batchId: 'web-7-1', effect: 'order.issue' });
      accept({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } });
      const route = { recipe: 'lauter', reason: 'label', source: 'label' } as const;
      accept({ kind: 'route', batchId: 'web-7-1', ...route });
      accept({ kind: 'await_session', batchId: 'web-7-1', stepId: 'refine', attempt: 1 });
      f.store.withTransaction((tx) =>
        tx.append({
          type: 'batch.ordered',
          batchId: 'web-7-2',
          order: target,
          routeBy: '2026-10-22T13:00:00.000Z',
        }),
      );
      const parsed = BrewCommand.safeParse({ command: 'brew', issue: 'web-7-1', take: true });
      assert.ok(parsed.success, parsed.error?.message);
      const repositories = [{ alias: 'web', repo: 'acme/web' }];
      const found = batchTarget(log.state(), parsed.data.issue, repositories);
      assert.deepStrictEqual(found, { batchId: 'web-7-1', target: { issue: 40 } });
      const brew = brewRequestOf(parsed.data, 'ann', issued, undefined, found);
      assert.equal(await runBrew(f.setup, shell(behave.fail(true)), brew), 3, f.lines.join('\n'));
      assert.deepStrictEqual(startedIn('web-7-1'), ['refine#2']);
      assert.deepStrictEqual(startedIn('web-7-2'), []);
      assert.equal(
        f.lines.at(-1),
        'foedrum brew: run foedrum brew web-7-1 --take again to reopen the session',
      );
    });

    it('refuses a batch that is not there, ordering nothing', async () => {
      const ghost: BrewRequest = { ...request, take: true, batch: '12-9' };
      assert.equal(await runBrew(f.setup, shell(), ghost), 5, f.lines.join('\n'));
      assert.equal(f.lines.at(-1), 'foedrum brew: there is no batch 12-9');
      assert.equal(f.log().state().batches.size, 0);
    });
  });
});
