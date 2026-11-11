// One number per piece of work (ADR 0329): every command on a claimed order takes its Brewery issue's
// number, through runCli with an in-memory event store. Its target issue's `<alias>#<n>` is refused
// once that issue is alive, read from the fold alone; a batch id still works.

import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type CliContext, type CliResult, runCli } from '../../src/cli/run.ts';
import { calledAs } from '../../src/engine/claim-orders.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { foldedBatch } from '../../src/engine/fold.ts';
import { pauseOf } from '../../src/engine/pauses.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { BreweryConfig } from '../../src/schemas/brewery-config.ts';
import type { Event } from '../../src/schemas/events.ts';
import { linux } from '../helpers/doctor-facts.ts';
import { fakeGitHub } from '../helpers/fake-github.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const cwd = join(sep, 'work', 'brewery');
const t0 = new Date('2026-10-15T12:00:00.000Z');
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const WEB = 'acme/web';
const recipes = fakeRecipes({
  pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 1 }),
  // talk is a person's session (ADR 0222).
  sip: fakeRecipe({ steps: ['talk'], interactive: ['talk'] }),
  // One plan step and no pull request: its plan waits for review (ADR 0275).
  mash: fakeRecipe({ steps: ['plan'], pullRequests: [] }),
});
const plan = {
  status: 'done',
  summary: 'Planned',
  assumptions: [],
  subOrders: [
    {
      id: 'one',
      title: 'One',
      repo: 'acme/api',
      size: { lines: 10, mechanism: 'a flag' },
      doneWhen: 'a test passes',
      touches: [{ path: 'src' }],
      recipe: 'pint',
      why: 'small',
      ready: true,
    },
  ],
};
const checks = { build: null, typecheck: null, lint: null, format: null, test: null };
const config = BreweryConfig.parse({
  brewery: 'acme/brewery',
  repositories: {
    [WEB]: { checks, alias: 'web', intake: { labels: ['foedrum'] } },
  },
});

describe('one number per piece of work (ADR 0329)', () => {
  let store: EventStore;
  const log = () => createCommandLog({ store, recipes });
  const issue = (command: Parameters<ReturnType<typeof log>['issue']>[0]) =>
    assert.equal(log().issue(command, t0).kind, 'accepted', JSON.stringify(command));
  const record = (batchId: string, effect: string, result: number | string) =>
    issue({
      kind: 'record',
      event: { type: 'effect.applied', key: effectKey.encode({ batchId, effect }), result },
    });

  /** A claimed batch of web#`number`, its Brewery issue `order`, its plan step started. */
  const claimed = (batchId: string, number: number, order: number, recipe = 'pint') => {
    issue({ kind: 'order', batchId, order: { issue: number, repo: WEB } });
    record(batchId, 'order.issue', order);
    issue({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
    issue({
      kind: 'record',
      event: { type: 'step.started', batchId, stepId: 'plan', attempt: 1 },
    });
  };
  const failed = { kind: 'failed', retryable: true, reason: 'tests fail' } as const;
  const plan1 = { stepId: 'plan', attempt: 1 } as const;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    // web-7, Brewery issue #40, used up its attempts at plan; web-8, #41, asks one question;
    // web-9, #42, waits with a plan; web-10, #43, brews.
    claimed('web-7', 7, 40);
    issue({ kind: 'finish', batchId: 'web-7', ...plan1, ending: failed });
    claimed('web-8', 8, 41);
    const question = {
      q: 'Which database?',
      options: ['sqlite', 'redis'],
      recommended: 'sqlite',
      whyBlocking: 'They differ',
    };
    issue({
      kind: 'finish',
      batchId: 'web-8',
      ...plan1,
      ending: { kind: 'needs_input', questions: [question] },
    });
    claimed('web-9', 9, 42, 'mash');
    issue({
      kind: 'finish',
      batchId: 'web-9',
      ...plan1,
      ending: { kind: 'succeeded', output: plan },
    });
    claimed('web-10', 10, 43);
  });
  afterEach(() => store.close());

  const kept = (): EventStore => ({ ...store, close: () => {} });
  const context = (overrides: Partial<CliContext> = {}): CliContext => ({
    cwd,
    gatherDoctorFacts: async () => linux(),
    openStore: () => kept(),
    openWritableStore: () => kept(),
    recipes: () => recipes,
    brewers: () => ({ brewers: [], step: () => undefined }),
    lenses: () => ({ lenses: [], step: () => undefined }),
    user: () => 'ada',
    surface: 'terminal',
    now: () => t0,
    zone: () => 'Europe/Brussels',
    readKeptBranches: async () => assert.fail('no kept branch to read'),
    config: () => config,
    claims: () => assert.fail('no claim host to reach'),
    queue: () => assert.fail('no queue to read'),
    serve: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    brew: async () => assert.fail('no brew here'),
    watch: async () => assert.fail('no watch here'),
    resume: async () => assert.fail('no session to resume'),
    applyEffects: async () => [],
    init: async () => assert.fail('no init here'),
    version: () => assert.fail('no version here'),
    env: {},
    ...overrides,
  });
  const run = (argv: string[], overrides: Partial<CliContext> = {}): Promise<CliResult> =>
    runCli(argv, context(overrides));
  const accepted = async (argv: string[]): Promise<void> => {
    const result = await run(argv);
    assert.equal(result.exitCode, 0, result.stderr);
  };
  const laneOf = (batchId: string) => log().state().batches.get(batchId)?.lane.kind;
  const events = (): Event[] => store.eventsAfter(0).map(({ event }) => event);

  it("foedrum retry takes a Brewery issue's number and acts on its latest batch", async () => {
    await accepted(['retry', '40']);
    assert.equal(laneOf('web-7'), 'brewing');
  });

  it("foedrum answer takes a Brewery issue's number and answers its latest batch", async () => {
    await accepted(['answer', '41', 'sqlite']);
    assert.equal(laneOf('web-8'), 'brewing');
  });

  it("foedrum approve takes a Brewery issue's number and signs off its latest batch's plan", async () => {
    await accepted(['approve', '42']);
    assert.equal(laneOf('web-9'), 'on_tap');
  });

  it("foedrum cancel takes a Brewery issue's number and cancels its latest batch", async () => {
    await accepted(['cancel', '43']);
    assert.equal(laneOf('web-10'), 'cancelled');
  });

  it("foedrum skip takes a Brewery issue's number and goes on with its latest batch", async () => {
    await accepted(['skip', '40']);
    assert.equal(laneOf('web-7'), 'brewing');
    assert.ok(
      events().some((event) => event.type === 'batch.resumed' && event.batchId === 'web-7'),
    );
  });

  it("foedrum rewind takes a Brewery issue's number and rewinds its latest batch", async () => {
    await accepted(['rewind', '40', 'plan', `${WEB}=${SHA}`]);
    assert.ok(
      events().some((event) => event.type === 'batch.rewound' && event.batchId === 'web-7'),
    );
  });

  it("foedrum replay takes a Brewery issue's number and shows its latest batch", async () => {
    const result = await run(['replay', '40']);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /web-7/);
    assert.doesNotMatch(result.stdout, /web-8/);
  });

  it("foedrum resume takes a Brewery issue's number and opens its latest batch's session", async () => {
    const opened: unknown[] = [];
    const resume: CliContext['resume'] = async (input) => {
      opened.push(input);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    assert.equal((await run(['resume', '40', 'plan#1'], { resume })).exitCode, 0);
    assert.deepStrictEqual(opened, [{ batch: 'web-7', step: 'plan#1' }]);
  });

  it("foedrum takeover takes a Brewery issue's number and hands over its latest batch", async () => {
    const expiresAt = new Date(t0.getTime() + 60_000);
    store.withTransaction((tx) =>
      tx.putBatchLease({ batchId: 'web-7', owner: 'cellar', expiresAt }),
    );
    await accepted(['takeover', '40', '--as', 'ann']);
    const leases = store.batchLeases(t0).map(({ batchId, owner }) => [batchId, owner]);
    assert.deepStrictEqual(leases, [['web-7', 'ann']]);
  });

  it('a number with two batches means the later one', async () => {
    issue({ kind: 'cancel', batchId: 'web-7', by: 'ada', via: 'terminal' });
    for (const effect of ['release.label', 'release.comment', 'release.ref']) {
      record('web-7', effect, 'done');
    }
    issue({
      kind: 'order_again',
      batchId: 'web-7-2',
      order: { issue: 7, repo: WEB },
      by: 'a',
      via: 'terminal',
    });
    issue({ kind: 'route', batchId: 'web-7-2', recipe: 'pint', reason: 'label', source: 'label' });
    await accepted(['cancel', '40']);
    assert.equal(laneOf('web-7-2'), 'cancelled');
    const cancels = events().flatMap((event) =>
      event.type === 'batch.cancelled' ? [event.batchId] : [],
    );
    assert.deepStrictEqual(cancels, ['web-7', 'web-7-2']);
  });

  /** web-7 cancelled and ordered again as web-7-2, whose order is still #40. */
  const orderedAgain = () => {
    issue({ kind: 'cancel', batchId: 'web-7', by: 'ada', via: 'terminal' });
    for (const effect of ['release.label', 'release.comment', 'release.ref']) {
      record('web-7', effect, 'done');
    }
    issue({
      kind: 'order_again',
      batchId: 'web-7-2',
      order: { issue: 7, repo: WEB },
      by: 'a',
      via: 'terminal',
    });
  };
  const called = (batchId: string): string => {
    const state = log().state();
    return calledAs(state, foldedBatch(state, batchId));
  };

  it("the latest batch's line names the number", () => {
    orderedAgain();
    assert.equal(called('web-7-2'), '40');
  });

  it("an older batch's line names its id, since the number means the latest", () => {
    orderedAgain();
    assert.equal(called('web-7'), 'web-7');
  });

  it('foedrum takeover of an older batch names its id and offers no brew, which takes none', async () => {
    orderedAgain();
    const result = await run(['takeover', 'web-7', '--as', 'ann']);
    assert.equal(result.stderr, 'foedrum takeover: no driver holds batch web-7\n');
  });

  it("foedrum stuck offers an older batch's options by its id", async () => {
    // A batch on tap can come back Stuck past a later batch of its issue (ADR 0334).
    store.withTransaction((tx) =>
      tx.append({
        type: 'batch.ordered',
        batchId: 'web-8-2',
        order: { issue: 8, repo: WEB },
        routeBy: t0.toISOString(),
      }),
    );
    const { stdout } = await run(['stuck']);
    const next = stdout
      .split('\n')
      .filter((line) => line.includes('Next:') && line.includes('web-8'));
    assert.deepStrictEqual(next, [
      '  Next: answer the questions above with foedrum answer web-8 <answer 1>, try the step again with foedrum retry web-8, go past the step with foedrum skip web-8, brew the issue with another recipe with foedrum recipe web-8 <recipe> <reason>, take it back to an earlier step with foedrum rewind web-8 <step>, or end it with foedrum cancel web-8.',
    ]);
  });

  it("a command's line on a claimed order leads with the number", async () => {
    const result = await run(['retry', '40']);
    assert.equal(result.stdout, '#40 is running: step plan (try 2) is about to start\n');
  });

  it("foedrum stuck's next step on a claimed order's plan uses the number", async () => {
    const { stdout } = await run(['stuck']);
    assert.ok(
      stdout.includes(
        'sign it off with foedrum approve 42, correct it with the Brewmaster in a session with foedrum lauter 42, plan it again with foedrum retry 42, brew the issue with another recipe with foedrum recipe 42 <recipe> <reason>, or end it with foedrum cancel 42.',
      ),
      stdout,
    );
  });

  it('a wrong count of answers on a claimed order names the number', async () => {
    const result = await run(['answer', '41', 'sqlite', 'more']);
    assert.equal(
      result.stderr,
      'foedrum answer: #41 asked 1 question; give one answer to each, in order\n',
    );
  });

  it('foedrum takeover of a claimed batch no driver holds offers its number', async () => {
    const result = await run(['takeover', '40', '--as', 'ann']);
    assert.equal(
      result.stderr,
      'foedrum takeover: no driver holds #40; foedrum brew 40 drives it\n',
    );
  });

  it('foedrum continue of a claimed order that is not paused names the number', async () => {
    const result = await run(['continue', '43']);
    assert.equal(result.stderr, 'foedrum continue: #43 is not paused\n');
  });

  it('foedrum stop of a claimed order with nothing brewing names the number', async () => {
    const result = await run(['stop', '41']);
    assert.equal(result.stderr, 'foedrum stop: there is no brewing batch of #41 to stop\n');
  });

  it('foedrum pause of a claimed order that ended names the number', async () => {
    issue({ kind: 'cancel', batchId: 'web-7', by: 'ada', via: 'terminal' });
    const result = await run(['pause', '40']);
    assert.equal(
      result.stderr,
      'foedrum pause: there is no batch of #40 that has not ended to pause\n',
    );
  });

  it("foedrum pause of a claimed order's number holds its batches", async () => {
    await accepted(['pause', '43']);
    const state = log().state();
    const batch = state.batches.get('web-10');
    assert.ok(batch !== undefined && pauseOf(state, batch) !== undefined);
    const paused = events().at(-1);
    assert.equal(paused?.type, 'order.paused');
    assert.deepStrictEqual(paused?.type === 'order.paused' && paused.order, {
      issue: 10,
      repo: WEB,
    });
  });

  it("foedrum continue of a claimed order's number lifts a pause recorded by its target issue", async () => {
    issue({ kind: 'pause', order: { issue: 10, repo: WEB }, by: 'ada', via: 'terminal' });
    const state = log().state();
    const batch = state.batches.get('web-10');
    assert.ok(batch !== undefined && pauseOf(state, batch) !== undefined);
    await accepted(['continue', '43']);
    const after = log().state();
    const lifted = after.batches.get('web-10');
    assert.ok(lifted !== undefined);
    assert.equal(pauseOf(after, lifted), undefined);
  });

  it("foedrum stop of a claimed order's number makes its brewing batch Stuck", async () => {
    await accepted(['stop', '43']);
    assert.equal(laneOf('web-10'), 'stuck');
  });

  it("foedrum rank of a claimed order's number is refused by that number", async () => {
    const result = await run(['rank', '#43']);
    assert.equal(
      result.stderr,
      'foedrum rank: #43 is already ordered: a rank orders only the queue\n',
    );
  });

  describe('a target issue whose Brewery issue is alive', () => {
    const refusals: Record<string, string[]> = {
      retry: ['retry', 'web#7'],
      answer: ['answer', 'web#8', 'sqlite'],
      approve: ['approve', 'web#9'],
      cancel: ['cancel', 'web#10'],
      skip: ['skip', 'web#7'],
      rewind: ['rewind', 'web#7', 'plan', `${WEB}=${SHA}`],
      replay: ['replay', 'web#7'],
      resume: ['resume', 'web#7'],
      takeover: ['takeover', 'web#7', '--as', 'ann'],
      pause: ['pause', 'web#10'],
      continue: ['continue', 'web#10'],
      stop: ['stop', 'web#10'],
      status: ['status', 'web#7'],
      order: ['order', 'web#7'],
      recipe: ['recipe', 'web#7', 'pint', 'why not'],
    };
    const numbers: Record<string, number> = { 'web#7': 40, 'web#8': 41, 'web#9': 42, 'web#10': 43 };

    for (const [command, argv] of Object.entries(refusals)) {
      it(`foedrum ${command} refuses it and names the number`, async () => {
        const before = store.lastEventId();
        const named = argv[1] ?? '';
        const result = await run(argv);
        assert.equal(result.exitCode, 1, result.stdout);
        assert.match(
          result.stderr,
          new RegExp(
            `^foedrum ${command}: ${named} is Brewery issue #${numbers[named]}; foedrum ${command} ${numbers[named]}\\n$`,
          ),
        );
        assert.equal(store.lastEventId(), before);
      });
    }

    it('a batch whose Brewery issue is not open yet still goes by its target issue', async () => {
      issue({ kind: 'order', batchId: 'web-11', order: { issue: 11, repo: WEB } });
      await accepted(['cancel', 'web#11']);
      assert.equal(laneOf('web-11'), 'cancelled');
    });

    it('a Brewery issue a person deleted leaves the target issue to claim again by its name', async () => {
      const { host } = fakeGitHub();
      issue({ kind: 'cancel', batchId: 'web-7', by: 'ada', via: 'terminal' });
      for (const effect of ['release.label', 'release.comment', 'release.ref']) {
        record('web-7', effect, 'done');
      }
      record('web-7', 'release.order', 'gone');
      const result = await run(['order', 'web#7'], { claims: () => host });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.ok(log().state().batches.has('web-7-2'));
    });

    it('an unknown alias is refused with the line it always had', async () => {
      const result = await run(['retry', 'docs#7']);
      assert.equal(
        result.stderr,
        'foedrum retry: foedrum.jsonc names no repository with the alias docs\n',
      );
    });
  });

  it('a number with no batch says so and appends nothing', async () => {
    const before = store.lastEventId();
    const result = await run(['retry', '99']);
    assert.deepStrictEqual(result, {
      exitCode: 1,
      stdout: '',
      stderr: 'foedrum retry: #99 has no batch\n',
    });
    assert.equal(store.lastEventId(), before);
  });

  it("foedrum recipe of a brewing claimed order's number names the number to stop", async () => {
    const result = await run(['recipe', '43', 'pint', 'why not']);
    assert.equal(
      result.stderr,
      'foedrum recipe: #43 is brewing; foedrum stop 43 first, then change its recipe\n',
    );
  });

  describe('a claimed batch waiting for its session: regression tests', () => {
    /** Batch `batchId` of web#`number`, parked for a person's session. */
    const parked = (batchId: string, number: number) => {
      issue({ kind: 'order', batchId, order: { issue: number, repo: WEB } });
      issue({ kind: 'route', batchId, recipe: 'sip', reason: 'label', source: 'label' });
      issue({ kind: 'await_session', batchId, stepId: 'talk', attempt: 1 });
    };

    it('foedrum status names its number once its Brewery issue is open', async () => {
      parked('web-20', 20);
      record('web-20', 'order.issue', 50);
      assert.match((await run(['status'])).stdout, /foedrum brew 50 --take opens it/);
    });

    it('foedrum stuck names its number once its Brewery issue is open', async () => {
      parked('web-20', 20);
      record('web-20', 'order.issue', 50);
      assert.match((await run(['stuck'])).stdout, /foedrum brew 50 --take opens it/);
    });

    it('foedrum replay names its number once its Brewery issue is open', async () => {
      parked('web-20', 20);
      record('web-20', 'order.issue', 50);
      assert.match((await run(['replay', '50'])).stdout, /foedrum brew 50 --take opens it/);
    });

    it('foedrum status names its target issue until its Brewery issue is open', async () => {
      parked('web-20', 20);
      assert.match((await run(['status'])).stdout, /foedrum brew web#20 --take opens it/);
    });
  });

  describe('a target issue ordered again: regression tests', () => {
    const orderedAgain = () => {
      issue({ kind: 'cancel', batchId: 'web-7', by: 'ada', via: 'terminal' });
      for (const effect of ['release.label', 'release.comment', 'release.ref']) {
        record('web-7', effect, 'done');
      }
      const order = { issue: 7, repo: WEB };
      issue({ kind: 'order_again', batchId: 'web-7-2', order, by: 'a', via: 'terminal' });
    };

    it('is refused by its target issue while the Brewery issue an earlier batch opened is alive', async () => {
      orderedAgain();
      assert.equal(
        (await run(['cancel', 'web#7'])).stderr,
        'foedrum cancel: web#7 is Brewery issue #40; foedrum cancel 40\n',
      );
    });

    it('goes by its target issue once its reopen found that Brewery issue gone', async () => {
      orderedAgain();
      record('web-7-2', 'order.reopen', 'gone');
      await accepted(['cancel', 'web#7']);
      assert.equal(laneOf('web-7-2'), 'cancelled');
    });
  });

  it("foedrum order of a number claims by the repository's alias now, after the alias was renamed", async () => {
    const { host } = fakeGitHub();
    issue({ kind: 'cancel', batchId: 'web-7', by: 'ada', via: 'terminal' });
    for (const effect of ['release.label', 'release.comment', 'release.ref']) {
      record('web-7', effect, 'done');
    }
    const renamed = BreweryConfig.parse({
      brewery: 'acme/brewery',
      repositories: {
        [WEB]: { checks, alias: 'site', intake: { labels: ['foedrum'] } },
      },
    });
    const result = await run(['order', '40'], { config: () => renamed, claims: () => host });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(log().state().batches.has('site-7'));
  });

  it('a batch id still works: regression test', async () => {
    await accepted(['retry', 'web-7']);
    assert.equal(laneOf('web-7'), 'brewing');
  });

  it("a Brewery issue's own batch goes by its number too", async () => {
    issue({ kind: 'order', batchId: '30-1', order: { issue: 30 } });
    await accepted(['cancel', '#30']);
    assert.equal(laneOf('30-1'), 'cancelled');
  });
});
