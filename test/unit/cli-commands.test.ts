// The commands that change state, and `stuck`, through runCli with an in-memory event store
// (ADR 0019, ADR 0025, ADR 0030): each parses its untrusted input with its schema, appends through
// the command log with who issued it and from where, and refuses what decide refuses.

import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { BrewerSource } from '../../src/cli/brewer-report.ts';
import { commands } from '../../src/cli/commands.ts';
import { type CliContext, type CliResult, runCli } from '../../src/cli/run.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { invalidRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { BreweryConfig } from '../../src/schemas/brewery-config.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { Question } from '../../src/schemas/step-outcome.ts';
import { linux } from '../helpers/doctor-facts.ts';
import { type FakeGitHub, fakeGitHub } from '../helpers/fake-github.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const cwd = join(sep, 'work', 'brewery');
const storePath = join(cwd, '.foedrum', 'index.db');
const t0 = new Date('2026-10-15T12:00:00.000Z');
const iso = (minutes: number): string => new Date(t0.getTime() + minutes * 60_000).toISOString();
const SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const recipes = fakeRecipes({
  pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 1 }),
  stout: fakeRecipe({ steps: ['analyze', 'plan', 'implement'] }),
});
const questions: Question[] = [
  {
    q: 'Which database should the cache use?',
    options: ['sqlite', 'redis'],
    recommended: 'sqlite',
    whyBlocking: 'The two need different migrations',
  },
  {
    q: 'Keep the old endpoint?',
    options: ['yes', 'no'],
    recommended: 'yes',
    whyBlocking: 'Clients may still call it',
  },
];

describe('foedrum: commands that change state', () => {
  let store: EventStore;
  let opened: { readOnly: string[]; writable: string[] };

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    opened = { readOnly: [], writable: [] };
    const log = createCommandLog({ store, recipes });
    const issue = (command: Parameters<typeof log.issue>[0]) =>
      assert.equal(log.issue(command, t0).kind, 'accepted', JSON.stringify(command));
    // 21-1 asks two questions at plan; 22-1, 24-1, 25-1 and 26-1 used up their attempts at plan;
    // 23-1 brews.
    // The Cellar drives 22-1 (ADR 0124).
    store.withTransaction((tx) =>
      tx.putBatchLease({ batchId: '22-1', owner: 'cellar', expiresAt: new Date(iso(3)) }),
    );
    for (const issueNumber of [21, 22, 23, 24, 25, 26]) {
      const batchId = `${issueNumber}-1`;
      issue({ kind: 'order', batchId, order: { issue: issueNumber } });
      issue({ kind: 'route', batchId, recipe: 'pint', reason: 'label', source: 'label' });
      issue({
        kind: 'record',
        event: { type: 'step.started', batchId, stepId: 'plan', attempt: 1 },
      });
    }
    const plan1 = { stepId: 'plan', attempt: 1 } as const;
    issue({
      kind: 'finish',
      batchId: '21-1',
      ...plan1,
      ending: { kind: 'needs_input', questions },
    });
    const failed = { kind: 'failed', retryable: true, reason: 'tests fail' } as const;
    for (const batchId of ['22-1', '24-1', '25-1', '26-1']) {
      issue({ kind: 'finish', batchId, ...plan1, ending: failed });
    }
  });
  afterEach(() => store.close());

  // Closing is counted, not done, so the test can read the store afterwards.
  const kept = (): EventStore => ({ ...store, close: () => {} });
  const context = (overrides: Partial<CliContext> = {}): CliContext => ({
    cwd,
    gatherDoctorFacts: async () => linux(),
    openStore: (path) => {
      opened.readOnly.push(path);
      return kept();
    },
    openWritableStore: (path) => {
      opened.writable.push(path);
      return kept();
    },
    recipes: () => recipes,
    brewers: () => ({
      brewers: [{ name: 'planner', path: 'brewers/planner.md' }],
      step: () => undefined,
    }),
    user: () => 'ada',
    surface: 'terminal',
    now: () => t0,
    // 14:00 there at t0.
    zone: () => 'Europe/Brussels',
    readKeptBranches: async () => assert.fail('no kept branch to read'),
    config: () => assert.fail('no foedrum.jsonc to read'),
    claims: () => assert.fail('no claim host to reach'),
    queue: () => assert.fail('no queue to read'),
    serve: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    brew: async () => assert.fail('no brew here'),
    watch: async () => assert.fail('no watch here'),
    resume: async () => assert.fail('no session to resume'),
    init: async () => assert.fail('no init here'),
    env: {},
    ...overrides,
  });
  const run = (argv: string[], overrides: Partial<CliContext> = {}): Promise<CliResult> =>
    runCli(argv, context(overrides));
  const appended = (count: number): Event[] =>
    store
      .eventsAfter(0)
      .slice(-count)
      .map(({ event }) => event);
  const lastId = () => store.lastEventId();
  const ok = (stdout: string): CliResult => ({ exitCode: 0, stdout, stderr: '' });
  const refused = (command: string, reason: string): CliResult => ({
    exitCode: 1,
    stdout: '',
    stderr: `foedrum ${command}: ${reason}\n`,
  });

  it('opens only the read-only store for a read-only command, and appends nothing', async () => {
    const before = lastId();
    for (const argv of [['status'], ['stuck'], ['replay', '21-1'], ['doctor'], ['brewers']]) {
      assert.equal((await run(argv)).exitCode, 0, argv.join(' '));
    }
    assert.deepStrictEqual(opened.writable, []);
    assert.equal(lastId(), before);
  });

  it("never loads the Brewery's recipes for a read-only command (ADR 0053)", async () => {
    const recipes = () => {
      throw new Error('the recipes were loaded');
    };
    for (const argv of [['status'], ['stuck'], ['replay', '21-1'], ['doctor'], ['brewers']]) {
      assert.equal((await run(argv, { recipes })).exitCode, 0, argv.join(' '));
    }
  });

  it("refuses a command that needs recipes with doctor's line when they do not load, and appends nothing", async () => {
    const line = invalidRecipes(['recipes/pint.jsonc: EACCES']);
    const before = lastId();
    const recipes = () => {
      throw new Error(line);
    };
    assert.deepStrictEqual(await run(['retry', '22-1'], { recipes }), refused('retry', line));
    assert.equal(lastId(), before);
  });

  it('opens the writable store in .foedrum of the working directory for each one that does', async () => {
    // One accepted command line per command the registry says changes state.
    const lines: Record<string, string[]> = {
      retry: ['retry', '22-1'],
      skip: ['skip', '24-1'],
      answer: ['answer', '21-1', 'sqlite', 'yes'],
      recipe: ['recipe', '25-1', 'stout', 'start over'],
      rewind: ['rewind', '26-1', 'plan', `acme/app=${SHA}`],
      cancel: ['cancel', '23-1'],
      pause: ['pause', '21'],
      continue: ['continue', '21'],
      order: ['order', '#99'],
      rank: ['rank', '#98', 'first'],
      takeover: ['takeover', '22-1', '--as', 'ann'],
    };
    // rank reads the intake's queue: one labelled Brewery issue, #98 (ADR 0208).
    const queued: Partial<CliContext> = {
      config: () =>
        BreweryConfig.parse({ brewery: 'acme/brewery', users: ['ada'], repositories: {} }),
      queue: () => ({
        tracker: {
          issues: async () => [
            {
              number: 98,
              state: 'open',
              pullRequest: false,
              labels: ['recipe:pint'],
              milestone: undefined,
              assignees: [],
              author: 'ada',
              created: iso(-60),
            },
          ],
          pullRequest: async () => 'open',
        },
        login: async () => 'ada',
      }),
    };
    // brew is a driver: it opens the store through serve's wiring, as serve does (ADR 0123); so
    // is resume on a running batch (ADR 0127), and on a finished attempt it appends nothing.
    const names = commands
      .filter((command) => command.changesState && !['brew', 'resume'].includes(command.name))
      .map(({ name }) => name);
    assert.deepStrictEqual(names, Object.keys(lines));
    for (const name of names) {
      opened = { readOnly: [], writable: [] };
      const overrides = name === 'rank' ? queued : {};
      assert.equal((await run(lines[name] ?? [], overrides)).exitCode, 0, name);
      assert.deepStrictEqual(opened, { readOnly: [], writable: [storePath] }, name);
    }
  });

  it('fails without creating a store where there is none', async () => {
    assert.deepStrictEqual(
      await run(['cancel', '21-1'], { openWritableStore: () => undefined }),
      refused('cancel', `no event store at ${storePath}`),
    );
  });

  it('closes the store it opened', async () => {
    let closed = 0;
    await run(['cancel', '23-1'], {
      openWritableStore: () => ({
        ...store,
        close: () => {
          closed++;
        },
      }),
    });
    assert.equal(closed, 1);
  });

  it('closes the store it opened on every refusal too', async () => {
    // An attempt that starts without being scheduled: the fold refuses the log.
    const broken = openSqliteEventStore(':memory:');
    broken.withTransaction((tx) => {
      tx.append({ type: 'batch.ordered', batchId: '11-1', order: { issue: 11 }, routeBy: iso(60) });
      tx.append({ type: 'step.started', batchId: '11-1', stepId: 'plan', attempt: 1 });
    });
    const cases: [string[], EventStore, number][] = [
      [['retry', '23-1'], store, 1],
      [['answer', '21-1', 'sqlite'], store, 1],
      [['cancel', '11-1'], broken, 1],
    ];
    try {
      for (const [argv, target, exitCode] of cases) {
        let closed = 0;
        const result = await run(argv, {
          openWritableStore: () => ({
            ...target,
            close: () => {
              closed++;
            },
          }),
        });
        assert.equal(result.exitCode, exitCode, argv.join(' '));
        assert.equal(closed, 1, argv.join(' '));
      }
    } finally {
      broken.close();
    }
  });

  describe('retry', () => {
    it('schedules another attempt, recorded with who issued it and from where', async () => {
      assert.deepStrictEqual(await run(['retry', '22-1']), ok('22-1 brewing: plan #2 scheduled\n'));
      assert.deepStrictEqual(appended(2), [
        { type: 'batch.resumed', batchId: '22-1', by: 'ada', via: 'terminal', action: 'retry' },
        {
          type: 'step.scheduled',
          batchId: '22-1',
          stepId: 'plan',
          attempt: 2,
          deadlineAt: iso(60),
          retry: true,
        },
      ]);
    });

    it('records the surface and the user it is given', async () => {
      await run(['retry', '22-1'], { user: () => 'grace', surface: 'plugin' });
      assert.deepStrictEqual(appended(2)[0], {
        type: 'batch.resumed',
        batchId: '22-1',
        by: 'grace',
        via: 'plugin',
        action: 'retry',
      });
    });

    it('refuses what decide refuses, appending nothing', async () => {
      const before = lastId();
      assert.deepStrictEqual(
        await run(['retry', '23-1']),
        refused('retry', 'batch 23-1 is brewing; retry needs it stuck'),
      );
      assert.deepStrictEqual(
        await run(['retry', '99-1']),
        refused('retry', 'batch 99-1 was never ordered'),
      );
      assert.equal(lastId(), before);
    });
  });

  describe('skip', () => {
    it('goes on after the step the batch stopped at', async () => {
      assert.deepStrictEqual(
        await run(['skip', '22-1']),
        ok('22-1 brewing: implement #1 scheduled\n'),
      );
      assert.equal(appended(2)[0]?.type, 'batch.resumed');
    });
  });

  describe('cancel', () => {
    it('cancels a batch in any lane but the terminal ones', async () => {
      assert.deepStrictEqual(
        await run(['cancel', '23-1']),
        ok('23-1 cancelled: by ada via terminal\n'),
      );
      assert.deepStrictEqual(appended(1), [
        { type: 'batch.cancelled', batchId: '23-1', by: 'ada', via: 'terminal' },
      ]);
      assert.deepStrictEqual(
        await run(['cancel', '23-1']),
        refused(
          'cancel',
          'batch 23-1 is cancelled; cancel needs it ordered, brewing, conditioning or stuck',
        ),
      );
    });
  });

  describe('pause and continue (ADR 0202)', () => {
    const paused = (fields: Record<string, unknown> = {}): Event =>
      ({ type: 'order.paused', by: 'ada', via: 'terminal', ...fields }) as Event;

    it('pauses an order, recorded with who, from where and why', async () => {
      const result = await run(['pause', '#23', '--why', 'lunch']);
      assert.deepStrictEqual(
        result,
        ok(
          '#23 paused: nothing new of it starts, and what runs ends at its next convenient point\n',
        ),
      );
      assert.deepStrictEqual(appended(1), [paused({ order: { issue: 23 }, why: 'lunch' })]);
    });

    it('takes --by as a local time in the zone of the machine, recorded in UTC with that zone', async () => {
      const result = await run(['pause', '23', '--by', '17:30']);
      assert.deepStrictEqual(
        result,
        ok(
          '#23 paused: nothing new of it starts, and what runs ends at its next convenient point; what still runs at 15:30 UTC (17:30 Europe/Brussels, 15 October) is stopped\n',
        ),
      );
      assert.deepStrictEqual(appended(1), [
        paused({
          order: { issue: 23 },
          stopAt: '2026-10-15T15:30:00.000Z',
          zone: 'Europe/Brussels',
        }),
      ]);
    });

    it('pauses the whole Brewery and its intake with --all, and takes --by as a duration', async () => {
      const result = await run(['pause', '--all', '--by', '20m'], { surface: 'plugin' });
      assert.deepStrictEqual(
        result,
        ok(
          'The Brewery is paused: nothing new starts and nothing is ordered, and what runs ends at its next convenient point; what still runs at 12:20 UTC (14:20 Europe/Brussels, 15 October) is stopped\n',
        ),
      );
      assert.deepStrictEqual(appended(1), [
        paused({ via: 'plugin', stopAt: iso(20), zone: 'Europe/Brussels' }),
      ]);
    });

    it('refuses neither or both of an order and --all, and a --by it cannot read, appending nothing', async () => {
      const before = lastId();
      for (const argv of [
        ['pause'],
        ['pause', '23', '--all'],
        ['continue'],
        ['continue', '23', '--all'],
        ['pause', '23', '--by', 'tonight'],
      ]) {
        const result = await run(argv);
        assert.equal(result.exitCode, 2, argv.join(' '));
        assert.match(result.stderr, /^foedrum (pause|continue): invalid </, argv.join(' '));
      }
      assert.equal(lastId(), before);
    });

    it('refuses an order with no batch that has not ended', async () => {
      assert.deepStrictEqual(
        await run(['pause', '#40']),
        refused('pause', 'there is no batch of #40 that has not ended to pause'),
      );
    });

    it('continues an order, and the whole Brewery with --all', async () => {
      await run(['pause', '23']);
      assert.deepStrictEqual(
        await run(['continue', '#23'], { user: () => 'grace' }),
        ok('#23 continues\n'),
      );
      assert.deepStrictEqual(appended(1), [
        { type: 'order.continued', order: { issue: 23 }, by: 'grace', via: 'terminal' },
      ]);
      await run(['pause', '--all']);
      assert.deepStrictEqual(await run(['continue', '--all']), ok('The Brewery continues\n'));
    });

    it('refuses to continue an order that is not paused', async () => {
      assert.deepStrictEqual(
        await run(['continue', '23']),
        refused('continue', '#23 is not paused'),
      );
    });

    it('replays the pause of all that held a batch since before it was ordered, and none lifted before', async () => {
      await run(['pause', '--all', '--why', 'last week']);
      await run(['continue', '--all']);
      await run(['pause', '--all', '--why', 'release day']);
      assert.equal((await run(['order', '#99'])).exitCode, 0);
      const replay = (await run(['replay', '99-1'])).stdout;
      assert.match(replay, /order\.paused +\{"by":"ada","via":"terminal","why":"release day"\}/);
      assert.doesNotMatch(replay, /last week|order\.continued/);
    });

    it('shows a pause in status and replay, with the pause and continue events that held the batch', async () => {
      await run(['pause', '23', '--why', 'lunch']);
      await run(['pause', '21']);
      assert.match(
        (await run(['status'])).stdout,
        /23-1 +#23 +brewing +plan #1 started; paused by ada: lunch/,
      );
      const replay = (await run(['replay', '23-1'])).stdout;
      assert.match(
        replay,
        /order\.paused +\{"order":\{"issue":23\},"by":"ada","via":"terminal","why":"lunch"\}/,
      );
      assert.doesNotMatch(replay, /"issue":21/);
      assert.match(replay, / {2}paused {2}by ada via terminal: lunch\n/);
      await run(['continue', '23']);
      const after = (await run(['replay', '23-1'])).stdout;
      assert.match(after, /order\.continued/);
      assert.doesNotMatch(after, / {2}paused {2}/);
    });
  });

  describe('--via (ADR 0125)', () => {
    it('records the plugin as the surface of a command the plugin runs', async () => {
      assert.deepStrictEqual(
        await run(['cancel', '23-1', '--via', 'plugin']),
        ok('23-1 cancelled: by ada via plugin\n'),
      );
      assert.deepStrictEqual(appended(1), [
        { type: 'batch.cancelled', batchId: '23-1', by: 'ada', via: 'plugin' },
      ]);
    });

    it('takes --via=terminal over the surface it is given, and the answers around it', async () => {
      const argv = ['answer', '21-1', '--via=terminal', 'sqlite', 'yes'];
      assert.equal((await run(argv, { surface: 'plugin' })).exitCode, 0);
      const [answered] = appended(3);
      assert.equal(answered?.type === 'input.received' && answered.via, 'terminal');
      assert.deepStrictEqual(
        answered?.type === 'input.received' && answered.answers.map(({ answer }) => answer),
        ['sqlite', 'yes'],
      );
    });

    it('reads every argument after -- as an answer, as the plugin passes them', async () => {
      const argv = ['answer', '21-1', '--via', 'plugin', '--', '-h', '--via=terminal'];
      assert.equal((await run(argv)).exitCode, 0);
      const [answered] = appended(3);
      assert.deepStrictEqual(
        answered?.type === 'input.received' && [
          answered.via,
          answered.answers.map(({ answer }) => answer),
        ],
        ['plugin', ['-h', '--via=terminal']],
      );
    });

    it('passes the surface to brew, which records it on what it makes', async () => {
      const issued: unknown[] = [];
      const brew: CliContext['brew'] = async (_input, by) => {
        issued.push(by);
        return ok('');
      };
      assert.equal((await run(['brew', '21', '--via', 'plugin'], { brew })).exitCode, 0);
      assert.deepStrictEqual(issued, [{ by: 'ada', via: 'plugin' }]);
    });

    it('is taken by a read-only command too', async () => {
      assert.equal((await run(['stuck', '--via', 'plugin'])).exitCode, 0);
    });

    it('names no surface the terminal cannot speak for, and appends nothing', async () => {
      const before = lastId();
      for (const via of ['comment', 'dashboard', 'Plugin', '']) {
        assert.deepStrictEqual(await run(['cancel', '23-1', `--via=${via}`]), {
          exitCode: 2,
          stdout: '',
          stderr: `foedrum cancel: --via takes plugin or terminal, not ${JSON.stringify(via)}\n`,
        });
      }
      assert.deepStrictEqual(await run(['cancel', '23-1', '--via']), {
        exitCode: 2,
        stdout: '',
        stderr: 'foedrum cancel: --via needs a value\n',
      });
      assert.equal(lastId(), before);
    });
  });

  describe('answer', () => {
    it('answers the questions in the order they were asked, and resumes the step', async () => {
      assert.deepStrictEqual(
        await run(['answer', '21-1', 'sqlite', 'no, drop it']),
        ok('21-1 brewing: plan #2 scheduled\n'),
      );
      assert.deepStrictEqual(appended(3)[0], {
        type: 'input.received',
        batchId: '21-1',
        stepId: 'plan',
        by: 'ada',
        via: 'terminal',
        answers: [
          { q: 'Which database should the cache use?', answer: 'sqlite' },
          { q: 'Keep the old endpoint?', answer: 'no, drop it' },
        ],
      });
    });

    it('refuses too few or too many answers, appending nothing', async () => {
      const before = lastId();
      const reason = 'batch 21-1 asked 2 questions; give one answer to each, in order';
      assert.deepStrictEqual(await run(['answer', '21-1', 'sqlite']), refused('answer', reason));
      assert.deepStrictEqual(
        await run(['answer', '21-1', 'sqlite', 'no', 'and more']),
        refused('answer', reason),
      );
      assert.equal(lastId(), before);
    });

    it('refuses a batch that asked nothing', async () => {
      assert.deepStrictEqual(
        await run(['answer', '22-1', 'sqlite']),
        refused('answer', 'batch 22-1 does not offer answer'),
      );
      assert.deepStrictEqual(
        await run(['answer', '23-1', 'sqlite']),
        refused('answer', 'batch 23-1 is brewing; answer needs it stuck'),
      );
    });

    it('refuses a missing or blank answer as a command line error', async () => {
      assert.deepStrictEqual(await run(['answer', '21-1']), {
        exitCode: 2,
        stdout: '',
        stderr: 'foedrum answer: missing <answers>\n',
      });
      assert.deepStrictEqual(await run(['answer', '21-1', 'sqlite', ' ']), {
        exitCode: 2,
        stdout: '',
        stderr: 'foedrum answer: invalid <answers> " ": Must not be empty\n',
      });
    });
  });

  describe('recipe', () => {
    it('brews the batch with another recipe from its first step', async () => {
      assert.deepStrictEqual(
        await run(['recipe', '22-1', 'stout', 'the plan needs an analysis']),
        ok('22-1 brewing: analyze #1 scheduled\n'),
      );
      assert.deepStrictEqual(appended(3).slice(0, 2), [
        {
          type: 'batch.recipe_chosen',
          batchId: '22-1',
          recipe: 'stout',
          reason: 'the plan needs an analysis',
          source: 'human',
          by: 'ada',
          via: 'terminal',
        },
        { type: 'batch.resumed', batchId: '22-1', by: 'ada', via: 'terminal', action: 'recipe' },
      ]);
    });

    it('refuses a recipe the Brewery does not have', async () => {
      assert.deepStrictEqual(
        await run(['recipe', '22-1', 'porter', 'why not']),
        refused('recipe', 'the Brewery has no recipe porter'),
      );
    });
  });

  describe('rewind', () => {
    it('takes the batch back to a step with the commit of each repository', async () => {
      assert.deepStrictEqual(
        await run(['rewind', '22-1', 'plan', `acme/app=${SHA}`, `acme/lib=${'e'.repeat(40)}`]),
        ok('22-1 brewing: plan #2 scheduled\n'),
      );
      assert.deepStrictEqual(appended(2)[0], {
        type: 'batch.rewound',
        batchId: '22-1',
        toStepId: 'plan',
        by: 'ada',
        via: 'terminal',
        shas: { 'acme/app': SHA, 'acme/lib': 'e'.repeat(40) },
      });
    });

    it('refuses a commit that names no repository or no full sha, as a command line error', async () => {
      const invalid = (value: string) => ({
        exitCode: 2,
        stdout: '',
        stderr: `foedrum rewind: invalid <commits> "${value}": Must be owner/name=<full commit sha>\n`,
      });
      assert.deepStrictEqual(
        await run(['rewind', '22-1', 'plan', 'acme/app']),
        invalid('acme/app'),
      );
      assert.deepStrictEqual(
        await run(['rewind', '22-1', 'plan', `acme/app=${SHA}`, 'acme/lib=main']),
        invalid('acme/lib=main'),
      );
    });

    it('refuses a repository named twice', async () => {
      assert.deepStrictEqual(
        await run(['rewind', '22-1', 'plan', `acme/app=${SHA}`, `Acme/App=${SHA}`]),
        {
          exitCode: 2,
          stdout: '',
          stderr: `foedrum rewind: invalid <commits>: Must name each repository once\n`,
        },
      );
    });

    it('refuses a step the recipe does not have', async () => {
      assert.deepStrictEqual(
        await run(['rewind', '22-1', 'deploy', `acme/app=${SHA}`]),
        refused('rewind', 'recipe pint has no step deploy'),
      );
    });
  });

  describe('takeover (ADR 0124)', () => {
    const leases = () => store.batchLeases(t0).map(({ batchId, owner }) => [batchId, owner]);

    it("hands a batch from the driver that holds it to --as's, recording who and from where", async () => {
      assert.deepStrictEqual(
        await run(['takeover', '22-1', '--as', 'ann']),
        ok(`22-1 handed from cellar to ann; its effects wait until ${iso(3)}\n`),
      );
      assert.deepStrictEqual(appended(1), [
        {
          type: 'batch.taken_over',
          batchId: '22-1',
          by: 'ada',
          via: 'terminal',
          from: 'cellar',
          to: 'ann',
          until: iso(3),
        },
      ]);
      assert.deepStrictEqual(leases(), [['22-1', 'ann']]);
    });

    it("hands it to the Claude Code session's driver without --as, and to the Cellar with --as cellar", async () => {
      const env = { CLAUDE_CODE_SESSION_ID: 'ABC-1' };
      assert.equal((await run(['takeover', '22-1'], { env })).exitCode, 0);
      assert.deepStrictEqual(leases(), [['22-1', 'session-abc-1']]);
      assert.equal((await run(['takeover', '22-1', '--as', 'cellar'])).exitCode, 0);
      assert.deepStrictEqual(leases(), [['22-1', 'cellar']]);
    });

    it('is a mistake of the command line without --as outside a session: exit 2, nothing recorded', async () => {
      const before = lastId();
      assert.deepStrictEqual(await run(['takeover', '22-1']), {
        exitCode: 2,
        stdout: '',
        stderr:
          'foedrum takeover: no Claude Code session names the driver (CLAUDE_CODE_SESSION_ID); give --as <name>\n',
      });
      assert.equal(lastId(), before);
    });

    it('refuses a batch no other driver holds', async () => {
      assert.deepStrictEqual(
        await run(['takeover', '23-1', '--as', 'ann']),
        refused('takeover', 'no driver holds batch 23-1; foedrum brew drives it'),
      );
    });
  });
});

describe('foedrum stuck', () => {
  let store: EventStore;
  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
  });
  afterEach(() => store.close());

  const run = (argv: string[]): Promise<CliResult> =>
    runCli(argv, {
      cwd,
      gatherDoctorFacts: async () => linux(),
      openStore: () => ({ ...store, close: () => {} }),
      openWritableStore: () => undefined,
      recipes: () => recipes,
      brewers: () => assert.fail('no brewer files to read'),
      user: () => 'ada',
      surface: 'terminal',
      now: () => t0,
      zone: () => 'UTC',
      readKeptBranches: async () => assert.fail('no kept branch to read'),
      config: () => assert.fail('no foedrum.jsonc to read'),
      claims: () => assert.fail('no claim host to reach'),
      queue: () => assert.fail('no queue to read'),
      serve: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      brew: async () => assert.fail('no brew here'),
      watch: async () => assert.fail('no watch here'),
      resume: async () => assert.fail('no session to resume'),
      init: async () => assert.fail('no init here'),
      env: {},
    });
  const append = (...events: Event[]) =>
    store.withTransaction((tx) => {
      for (const event of events) tx.append(event);
    });
  const ordered = (issue: number): Event => ({
    type: 'batch.ordered',
    batchId: `${issue}-1`,
    order: { issue },
    routeBy: iso(60),
  });

  it('says so when no batch is Stuck', async () => {
    append(ordered(11));
    assert.deepStrictEqual(await run(['stuck']), {
      exitCode: 0,
      stdout: 'No Stuck batches.\n',
      stderr: '',
    });
  });

  it('lists each Stuck batch with what it offers and the questions it asks', async () => {
    append(
      ordered(11),
      ordered(21),
      {
        type: 'batch.stuck',
        batchId: '21-1',
        reason: { kind: 'needs_input', stepId: 'plan', questions },
        options: ['answer', 'retry', 'skip', 'recipe', 'rewind', 'cancel'],
        remindAt: iso(2880),
      },
      ordered(25),
      {
        type: 'batch.stuck',
        batchId: '25-1',
        reason: { kind: 'routing', deadlineAt: iso(60) },
        options: ['retry', 'recipe', 'cancel'],
        remindAt: iso(2880),
      },
    );
    assert.deepStrictEqual(await run(['stuck']), {
      exitCode: 0,
      stdout: [
        '2 Stuck batches',
        '',
        `21-1  #21  needs input at plan; reminder ${iso(2880)}`,
        '  options: answer, retry, skip, recipe, rewind, cancel',
        '  1. Which database should the cache use? (sqlite, redis; recommended: sqlite)',
        '  2. Keep the old endpoint? (yes, no; recommended: yes)',
        `25-1  #25  not routed by ${iso(60)}; reminder ${iso(2880)}`,
        '  options: retry, recipe, cancel',
        '',
      ].join('\n'),
      stderr: '',
    });
  });

  it('says one round, that it recorded no finding, and keeps a commit the batch knows (review of #508)', async () => {
    const commit = 'c0ffee'.repeat(6).concat('c0ff');
    const step = { batchId: '12-1', stepId: 'correctness', attempt: 1 };
    append(
      ordered(12),
      { type: 'step.scheduled', ...step, deadlineAt: iso(60) },
      {
        type: 'step.started',
        ...step,
        worktree: { repo: 'acme/api', path: 'w', branch: 'b', commit },
      },
      {
        type: 'batch.stuck',
        batchId: '12-1',
        reason: {
          kind: 'blocked',
          stepId: 'correctness',
          blockerKind: 'findings',
          summary: `the Taster asks for changes: ${commit} has no deadline`,
          roundsOut: {
            rounds: 1,
            open: [{ severity: 'major', why: `${commit} has no deadline`, introduced: true }],
            more: 0,
          },
        },
        options: ['retry', 'cancel'],
        remindAt: iso(2880),
      },
      ordered(13),
      {
        type: 'batch.stuck',
        batchId: '13-1',
        reason: {
          kind: 'blocked',
          stepId: 'implement',
          blockerKind: 'findings',
          summary: 'the test is wrong',
          roundsOut: { rounds: 1, open: [], more: 0 },
        },
        options: ['retry', 'cancel'],
        remindAt: iso(2880),
      },
    );
    const { stdout } = await run(['stuck']);
    const lines = stdout.split('\n');
    const at12 = lines.findIndex((line) => line.startsWith('12-1'));
    assert.deepStrictEqual(lines.slice(at12 + 1, at12 + 5), [
      '  options: retry, cancel',
      '  still open after 1 round:',
      `    major: ${commit} has no deadline`,
      '  Another round is unlikely to help: plan the order again, or split it.',
    ]);
    const at13 = lines.findIndex((line) => line.startsWith('13-1'));
    assert.deepStrictEqual(lines.slice(at13 + 1, at13 + 4), [
      '  options: retry, cancel',
      '  still open after 1 round: no finding was recorded',
      '  Another round is unlikely to help: plan the order again, or split it.',
    ]);
  });

  it('lists the open findings of a findings route that ran out of rounds, and recommends stepping back (ADR 0192)', async () => {
    // Built at run time, so no scanner takes this file for one that holds a token.
    const token = ['ghp', 'A1b2'.repeat(9)].join('_');
    append(ordered(11), {
      type: 'batch.stuck',
      batchId: '11-1',
      reason: {
        kind: 'blocked',
        stepId: 'correctness',
        blockerKind: 'findings',
        summary: 'the Taster asks for changes: no deadline',
        roundsOut: {
          rounds: 2,
          open: [
            {
              file: 'src/poll.ts',
              line: 3,
              severity: 'major',
              why: 'no\ndeadline',
              introduced: true,
            },
            { severity: 'minor', why: 'x'.repeat(300), introduced: false },
            { severity: 'blocker', why: `Token ${token}`, introduced: true },
          ],
          more: 4,
        },
      },
      options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
      remindAt: iso(2880),
    });
    assert.deepStrictEqual(await run(['stuck']), {
      exitCode: 0,
      stdout: [
        '1 Stuck batch',
        '',
        `11-1  #11  blocked at correctness (findings): the Taster asks for changes: no deadline; reminder ${iso(2880)}`,
        '  options: retry, skip, recipe, rewind, cancel',
        '  still open after 2 rounds:',
        '    major in src/poll.ts:3: no deadline',
        `    minor, there before the change: ${'x'.repeat(199)}…`,
        '    blocker: [left out: a text of step correctness that looks like a secret]',
        '    and 4 more',
        '  Another round is unlikely to help: plan the order again, or split it.',
        '',
      ].join('\n'),
      stderr: '',
    });
  });

  // An event written before ADR 0192, or by a step with no findings route, has no roundsOut.
  it('lists a findings blocker without rounds as it always did, with no step-back', async () => {
    append(ordered(11), {
      type: 'batch.stuck',
      batchId: '11-1',
      reason: {
        kind: 'blocked',
        stepId: 'correctness',
        blockerKind: 'findings',
        summary: 'the Taster asks for changes: no deadline',
      },
      options: ['retry', 'skip', 'recipe', 'rewind', 'cancel'],
      remindAt: iso(2880),
    });
    assert.deepStrictEqual(await run(['stuck']), {
      exitCode: 0,
      stdout: [
        '1 Stuck batch',
        '',
        `11-1  #11  blocked at correctness (findings): the Taster asks for changes: no deadline; reminder ${iso(2880)}`,
        '  options: retry, skip, recipe, rewind, cancel',
        '',
      ].join('\n'),
      stderr: '',
    });
  });
});

describe('foedrum brewers', () => {
  let store: EventStore;
  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
  });
  afterEach(() => store.close());

  const source: BrewerSource = {
    brewers: [
      { name: 'planner', path: 'brewers/planner.md' },
      { name: 'coder', path: 'defaults/brewers/coder.md' },
    ],
    step: (recipe, stepId) =>
      recipe === 'pint' && stepId === 'plan' ? { brewer: 'planner' } : undefined,
  };
  const run = (argv: string[], overrides: Partial<CliContext> = {}): Promise<CliResult> =>
    runCli(argv, {
      cwd,
      gatherDoctorFacts: async () => linux(),
      openStore: () => ({ ...store, close: () => {} }),
      openWritableStore: () => assert.fail('brewers only reads (ADR 0030)'),
      recipes: () => assert.fail('brewers needs no Recipes'),
      brewers: () => source,
      user: () => 'ada',
      surface: 'terminal',
      now: () => t0,
      zone: () => 'UTC',
      readKeptBranches: async () => assert.fail('no kept branch to read'),
      config: () => assert.fail('no foedrum.jsonc to read'),
      claims: () => assert.fail('no claim host to reach'),
      queue: () => assert.fail('no queue to read'),
      serve: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      brew: async () => assert.fail('no brew here'),
      watch: async () => assert.fail('no watch here'),
      resume: async () => assert.fail('no session to resume'),
      init: async () => assert.fail('no init here'),
      env: {},
      ...overrides,
    });

  it("reports each brewer from the store's attempts, and appends nothing", async () => {
    store.withTransaction((tx) => {
      for (const event of [
        { type: 'batch.ordered', batchId: '11-1', order: { issue: 11 }, routeBy: iso(60) },
        {
          type: 'batch.recipe_chosen',
          batchId: '11-1',
          recipe: 'pint',
          reason: 'label',
          source: 'label',
        },
        {
          type: 'step.scheduled',
          batchId: '11-1',
          stepId: 'plan',
          attempt: 1,
          deadlineAt: iso(60),
        },
        { type: 'step.started', batchId: '11-1', stepId: 'plan', attempt: 1 },
        {
          type: 'step.finished',
          batchId: '11-1',
          stepId: 'plan',
          attempt: 1,
          outcome: { kind: 'succeeded', output: {} },
          usage: { inputTokens: 40, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 10 },
        },
      ] satisfies Event[])
        tx.append(event);
    });
    const before = store.eventsAfter(0).length;
    assert.deepStrictEqual(await run(['brewers']), {
      exitCode: 0,
      stdout: [
        'coder  defaults/brewers/coder.md',
        '  no attempts',
        'planner  brewers/planner.md',
        '  1 attempt: 1 succeeded',
        '  tokens: 40 input, 30 output, 20 cache read, 10 cache write',
        '',
      ].join('\n'),
      stderr: '',
    });
    assert.equal(store.eventsAfter(0).length, before);
  });

  it('lists the brewers with no attempts when there is no store yet', async () => {
    assert.deepStrictEqual(await run(['brewers'], { openStore: () => undefined }), {
      exitCode: 0,
      stdout: [
        'coder  defaults/brewers/coder.md',
        '  no attempts',
        'planner  brewers/planner.md',
        '  no attempts',
        '',
      ].join('\n'),
      stderr: '',
    });
  });

  it("refuses with doctor's line when the files do not load", async () => {
    const line = invalidRecipes(['brewers/planner.md: EACCES']);
    const brewers = () => {
      throw new Error(line);
    };
    assert.deepStrictEqual(await run(['brewers'], { brewers }), {
      exitCode: 1,
      stdout: '',
      stderr: `foedrum brewers: ${line}\n`,
    });
  });
});

describe('foedrum order: order an issue again (ADR 0105)', () => {
  let store: EventStore;
  let github: FakeGitHub;
  const checks = { build: null, typecheck: null, lint: null, format: null, test: null };
  const config = BreweryConfig.parse({
    brewery: 'acme/brewery',
    repositories: {
      'acme/web': { checks, alias: 'web', intake: { labels: ['foedrum'] } },
      'acme/docs': { checks, alias: 'docs' },
    },
  });
  const record = (brewery: string, issue: number): string =>
    JSON.stringify({ brewery, issue, claimedAt: iso(-60) });

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    github = fakeGitHub();
    const log = createCommandLog({ store, recipes });
    const issue = (command: Parameters<typeof log.issue>[0]) =>
      assert.equal(log.issue(command, t0).kind, 'accepted', JSON.stringify(command));
    const cancel = (batchId: string) =>
      issue({ kind: 'cancel', batchId, by: 'octocat', via: 'comment' });
    const release = (batchId: string) => {
      for (const effect of ['release.label', 'release.comment', 'release.ref']) {
        const key = effectKey.encode({ batchId, effect });
        issue({ kind: 'record', event: { type: 'effect.applied', key, result: null } });
      }
    };
    // 21-1 was cancelled and 22-1 brews; web-7 was cancelled and its claim released, web-8 was
    // cancelled and its release is still due, web-9 brews.
    issue({ kind: 'order', batchId: '21-1', order: { issue: 21 } });
    cancel('21-1');
    issue({ kind: 'order', batchId: '22-1', order: { issue: 22 } });
    issue({ kind: 'route', batchId: '22-1', recipe: 'pint', reason: 'label', source: 'label' });
    for (const number of [7, 8, 9]) {
      issue({
        kind: 'order',
        batchId: `web-${number}`,
        order: { issue: number, repo: 'acme/web' },
      });
    }
    cancel('web-7');
    release('web-7');
    cancel('web-8');
    issue({ kind: 'route', batchId: 'web-9', recipe: 'pint', reason: 'label', source: 'label' });
  });
  afterEach(() => store.close());

  const context = (overrides: Partial<CliContext> = {}): CliContext => ({
    cwd,
    gatherDoctorFacts: async () => linux(),
    openStore: () => assert.fail('order opens the store for writing'),
    openWritableStore: () => ({ ...store, close: () => {} }),
    recipes: () => recipes,
    brewers: () => assert.fail('no brewer files to read'),
    user: () => 'ada',
    surface: 'terminal',
    now: () => t0,
    zone: () => 'UTC',
    readKeptBranches: async () => assert.fail('no kept branch to read'),
    config: () => config,
    claims: (given) => {
      assert.equal(given, config);
      return github.host;
    },
    queue: () => assert.fail('no queue to read'),
    serve: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    brew: async () => assert.fail('no brew here'),
    watch: async () => assert.fail('no watch here'),
    resume: async () => assert.fail('no session to resume'),
    init: async () => assert.fail('no init here'),
    env: {},
    ...overrides,
  });
  const run = (argv: string[], overrides: Partial<CliContext> = {}): Promise<CliResult> =>
    runCli(argv, context(overrides));
  const lastId = () => store.lastEventId();
  const last = (): Event | undefined => store.eventsAfter(0).at(-1)?.event;
  const ok = (stdout: string): CliResult => ({ exitCode: 0, stdout, stderr: '' });
  const refused = (reason: string): CliResult => ({
    exitCode: 1,
    stdout: '',
    stderr: `foedrum order: ${reason}\n`,
  });
  const reached = (): number => [...github.calls.values()].reduce((sum, n) => sum + n, 0);
  const ordered = `ordered: to be routed by ${iso(60)}`;

  it('pauses and continues a target issue by its alias, and refuses an alias foedrum.jsonc lacks (ADR 0202)', async () => {
    assert.equal((await run(['pause', 'web#9'])).exitCode, 0);
    assert.deepStrictEqual(last(), {
      type: 'order.paused',
      order: { issue: 9, repo: 'acme/web' },
      by: 'ada',
      via: 'terminal',
    });
    assert.deepStrictEqual(await run(['continue', 'web#9']), ok('web#9 continues\n'));
    const before = lastId();
    assert.deepStrictEqual(await run(['pause', 'nope#9']), {
      exitCode: 1,
      stdout: '',
      stderr: 'foedrum pause: foedrum.jsonc names no repository with the alias nope\n',
    });
    assert.equal(lastId(), before);
  });

  describe('a target-repository issue', () => {
    it('claims it again and orders it as <alias>-<n>-<k>, recorded with who and from where', async () => {
      assert.deepStrictEqual(await run(['order', 'web#7']), ok(`web-7-2 ${ordered}\n`));
      assert.deepStrictEqual(last(), {
        type: 'batch.ordered',
        batchId: 'web-7-2',
        order: { issue: 7, repo: 'acme/web' },
        routeBy: iso(60),
        at: t0.toISOString(),
        by: 'ada',
        via: 'terminal',
      });
      assert.deepStrictEqual(JSON.parse(github.refs.get('acme/web#7') ?? 'null'), {
        brewery: 'acme/brewery',
        issue: 7,
        claimedAt: t0.toISOString(),
      });
    });

    it('orders an issue whose claim is its own already', async () => {
      github.setRef('acme/web', 7, record('acme/brewery', 7));
      assert.deepStrictEqual(await run(['order', 'web#7']), ok(`web-7-2 ${ordered}\n`));
    });

    it('orders an issue it never brewed as <alias>-<n>', async () => {
      assert.deepStrictEqual(await run(['order', 'web#5']), ok(`web-5 ${ordered}\n`));
    });

    it('refuses an issue another Brewery holds, naming it, and appends nothing', async () => {
      const before = lastId();
      github.setRef('acme/web', 7, record('other/brewery', 7));
      assert.deepStrictEqual(
        await run(['order', 'web#7']),
        refused('acme/web#7 is claimed by other/brewery'),
      );
      github.setRef('acme/web', 7, 'not a record');
      assert.deepStrictEqual(
        await run(['order', 'web#7']),
        refused('acme/web#7 is claimed by a ref whose record cannot be read'),
      );
      assert.equal(lastId(), before);
    });

    it('refuses an order that lands while the claim waits on GitHub, and keeps the claim its own', async () => {
      const racing = {
        ...github.host,
        create: async (...args: Parameters<FakeGitHub['host']['create']>) => {
          // The intake of a running serve orders the issue meanwhile.
          const order = { issue: 7, repo: 'acme/web' };
          const log = createCommandLog({ store, recipes });
          assert.equal(
            log.issue({ kind: 'order', batchId: 'web-7-2', order }, t0).kind,
            'accepted',
          );
          return github.host.create(...args);
        },
      };
      assert.deepStrictEqual(
        await run(['order', 'web#7'], { claims: () => racing }),
        refused('batch web-7-2 of acme/web#7 is still ordered'),
      );
      const event = last();
      assert.deepStrictEqual(event?.type === 'batch.ordered' && [event.batchId, event.by], [
        'web-7-2',
        undefined,
      ]);
      assert.equal(JSON.parse(github.refs.get('acme/web#7') ?? 'null').brewery, 'acme/brewery');
    });

    it('refuses an issue with a live batch before it claims anything', async () => {
      assert.deepStrictEqual(
        await run(['order', 'web#9']),
        refused('batch web-9 of acme/web#9 is still brewing'),
      );
      assert.equal(reached(), 0);
    });

    it('refuses an issue whose last release is still due before it claims anything', async () => {
      const before = lastId();
      assert.deepStrictEqual(
        await run(['order', 'web#8']),
        refused(
          'the release of the claim of batch web-8 is still due: foedrum serve applies it, then order acme/web#8 again',
        ),
      );
      assert.equal(reached(), 0);
      assert.equal(lastId(), before);
    });

    it('refuses an alias foedrum.jsonc does not name', async () => {
      assert.deepStrictEqual(
        await run(['order', 'www#7']),
        refused('foedrum.jsonc names no repository with the alias www'),
      );
    });

    it('refuses a repository without an intake: nothing would mark or route its issue', async () => {
      assert.deepStrictEqual(
        await run(['order', 'docs#3']),
        refused(
          'acme/docs has no intake in foedrum.jsonc; order only issues of a repository with one',
        ),
      );
      assert.equal(reached(), 0);
    });

    it("refuses without the Brewery's name, which its claim records", async () => {
      const { brewery: _, ...nameless } = config;
      assert.deepStrictEqual(
        await run(['order', 'web#7'], { config: () => nameless }),
        refused('foedrum.jsonc: name the Brewery with "brewery": "<owner>/<name>" (ADR 0063)'),
      );
    });

    it('fails with one line when foedrum.jsonc does not load or the claim fails, appending nothing', async () => {
      const before = lastId();
      const broken = () => {
        throw new Error('foedrum.jsonc: repositories: Required');
      };
      assert.deepStrictEqual(
        await run(['order', 'web#7'], { config: broken }),
        refused('foedrum.jsonc: repositories: Required'),
      );
      const down = {
        ...github.host,
        create: async () => {
          throw new Error('gh: HTTP 502');
        },
      };
      assert.deepStrictEqual(
        await run(['order', 'web#7'], { claims: () => down }),
        refused('gh: HTTP 502'),
      );
      assert.equal(lastId(), before);
    });
  });

  describe('a Brewery issue', () => {
    const noConfig = {
      config: () => assert.fail('a Brewery issue needs no foedrum.jsonc'),
      claims: () => assert.fail('a Brewery issue is never claimed'),
    };

    for (const issue of ['#21', '21']) {
      it(`orders ${issue} again as <n>-<k>, without reading foedrum.jsonc or claiming`, async () => {
        assert.deepStrictEqual(await run(['order', issue], noConfig), ok(`21-2 ${ordered}\n`));
        assert.deepStrictEqual(last(), {
          type: 'batch.ordered',
          batchId: '21-2',
          order: { issue: 21 },
          routeBy: iso(60),
          at: t0.toISOString(),
          by: 'ada',
          via: 'terminal',
        });
      });
    }

    it('refuses an issue with a live batch', async () => {
      assert.deepStrictEqual(
        await run(['order', '#22'], noConfig),
        refused('batch 22-1 of #22 is still brewing'),
      );
    });
  });

  it('records the surface and the user it is given, as every command does', async () => {
    for (const argv of [
      ['order', 'web#7'],
      ['order', '#21'],
    ]) {
      await run(argv, { user: () => 'grace', surface: 'plugin' });
      const event = last();
      assert.deepStrictEqual(
        event?.type === 'batch.ordered' && [event.by, event.via],
        ['grace', 'plugin'],
        argv.join(' '),
      );
    }
  });

  for (const given of ['Web#7', 'web#0', 'web#', 'web-7', '#x', 'web#7x', '#-1', 'w-b#7', '']) {
    it(`refuses ${JSON.stringify(given)} as a mistake of the command line`, async () => {
      assert.deepStrictEqual(await run(['order', given]), {
        exitCode: 2,
        stdout: '',
        stderr: `foedrum order: invalid <issue> ${JSON.stringify(given)}: Must be <alias>#<n> of a target repository, or #<n> of the Brewery\n`,
      });
    });
  }

  it('fails without creating a store where there is none, and claims nothing', async () => {
    assert.deepStrictEqual(
      await run(['order', 'web#7'], { openWritableStore: () => undefined }),
      refused(`no event store at ${storePath}`),
    );
    assert.equal(reached(), 0);
  });
});
