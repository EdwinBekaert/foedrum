// The commands that change state, and `stuck`, through runCli with an in-memory event store
// (ADR 0019, ADR 0025, ADR 0030): each parses its untrusted input with its schema, appends through
// the command log with who issued it and from where, and refuses what decide refuses.

import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands } from '../../src/cli/commands.ts';
import { type CliContext, type CliResult, runCli } from '../../src/cli/run.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { invalidRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { Question } from '../../src/schemas/step-outcome.ts';
import { linux } from '../helpers/doctor-facts.ts';
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
    user: () => 'ada',
    surface: 'terminal',
    now: () => t0,
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
    for (const argv of [['status'], ['stuck'], ['replay', '21-1'], ['doctor']]) {
      assert.equal((await run(argv)).exitCode, 0, argv.join(' '));
    }
    assert.deepStrictEqual(opened.writable, []);
    assert.equal(lastId(), before);
  });

  it("never loads the Brewery's recipes for a read-only command (ADR 0053)", async () => {
    const recipes = () => {
      throw new Error('the recipes were loaded');
    };
    for (const argv of [['status'], ['stuck'], ['replay', '21-1'], ['doctor']]) {
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
    };
    const names = commands.filter((command) => command.changesState).map(({ name }) => name);
    assert.deepStrictEqual(names, Object.keys(lines));
    for (const name of names) {
      opened = { readOnly: [], writable: [] };
      assert.equal((await run(lines[name] ?? [])).exitCode, 0, name);
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
      user: () => 'ada',
      surface: 'terminal',
      now: () => t0,
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
});
