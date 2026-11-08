// Nip and the Gauger, Foedrum's default test-first recipe and brewer (#218, ADR 0017): a Brewery
// without files of its own plans Nip's steps from the defaults, and the Gauger's prompt holds the
// test-design lens's checklist, passed in as an input (ADR 0022, ADR 0098).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  attemptLimits,
  type EarlierRound,
  earlierFindingsInput,
  earlierRoundsOf,
  groupOfStep,
  routeInput,
  routeOf,
} from '../../src/brewers/attempt-plan.ts';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import type { PromptInput } from '../../src/brewers/prompt.ts';
import type { AttemptRef } from '../../src/engine/attempt-key.ts';
import type { AttemptLimits } from '../../src/engine/brewer-runner.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { type Command, decide } from '../../src/engine/decide.ts';
import { openDriver } from '../../src/engine/driver.ts';
import { type Batch, fold } from '../../src/engine/fold.ts';
import { freeCapacity } from '../../src/engine/intake.ts';
import { lensRounds } from '../../src/engine/lens-rounds.ts';
import { brewLog, pullRequestText, stepReports } from '../../src/engine/pull-request.ts';
import { type LoadedRecipes, loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { renderStatus } from '../../src/engine/status-comment.ts';
import type { Event, GravityReading } from '../../src/schemas/events.ts';
import { Disposition, OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { z } from '../../src/schemas/zod.ts';
import { createBrewing, defaultLimits } from '../helpers/brewing.ts';
import { type Behaviour, behave, fakeBrewerRunner, outDoc } from '../helpers/fake-brewer-runner.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeWorktrees } from '../helpers/fake-worktrees.ts';

// A Brewery with no recipes/, brewers/ or lenses/ of its own: a folder that does not exist has
// none, so only Foedrum's defaults load.
const noFiles = readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery'));

const valid = (result: LoadedRecipes) => {
  assert.ok(result.valid, result.valid ? '' : result.problems.join('\n'));
  return result;
};

/** The events of an order brewed with the default Nip, as the fake runner plays its steps. */
const brewNipEvents = async (
  scripts: Record<string, readonly Behaviour[]>,
  limits?: (stepId: string) => AttemptLimits,
): Promise<Event[]> => {
  const store = openSqliteEventStore(':memory:');
  try {
    const brewing = createBrewing({
      store,
      runner: fakeBrewerRunner(scripts),
      recipes: valid(loadRecipes(noFiles)).recipes,
      clock: () => new Date('2026-10-21T12:00:00.000Z'),
      ...(limits === undefined ? {} : { limits }),
    });
    assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
    assert.ok(
      brewing.command({
        kind: 'route',
        batchId: 'b1',
        recipe: 'nip',
        reason: 'label',
        source: 'label',
      }),
    );
    await brewing.drive();
    return [...brewing.events()];
  } finally {
    store.close();
  }
};

/** The steps an order brewed with the default Nip started, in order, as the fake runner plays them. */
const brewNip = async (scripts: Record<string, readonly Behaviour[]>): Promise<string[]> =>
  (await brewNipEvents(scripts)).flatMap((event) =>
    event.type === 'step.started' ? [event.stepId] : [],
  );

describe('the default Nip', () => {
  it('a batch with no map has its first step propose one and brews with it', async () => {
    // The recipe's line: survey and its check before the Gauger. That a survey ends without a
    // session, that its check reads the proposed map and that the red proof proves from it are
    // survey.test.ts's, check-runner-survey.test.ts's and serve-test-first.test.ts's; a fixture
    // brewed through a real map is #750's.
    const done = behave.succeed();
    const started = await brewNip({
      survey: [done],
      'survey-check': [done],
      gauge: [done],
      red: [done],
      implement: [done],
      fine: [done],
      green: [done],
      correctness: [done],
      acceptance: [done],
      security: [done],
      'design-conformance': [done],
      'open-pull-request': [done],
    });
    assert.deepEqual(started.slice(0, 3), ['survey', 'survey-check', 'gauge']);
    // The survey's check read the map before the Gauger, and the batch brewed to its pull request.
    assert.equal(started.at(-1), 'open-pull-request');
  });

  it('a recipe that is not test-first runs no survey: regression test', async () => {
    // Nip with testFirst off, as a Brewery's own copy of it may be (ADR 0064).
    const nipText = readFileSync(join(FOEDRUM_DEFAULTS, 'recipes', 'nip.jsonc'), 'utf8').replace(
      '"name": "nip",',
      '"name": "nip", "testFirst": false,',
    );
    const files = { ...noFiles, recipes: [{ path: 'recipes/nip.jsonc', text: nipText }] };
    const store = openSqliteEventStore(':memory:');
    try {
      const done = behave.succeed();
      const brewing = createBrewing({
        store,
        runner: fakeBrewerRunner({
          implement: [done],
          fine: [done],
          green: [done],
          correctness: [done],
          acceptance: [done],
          security: [done],
          'design-conformance': [done],
          'open-pull-request': [done],
        }),
        recipes: valid(loadRecipes(files)).recipes,
        clock: () => new Date('2026-10-21T12:00:00.000Z'),
      });
      assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
      const route = { kind: 'route', batchId: 'b1', recipe: 'nip', reason: 'label' } as const;
      assert.ok(brewing.command({ ...route, source: 'label' }));
      await brewing.drive();
      const events = [...brewing.events()];
      assert.deepEqual(
        events.flatMap((event) => (event.type === 'step.skipped' ? [event.stepId] : [])),
        ['survey', 'survey-check', 'gauge', 'red'],
      );
      assert.deepEqual(
        events.flatMap((event) => (event.type === 'step.started' ? [event.stepId] : [])),
        [
          'implement',
          'fine',
          'green',
          'correctness',
          'acceptance',
          'security',
          'design-conformance',
          'open-pull-request',
        ],
      );
    } finally {
      store.close();
    }
  });

  it('sends a Cellarman that finds a test wrong back to the Gauger, once (ADR 0017, ADR 0064)', async () => {
    const done = behave.succeed();
    const started = await brewNip({
      survey: [done],
      'survey-check': [done],
      gauge: [done, done],
      red: [done, done],
      implement: [behave.blocked('findings', 'The test expects the wrong slug'), done],
      fine: [done, done],
      green: [done],
      correctness: [done],
      acceptance: [done],
      security: [done],
      'design-conformance': [done],
      'open-pull-request': [done],
    });
    assert.deepEqual(started, [
      'survey',
      'survey-check',
      'gauge',
      'red',
      'implement',
      'gauge',
      'red',
      'implement',
      'fine',
      'green',
      'correctness',
      'acceptance',
      'security',
      'design-conformance',
      'open-pull-request',
    ]);
  });

  it('sends a Cellarman whose change fails the green checks back to try again, once', async () => {
    const done = behave.succeed();
    const started = await brewNip({
      survey: [done],
      'survey-check': [done],
      gauge: [done],
      red: [done],
      implement: [done, done],
      fine: [done, done],
      green: [behave.fail(false), done],
      correctness: [done],
      acceptance: [done],
      security: [done],
      'design-conformance': [done],
      'open-pull-request': [done],
    });
    assert.deepEqual(started, [
      'survey',
      'survey-check',
      'gauge',
      'red',
      'implement',
      'fine',
      'green',
      'implement',
      'fine',
      'green',
      'correctness',
      'acceptance',
      'security',
      'design-conformance',
      'open-pull-request',
    ]);
  });

  it("records a failed green check's route so the Cellarman's second attempt reads the failing test (#341, ADR 0128)", async () => {
    const store = openSqliteEventStore(':memory:');
    try {
      const done = behave.succeed();
      const failing: GravityReading = {
        result: 'exited',
        check: 'test',
        command: 'npm test',
        exitCode: 1,
        tail: 'not ok 3 - status --json prints the batches',
      };
      const scripts: Record<string, Behaviour[]> = {
        survey: [done],
        'survey-check': [done],
        gauge: [done],
        red: [done],
        implement: [done, done],
        fine: [done, done],
        green: [behave.read([failing]), done],
        correctness: [done],
        acceptance: [done],
        security: [done],
        'design-conformance': [done],
        'open-pull-request': [done],
      };
      const { brewers, recipes } = valid(loadRecipes(noFiles));
      // What each attempt of implement would be told about why it runs, when it starts.
      const told: (PromptInput | undefined)[] = [];
      const brewing = createBrewing({
        store,
        runner: fakeBrewerRunner((attempt) => {
          const { stepId } = attempt.ref;
          if (stepId === 'implement') {
            const batch = fold(brewing.events()).batches.get('b1');
            assert.ok(batch !== undefined);
            const outDocOf = (id: string) => brewers.find('nip', id)?.brewer.output.doc;
            const route = routeOf(batch, attempt.ref, outDocOf);
            told.push(route === undefined ? undefined : routeInput(route));
          }
          return scripts[stepId]?.shift();
        }),
        recipes,
        clock: () => new Date('2026-10-21T12:00:00.000Z'),
      });
      assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
      assert.ok(
        brewing.command({
          kind: 'route',
          batchId: 'b1',
          recipe: 'nip',
          reason: 'label',
          source: 'label',
        }),
      );
      await brewing.drive();
      assert.equal(told.length, 2);
      assert.equal(told[0], undefined, 'the first attempt was told why it runs again');
      assert.deepEqual(told[1]?.source, {
        kind: 'route',
        step: 'implement',
        from: 'green',
        why: 'failed',
      });
      assert.match(told[1]?.text ?? '', /the check "test" \(npm test\) failed with exit code 1/);
      assert.match(told[1]?.text ?? '', /not ok 3 - status --json prints the batches/);
    } finally {
      store.close();
    }
  });

  it('goes no further when the red proof refuses the tests a second time', async () => {
    const done = behave.succeed();
    const started = await brewNip({
      survey: [done],
      'survey-check': [done],
      gauge: [done, done, done],
      red: [behave.fail(false), behave.fail(false), done],
      implement: [done],
      fine: [done, done],
    });
    assert.deepEqual(started, ['survey', 'survey-check', 'gauge', 'red', 'gauge', 'red']);
  });

  it('sends a Gauger whose tests the red proof refuses back to write them again, once', async () => {
    const done = behave.succeed();
    const started = await brewNip({
      survey: [done],
      'survey-check': [done],
      gauge: [done, done],
      red: [behave.fail(false), done],
      implement: [done],
      fine: [done, done],
      green: [done],
      correctness: [done],
      acceptance: [done],
      security: [done],
      'design-conformance': [done],
      'open-pull-request': [done],
    });
    assert.deepEqual(started, [
      'survey',
      'survey-check',
      'gauge',
      'red',
      'gauge',
      'red',
      'implement',
      'fine',
      'green',
      'correctness',
      'acceptance',
      'security',
      'design-conformance',
      'open-pull-request',
    ]);
  });

  it("gives Cellarman the Gauger's out doc and the testsUnchanged guard, and both brewers commit", () => {
    const { brewers } = valid(loadRecipes(noFiles));
    const cellarman = brewers.find('nip', 'implement')?.brewer;
    assert.ok(cellarman !== undefined, 'nip has no implement step');
    assert.ok(cellarman.guards.includes('testsUnchanged'), JSON.stringify(cellarman.guards));
    assert.ok(
      cellarman.inputs.some(({ from }) => from === 'step:gauge'),
      JSON.stringify(cellarman.inputs),
    );
    for (const step of ['gauge', 'implement']) {
      const brewer = brewers.find('nip', step)?.brewer;
      assert.equal(brewer?.produces, 'commits', step);
      assert.ok(brewer.guards.includes('requiresCommits'), step);
    }
  });

  it('simplifies the change with the Finer after Cellarman and before green, keeping the red proof tests (ADR 0166)', () => {
    const { brewers, recipes } = valid(loadRecipes(noFiles));
    const steps = recipes.find('nip')?.steps ?? [];
    assert.equal(steps.indexOf('fine'), steps.indexOf('implement') + 1, steps.join(', '));
    assert.equal(steps.indexOf('green'), steps.indexOf('fine') + 1, steps.join(', '));
    const finer = brewers.find('nip', 'fine')?.brewer;
    assert.equal(finer?.name, 'finer');
    assert.equal(finer.produces, 'commits');
    assert.ok(finer.guards.includes('testsUnchanged'), JSON.stringify(finer.guards));
  });

  it("has Cellarman write the pull request's sections, its out doc schema pullRequest (ADR 0167)", () => {
    const { brewers } = valid(loadRecipes(noFiles));
    assert.equal(brewers.find('nip', 'implement')?.brewer.output.schema, 'pullRequest');
  });

  it('has the Gauger name its new tests and regression tests, its out doc schema gauge (ADR 0170)', () => {
    const { brewers } = valid(loadRecipes(noFiles));
    assert.equal(brewers.find('nip', 'gauge')?.brewer.output.schema, 'gauge');
  });

  it("plans Nip's steps from the defaults in a Brewery without its own nip.jsonc and gauger.md", () => {
    const loaded = valid(loadRecipes(noFiles));
    assert.deepEqual(loaded.recipes.find('nip')?.steps, [
      'survey',
      'survey-check',
      'gauge',
      'red',
      'implement',
      'fine',
      'green',
      'correctness',
      'acceptance',
      'security',
      'design-conformance',
      'open-pull-request',
    ]);
    assert.equal(loaded.brewers.find('nip', 'gauge')?.brewer.name, 'gauger');
    assert.equal(loaded.brewers.find('nip', 'implement')?.brewer.name, 'cellarman');
    // After green, four Tasters review side by side, through the correctness, acceptance, security
    // and design conformance lenses (ADR 0168, ADR 0197, ADR 0306, ADR 0343); correctness blocks
    // (ADR 0264), the others advise.
    assert.deepEqual(loaded.recipes.find('nip')?.children('taste'), [
      'correctness',
      'acceptance',
      'security',
      'design-conformance',
    ]);
    for (const lens of ['correctness', 'acceptance']) {
      const taste = loaded.brewers.find('nip', lens);
      assert.equal(taste?.brewer.name, 'taster', lens);
      assert.deepEqual([...(taste?.lenses?.keys() ?? [])], [`diff/${lens}`]);
      assert.equal(taste?.blocking, lens === 'correctness', lens);
    }
    assert.deepEqual(loaded.checks.redProof('nip'), { id: 'red', of: 'gauge' });
    for (const path of [
      'defaults/recipes/nip.jsonc',
      'defaults/brewers/gauger.md',
      'defaults/brewers/cellarman.md',
      'defaults/brewers/finer.md',
      'defaults/brewers/taster.md',
      'defaults/lenses/diff/correctness.md',
      'defaults/lenses/diff/acceptance.md',
    ]) {
      assert.ok(loaded.defaults.includes(path), `${path} is not in ${loaded.defaults.join(', ')}`);
    }
  });

  it("routes every Taster's findings back to Cellarman along the taste group's route, twice at most (ADR 0354)", () => {
    const nip = valid(loadRecipes(noFiles)).recipes.find('nip');
    for (const taster of ['correctness', 'acceptance', 'security', 'design-conformance']) {
      assert.equal(nip?.routesTo(taster, 'findings'), 'implement', taster);
      assert.equal(nip.maxRounds(taster, 'findings'), 2, taster);
    }
  });

  it('tastes through the security lens beside correctness and acceptance, advisory (ADR 0306)', () => {
    const { brewers, recipes } = valid(loadRecipes(noFiles));
    const security = brewers.find('nip', 'security');
    assert.equal(security?.brewer.name, 'taster');
    assert.deepEqual([...(security.lenses?.keys() ?? [])], ['diff/security']);
    // Its findings go back along the group's route, as every Taster's do (ADR 0354).
    assert.equal(security.blocking, true);
    assert.equal(recipes.find('nip')?.routesTo('security', 'findings'), 'implement');
  });

  it('nip tastes through design conformance', () => {
    const { brewers, defaults, recipes } = valid(loadRecipes(noFiles));
    const nip = recipes.find('nip');
    assert.equal(nip?.children('taste')?.at(-1), 'design-conformance');
    const conformance = brewers.find('nip', 'design-conformance');
    assert.equal(conformance?.brewer.name, 'taster');
    assert.deepEqual([...(conformance.lenses?.keys() ?? [])], ['diff/design-conformance']);
    assert.ok(defaults.includes('defaults/lenses/diff/design-conformance.md'), defaults.join(', '));
    // Its findings go back along the group's route, as every Taster's do (ADR 0354).
    assert.equal(conformance.blocking, true);
    assert.equal(nip.routesTo('design-conformance', 'findings'), 'implement');
  });

  it("nip's four Tasters start side by side and take one place of the Brewery's concurrency (ADR 0343)", async () => {
    const done = behave.succeed();
    const events = await brewNipEvents({
      survey: [done],
      'survey-check': [done],
      gauge: [done],
      red: [done],
      implement: [done],
      fine: [done],
      green: [done],
      correctness: [done],
      acceptance: [done],
      security: [done],
      'design-conformance': [done],
      'open-pull-request': [done],
    });
    const tasters = new Set(['correctness', 'acceptance', 'security', 'design-conformance']);
    const inGroup = events.flatMap((event, at) =>
      (event.type === 'step.started' || event.type === 'step.finished') && tasters.has(event.stepId)
        ? [{ type: event.type, at }]
        : [],
    );
    assert.deepEqual(
      inGroup.slice(0, 4).map(({ type }) => type),
      ['step.started', 'step.started', 'step.started', 'step.started'],
    );
    // All four running: a concurrency of 1 is full with this one batch, and 2 leaves one more place.
    const running = fold(events.slice(0, (inGroup[3]?.at ?? 0) + 1));
    assert.equal(freeCapacity(running, 1), 0);
    assert.equal(freeCapacity(running, 2), 1);
  });

  describe('a batch inside the taste group when the fourth Taster arrives (ADR 0168, ADR 0343)', () => {
    const now = new Date('2026-10-21T12:00:00.000Z');
    const context = () => ({
      now,
      reminderMs: 3_600_000,
      routingMs: 3_600_000,
      recipes: valid(loadRecipes(noFiles)).recipes,
    });
    /** The events of a batch brewed with Nip's three Tasters, up to their first end. */
    const inTheGroupOfThree = async (): Promise<Event[]> => {
      const nipText = readFileSync(join(FOEDRUM_DEFAULTS, 'recipes', 'nip.jsonc'), 'utf8');
      const threeTasters = nipText.replace(
        /,(\s*\/\/[^\n]*)*\s*\{ "id": "design-conformance"[^}]*\}/,
        '',
      );
      const recipes = valid(
        loadRecipes({ ...noFiles, recipes: [{ path: 'recipes/nip.jsonc', text: threeTasters }] }),
      ).recipes;
      assert.deepEqual(recipes.find('nip')?.children('taste'), [
        'correctness',
        'acceptance',
        'security',
      ]);
      const done = behave.succeed();
      const store = openSqliteEventStore(':memory:');
      try {
        const brewing = createBrewing({
          store,
          runner: fakeBrewerRunner(
            Object.fromEntries(
              [
                'survey',
                'survey-check',
                'gauge',
                'red',
                'implement',
                'fine',
                'green',
                'correctness',
                'acceptance',
                'security',
                'open-pull-request',
              ].map((id) => [id, [done]]),
            ),
          ),
          recipes,
          clock: () => now,
        });
        assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
        const route = { kind: 'route', batchId: 'b1', recipe: 'nip', reason: 'label' } as const;
        assert.ok(brewing.command({ ...route, source: 'label' }));
        await brewing.drive();
        const events = [...brewing.events()];
        const firstEnd = events.findIndex(
          (event) => event.type === 'step.finished' && event.stepId === 'correctness',
        );
        return events.slice(0, firstEnd);
      } finally {
        store.close();
      }
    };
    /** The batch's log, on which a command is decided with the four Tasters of the new install. */
    const logOf = (events: readonly Event[]) => {
      let log = [...events];
      return {
        accept: (command: Command): Event[] => {
          const decision = decide(fold(log), command, context());
          assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
          const made = decision.kind === 'accepted' ? [...decision.events] : [];
          log = [...log, ...made];
          return made;
        },
        add: (event: Event) => {
          log = [...log, event];
        },
        lane: () => fold(log).batches.get('b1')?.lane,
        batch: () => fold(log).batches.get('b1'),
      };
    };
    const finish = (stepId: string): Command => ({
      kind: 'finish',
      batchId: 'b1',
      stepId,
      attempt: 1,
      ending: {
        kind: 'succeeded',
        output: {
          status: 'done',
          summary: 'Nothing found',
          assumptions: [],
          verdict: 'approve',
          findings: [],
        },
      },
    });
    const person = { batchId: 'b1', by: 'ada', via: 'terminal' } as const;
    const scheduled = (events: readonly Event[]): string[] =>
      events.flatMap((event) =>
        event.type === 'step.scheduled' ? [`${event.stepId}#${event.attempt}`] : [],
      );
    /** The batch once its three Tasters ended: Stuck, as the parallel group's own test pins. */
    const stuck = async (correctness: Command = finish('correctness')) => {
      const log = logOf(await inTheGroupOfThree());
      log.accept(correctness);
      for (const taster of ['acceptance', 'security']) log.accept(finish(taster));
      const lane = log.lane();
      assert.ok(lane?.kind === 'stuck' && lane.reason.kind === 'blocked', JSON.stringify(lane));
      assert.equal(lane.reason.stepId, 'design-conformance');
      return log;
    };

    it('a retry runs only the Taster it never had, and the group ends on to the pull request', async () => {
      const log = await stuck();
      assert.deepEqual(scheduled(log.accept({ kind: 'retry', ...person })), [
        'design-conformance#1',
      ]);
      log.add({ type: 'step.started', batchId: 'b1', stepId: 'design-conformance', attempt: 1 });
      assert.deepEqual(scheduled(log.accept(finish('design-conformance'))), [
        'open-pull-request#1',
      ]);
    });

    it('a skip goes on to the pull request without it', async () => {
      const log = await stuck();
      assert.deepEqual(scheduled(log.accept({ kind: 'skip', ...person })), ['open-pull-request#1']);
      assert.equal(log.lane()?.kind, 'brewing');
    });

    const asksChanges: Command = {
      kind: 'finish',
      batchId: 'b1',
      stepId: 'correctness',
      attempt: 1,
      ending: {
        kind: 'blocked',
        blockerKind: 'findings',
        summary: 'An Ordered sub-order holds nothing',
      },
    };

    it('a retry after correctness asked for changes goes back to Cellarman: regression test', async () => {
      const log = await stuck(asksChanges);
      assert.deepEqual(scheduled(log.accept({ kind: 'retry', ...person })), [
        'design-conformance#1',
      ]);
      log.add({ type: 'step.started', batchId: 'b1', stepId: 'design-conformance', attempt: 1 });
      assert.deepEqual(scheduled(log.accept(finish('design-conformance'))), ['implement#2']);
    });

    it('a skip after correctness asked for changes goes on to the pull request past them', async () => {
      const log = await stuck(asksChanges);
      assert.deepEqual(scheduled(log.accept({ kind: 'skip', ...person })), ['open-pull-request#1']);
      const batch = log.batch();
      assert.ok(batch !== undefined);
      // What a person is told of correctness's changes after this skip: its attempt has no verdict,
      // and the pull request opens as a draft all the same (ADR 0345).
      const reports = stepReports(batch);
      assert.deepEqual(
        reports.flatMap(({ stepId, tasting }) => (tasting === undefined ? [] : [stepId])),
        ['acceptance', 'security'],
      );
      assert.equal(pullRequestText({ title: 'A title', reports }).draft, true);
      const comment = renderStatus(batch);
      assert.match(comment, /`correctness #1` ❌ blocked \(findings\)/);
      assert.match(
        comment,
        /- ❌ `correctness`: attempt 1 failed: blocked \(findings\): An Ordered sub-order holds nothing/,
      );
      assert.doesNotMatch(comment, /\*\*Findings\*\*/);
      const { body } = pullRequestText({
        title: 'A title',
        reports,
        attempts: brewLog(batch),
      });
      assert.doesNotMatch(body, /every Taster approved/);
      assert.match(body, /`correctness #1` \| [^\n]*An Ordered sub-order holds nothing/);
    });

    it('a pull request past a skipped blocking Taster does not say every Taster approved', async () => {
      const log = await stuck(asksChanges);
      log.accept({ kind: 'skip', ...person });
      const batch = log.batch();
      assert.ok(batch !== undefined);
      const { body, draft } = pullRequestText({
        title: 'A title',
        reports: stepReports(batch),
        attempts: brewLog(batch),
      });
      assert.equal(draft, true);
      assert.doesNotMatch(body, /every Taster approved/);
      const left =
        /`correctness` is left open by a skip: its attempt 1 was blocked by its findings/;
      assert.match(body, left);
      assert.match(renderStatus(batch), left);
      // The summary its out doc gave, in the reports, since its round recorded no finding.
      assert.match(body, /correctness: blocked \(findings\): An Ordered sub-order holds nothing/);
      // The Taster the fourth lens's arrival held back never ran.
      const never = /`design-conformance` did not run, and a person's skip went past it/;
      assert.match(body, never);
      assert.match(renderStatus(batch), never);
    });

    it('a skip past only a Taster that never ran opens a draft too', async () => {
      const log = await stuck();
      log.accept({ kind: 'skip', ...person });
      const batch = log.batch();
      assert.ok(batch !== undefined);
      assert.equal(pullRequestText({ title: 'A title', reports: stepReports(batch) }).draft, true);
      const { body } = pullRequestText({ title: 'A title', reports: stepReports(batch) });
      assert.doesNotMatch(body, /every Taster approved/);
      assert.match(body, /`design-conformance` did not run, and a person's skip went past it/);
      assert.doesNotMatch(body, /`correctness`/);
    });
  });

  it('sends a batch whose correctness Taster asks for changes back to Cellarman, then through fine and green again (ADR 0264)', async () => {
    const done = behave.succeed();
    const started = await brewNip({
      survey: [done],
      'survey-check': [done],
      gauge: [done],
      red: [done],
      implement: [done, done],
      fine: [done, done],
      green: [done, done],
      correctness: [behave.blocked('findings', 'An Ordered sub-order holds nothing'), done],
      acceptance: [done, done],
      security: [done, done],
      'design-conformance': [done, done],
      'open-pull-request': [done],
    });
    assert.deepEqual(started, [
      'survey',
      'survey-check',
      'gauge',
      'red',
      'implement',
      'fine',
      'green',
      'correctness',
      'acceptance',
      'security',
      'design-conformance',
      'implement',
      'fine',
      'green',
      'correctness',
      'acceptance',
      'security',
      'design-conformance',
      'open-pull-request',
    ]);
  });

  it('goes no further when the correctness Taster still asks for changes after two rounds (ADR 0192, ADR 0264)', async () => {
    const done = behave.succeed();
    const changes = behave.blocked('findings', 'An Ordered sub-order holds nothing');
    const events = await brewNipEvents({
      survey: [done],
      'survey-check': [done],
      gauge: [done],
      red: [done],
      implement: [done, done, done],
      fine: [done, done, done],
      green: [done, done, done],
      correctness: [changes, changes, changes, done],
      acceptance: [done, done, done, done],
      security: [done, done, done, done],
      'design-conformance': [done, done, done, done],
      'open-pull-request': [done],
    });
    const started = events.flatMap((event) =>
      event.type === 'step.started' ? [event.stepId] : [],
    );
    assert.equal(started.filter((step) => step === 'correctness').length, 3);
    assert.equal(started.filter((step) => step === 'implement').length, 3);
    assert.ok(!started.includes('open-pull-request'), started.join(', '));
    assert.equal(fold(events).batches.get('b1')?.lane.kind, 'stuck');
    assert.equal(events.at(-1)?.type, 'batch.stuck', JSON.stringify(events.at(-1)));
  });

  describe("every Taster's findings go back along the taste group's route (ADR 0354)", () => {
    const { brewers } = valid(loadRecipes(noFiles));
    // Each Taster's out doc read with its own schema and route, as the attempt plan reads it.
    const tasted = (stepId: string): AttemptLimits => {
      const found = brewers.find('nip', stepId);
      return found?.lens === undefined
        ? defaultLimits
        : attemptLimits(found.brewer, undefined, found.blocking, found.together);
    };
    const done = behave.succeed();
    const approves = behave.succeedWith({ verdict: 'approve', findings: [] });
    const finding = (why: string, introduced = true) => ({
      file: 'docs/design/rounds.md',
      line: 4,
      severity: 'minor',
      why,
      introduced,
    });
    const nit = (why: string, introduced = true): Behaviour =>
      behave.succeedWith({ verdict: 'approve', findings: [finding(why, introduced)] });
    const startedOf = (events: readonly Event[]) =>
      events.flatMap((event) => (event.type === 'step.started' ? [event.stepId] : []));
    const ROUND = ['correctness', 'acceptance', 'security', 'design-conformance'];
    const BACK = ['implement', 'fine', 'green'];
    const before = { survey: [done], 'survey-check': [done], gauge: [done], red: [done] };

    it('sends a batch whose design conformance alone approves with a minor finding back to Cellarman, then tastes again', async () => {
      const events = await brewNipEvents(
        {
          ...before,
          implement: [done, done],
          fine: [done, done],
          green: [done, done],
          correctness: [approves, approves],
          acceptance: [approves, approves],
          security: [approves, approves],
          'design-conformance': [nit('the page still names the old flag'), approves],
          'open-pull-request': [done],
        },
        tasted,
      );
      assert.deepEqual(startedOf(events).slice(4), [
        ...BACK,
        ...ROUND,
        ...BACK,
        ...ROUND,
        'open-pull-request',
      ]);
    });

    it('sends a finding that was there before the change back too, and a round that raises it no more goes on', async () => {
      const events = await brewNipEvents(
        {
          ...before,
          implement: [done, done],
          fine: [done, done],
          green: [done, done],
          correctness: [nit('the poll had no deadline before the change', false), approves],
          acceptance: [approves, approves],
          security: [approves, approves],
          'design-conformance': [approves, approves],
          'open-pull-request': [done],
        },
        tasted,
      );
      const started = startedOf(events);
      assert.equal(started.filter((step) => step === 'implement').length, 2);
      assert.equal(started.at(-1), 'open-pull-request');
      assert.notEqual(fold(events).batches.get('b1')?.lane.kind, 'stuck');
    });

    it('shares two rounds in all among the Tasters, then is Stuck with the last round open', async () => {
      const events = await brewNipEvents(
        {
          ...before,
          implement: [done, done, done],
          fine: [done, done, done],
          green: [done, done, done],
          correctness: [nit('round one'), approves, approves],
          acceptance: [approves, nit('round two'), approves],
          security: [approves, approves, approves],
          'design-conformance': [approves, approves, nit('round three')],
          'open-pull-request': [done],
        },
        tasted,
      );
      const started = startedOf(events);
      assert.equal(started.filter((step) => step === 'implement').length, 3);
      assert.ok(!started.includes('open-pull-request'), started.join(', '));
      const lane = fold(events).batches.get('b1')?.lane;
      assert.equal(lane?.kind, 'stuck');
      assert.deepEqual(lane?.kind === 'stuck' ? lane.reason : undefined, {
        kind: 'blocked',
        stepId: 'design-conformance',
        blockerKind: 'findings',
        summary: 'the Taster approves with findings: Done',
        roundsOut: { rounds: 2, open: [finding('round three')], more: 0 },
      });
    });

    it("names every Taster a skip left with findings open, an approving one's too (ADR 0345)", async () => {
      const events = await brewNipEvents(
        {
          ...before,
          implement: [done, done, done],
          fine: [done, done, done],
          green: [done, done, done],
          correctness: [nit('one'), nit('two'), nit('three')],
          acceptance: [approves, approves, nit('a gap')],
          security: [approves, approves, approves],
          'design-conformance': [approves, approves, approves],
          'open-pull-request': [done],
        },
        tasted,
      );
      const skip = decide(
        fold(events),
        { kind: 'skip', batchId: 'b1', by: 'ada', via: 'terminal' },
        {
          now: new Date('2026-10-21T12:00:00.000Z'),
          reminderMs: 3_600_000,
          routingMs: 3_600_000,
          recipes: valid(loadRecipes(noFiles)).recipes,
        },
      );
      assert.equal(skip.kind, 'accepted');
      const batch = fold([...events, ...(skip.kind === 'accepted' ? skip.events : [])]).batches.get(
        'b1',
      );
      assert.ok(batch !== undefined);
      const { body } = pullRequestText({ title: 'A title', reports: stepReports(batch) });
      for (const step of ['correctness', 'acceptance']) {
        assert.match(
          body,
          new RegExp(
            `\`${step}\` is left open by a skip: its attempt 3 was blocked by its findings`,
          ),
        );
      }
      assert.doesNotMatch(body, /`security` is left open/);
    });
  });

  it("reads the typecheck in Nip's green step, after the build and before lint (#411)", () => {
    const loaded = valid(loadRecipes(noFiles));
    assert.deepEqual(loaded.checks.find('nip', 'green'), [
      'build',
      'typecheck',
      'lint',
      'format',
      'test',
    ]);
  });

  it('brews an order through each of its steps, in order, with the fake brewer runner', async () => {
    const store = openSqliteEventStore(':memory:');
    try {
      const done = behave.succeed();
      const brewing = createBrewing({
        store,
        // The check steps and the action play on the fake runner too: this is about the recipe's
        // line, not what each step does.
        runner: fakeBrewerRunner(
          Object.fromEntries(
            [
              'survey',
              'survey-check',
              'gauge',
              'red',
              'implement',
              'fine',
              'green',
              'correctness',
              'acceptance',
              'security',
              'design-conformance',
              'open-pull-request',
            ].map((id) => [id, [done]]),
          ),
        ),
        recipes: valid(loadRecipes(noFiles)).recipes,
        clock: () => new Date('2026-10-21T12:00:00.000Z'),
      });
      assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
      assert.ok(
        brewing.command({
          kind: 'route',
          batchId: 'b1',
          recipe: 'nip',
          reason: 'label',
          source: 'label',
        }),
      );
      await brewing.drive();
      const started = brewing
        .events()
        .flatMap((event) => (event.type === 'step.started' ? [event.stepId] : []));
      assert.deepEqual(started, [
        'survey',
        'survey-check',
        'gauge',
        'red',
        'implement',
        'fine',
        'green',
        'correctness',
        'acceptance',
        'security',
        'design-conformance',
        'open-pull-request',
      ]);
    } finally {
      store.close();
    }
  });
});

describe('the default Cellarman', () => {
  const cellarman = () => valid(loadRecipes(noFiles)).brewers.find('nip', 'implement');

  it("puts a wrong test's findings in blockerKind and the out doc's text, which its frontmatter allows (#470)", () => {
    const found = cellarman();
    assert.ok(found !== undefined, 'nip has no implement step');
    const [wrongTest = ''] = found.instructions
      .split('\n')
      .filter((line) => /wrong test/i.test(line));
    assert.match(wrongTest, /"blockerKind": "findings"/);
    assert.match(wrongTest, /out doc's text/);
  });

  it("gives the default Cellarman its earlier attempts' sections, and asks for them back updated for the whole change (#947)", () => {
    const found = cellarman();
    assert.ok(found !== undefined, 'nip has no implement step');
    const earlier = found.brewer.inputs.find(({ from }) => from === 'earlier-sections');
    assert.ok(earlier !== undefined, JSON.stringify(found.brewer.inputs));
    const [section = ''] = found.instructions
      .split(/\n(?=## )/)
      .filter((part) => part.startsWith("## The pull request's sections"));
    assert.ok(section.includes(`{${earlier.name}}`), section);
    assert.match(section, /whole change/);
  });

  it("ends with its questions when a Taster's finding needs a decision it cannot make, and its version is raised (ADR 0354)", () => {
    const found = cellarman();
    assert.ok(found !== undefined, 'nip has no implement step');
    const [section = ''] = found.instructions
      .split(/\n(?=## )/)
      .filter((part) => part.startsWith("## A Taster's findings"));
    assert.match(section, /cannot settle[^\n]*`needs_input`/);
    assert.doesNotMatch(section, /advisory/);
    assert.ok(found.brewer.version > 13, String(found.brewer.version));
  });

  it('raises the version of the default Cellarman, whose prompt changed (#947)', () => {
    const found = cellarman();
    assert.ok(found !== undefined, 'nip has no implement step');
    assert.ok(found.brewer.version > 12, String(found.brewer.version));
  });

  it("the default Cellarman's prompt tells it to read the Gauger's tests before it writes code", () => {
    const found = cellarman();
    assert.ok(found !== undefined, 'nip has no implement step');
    const [upFront = ''] = found.instructions.split(/\n(?=## )/).filter((part) => part.trim());
    assert.match(
      upFront,
      /Before you write any code[^\n]*\{tests\}[^\n]*regressionTests[^\n]*read/,
    );
  });

  it('asks a dismissed and a pre-existing why to name its evidence, and its example shows one (#521, ADR 0204)', () => {
    const found = cellarman();
    assert.ok(found !== undefined, 'nip has no implement step');
    const lines = found.instructions.split('\n');
    const evidence = /names the evidence that shows it/;
    for (const disposition of ['dismissed', 'pre-existing']) {
      const [line = ''] = lines.filter((each) => each.startsWith(`- \`"${disposition}"\``));
      assert.match(line, evidence, disposition);
    }
    const [example = ''] = lines.filter((line) => line.startsWith('For example: '));
    const listed = /`"dispositions": (\[.*?\])`/.exec(example)?.[1];
    assert.ok(listed !== undefined, example);
    const dismissed = z
      .array(Disposition)
      .parse(JSON.parse(listed))
      .find(({ disposition }) => disposition === 'dismissed');
    // A place, a test or a sentence of the order: here the order's sentence, quoted by its place.
    assert.match(dismissed?.why ?? '', /the order's .* sentence/i);
  });

  it('sends a Cellarman out doc with a wrong test in its text back to the Gauger, whose input names the test (#470)', async () => {
    const store = openSqliteEventStore(':memory:');
    try {
      const done = behave.succeed();
      // Written as the Cellarman's instructions say: the findings in blockerKind and the text.
      const blocked = [
        outDoc({
          status: 'blocked',
          summary: '1 of the Gauger’s tests cannot pass',
          assumptions: [],
          blockerKind: 'findings',
        }),
        '- `brews twice on one lock`: the first brew releases the fake lock the second needs.',
        '',
      ].join('\n');
      const scripts: Record<string, Behaviour[]> = {
        survey: [done],
        'survey-check': [done],
        gauge: [done, done],
        red: [done, done],
        implement: [behave.writes(blocked), done],
        fine: [done],
        green: [done],
        correctness: [done],
        acceptance: [done],
        security: [done],
        'design-conformance': [done],
        'open-pull-request': [done],
      };
      const { brewers, recipes } = valid(loadRecipes(noFiles));
      const told: (PromptInput | undefined)[] = [];
      // The out docs the brewers wrote, by their path in the attempt's worktree.
      const written = new Map<string, string>();
      const outDocOf = (id: string) => brewers.find('nip', id)?.brewer.output.doc;
      const clock = () => new Date('2026-10-21T12:00:00.000Z');
      const events = () => store.eventsAfter(0).map(({ event }) => event);
      const driver = await openDriver({
        store,
        runner: fakeBrewerRunner((attempt) => {
          const { stepId } = attempt.ref;
          const batch = fold(events()).batches.get('b1');
          assert.ok(batch !== undefined);
          if (stepId === 'implement' && attempt.ref.attempt === 1) {
            const running = batch.steps.get('implement')?.attempts.get(1);
            assert.ok(running?.phase === 'started', 'implement#1 has not started');
            assert.ok(running.worktree !== undefined, 'implement#1 has no worktree');
            written.set(join(running.worktree.path, 'brew.md'), blocked);
          }
          if (stepId === 'gauge') {
            const route = routeOf(batch, attempt.ref, outDocOf);
            // The plan reads the out doc the route points at, as the brewer left it there.
            const text = route?.outDoc === undefined ? undefined : written.get(route.outDoc.path);
            told.push(
              route === undefined
                ? undefined
                : routeInput(
                    route,
                    text === undefined ? { kind: 'missing' } : { kind: 'text', text },
                  ),
            );
          }
          return scripts[stepId]?.shift();
        }),
        worktrees: [{ repo: 'acme/api', base: 'origin/main', manager: fakeWorktrees() }],
        recipes,
        // Implement's out doc read with the Cellarman's own schema, as the attempt plan reads it.
        limits: ({ stepId }) => {
          const found = stepId === 'implement' ? brewers.find('nip', stepId) : undefined;
          return found === undefined ? defaultLimits : attemptLimits(found.brewer);
        },
        clock,
        lock: () => fakeLock('cellar'),
        takes: () => true,
        stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      });
      try {
        const intake = createCommandLog({ store, recipes });
        intake.issue({ kind: 'order', batchId: 'b1', order: { issue: 1 } }, clock());
        const route = { kind: 'route', batchId: 'b1', recipe: 'nip', reason: 'label' } as const;
        intake.issue({ ...route, source: 'label' }, clock());
        await driver.drive();
      } finally {
        driver.close();
      }
      const started = events().flatMap((event) =>
        event.type === 'step.started' ? [event.stepId] : [],
      );
      // An out doc the Cellarman's schema refused would retry implement instead of going to gauge.
      assert.deepEqual(started.slice(2, 6), ['gauge', 'red', 'implement', 'gauge']);
      assert.equal(told.length, 2);
      assert.deepEqual(told[1]?.source, {
        kind: 'route',
        step: 'gauge',
        from: 'implement',
        why: 'findings',
      });
      assert.match(told[1]?.text ?? '', /^Step implement ended: blocked \(findings\)/);
      assert.match(told[1]?.text ?? '', /brews twice on one lock`: the first brew releases/);
    } finally {
      store.close();
    }
  });
});

describe('the default Gauger', () => {
  const gauger = () => valid(loadRecipes(noFiles)).brewers.find('nip', 'gauge');

  it('says up front that stubs throw "not implemented" and that the red proof reads the test map, not test names', () => {
    const found = gauger();
    assert.ok(found !== undefined, 'nip has no gauge step');
    // The first section: everything before the second heading.
    const [upFront = ''] = found.instructions.split(/\n(?=## )/).filter((part) => part.trim());
    assert.match(upFront, /throw[^\n]*not implemented/i);
    assert.match(
      upFront,
      /red proof reads the repository's test map[^\n]*never your tests' names/i,
    );
  });

  it("holds the test-design lens's checklist in its prompt, as an input, not a copy", async () => {
    const found = gauger();
    assert.ok(found !== undefined, 'nip has no gauge step');
    assert.ok(found.lenses?.has('diff/test-design'), 'the gauger names no lens diff/test-design');
    const lens = readFileSync(join(FOEDRUM_DEFAULTS, 'lenses', 'diff', 'test-design.md'), 'utf8');
    // Not repeated in the brewer file: the brewer and the Taster read the one checklist.
    const copied = lens
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 40 && found.instructions.includes(line));
    assert.deepEqual(copied, []);

    const ref = { batchId: '12-1', stepId: 'gauge', attempt: 1 };
    const events: Event[] = [
      {
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        routeBy: '2026-10-21T13:00:00.000Z',
      },
      {
        type: 'batch.recipe_chosen',
        batchId: '12-1',
        recipe: 'nip',
        reason: 'label',
        source: 'label',
      },
      { type: 'step.scheduled', ...ref, deadlineAt: '2026-10-21T13:00:00.000Z' },
      {
        type: 'step.started',
        ...ref,
        session: { id: '0f8fad5b-d9cb-469f-a165-70867728950e', worktree: join('/work', 'gauge-1') },
        worktree: {
          repo: 'acme/api',
          path: join('/work', 'gauge-1'),
          branch: 'foedrum/12-1/gauge/1',
          commit: 'c'.repeat(40),
        },
      },
    ];
    const plans = createAttemptPlans({
      state: () => fold(events),
      brewers: valid(loadRecipes(noFiles)).brewers,
      models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
      repoTools: () => [],
      clone: (repo) => join('/clones', repo),
      sandbox: false,
      workRoot: join('/root'),
      env: { base: { PATH: '/usr/bin' }, forced: {} },
      platform: 'linux',
      orderText: async () => 'Add a --json flag to status.',
      orderComments: async () => [],
      files: {
        read: () => ({ kind: 'missing' }),
        makeFolder: () => {},
      },
      random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    const { prompt } = await plans.plan({
      ref,
      limits: { outDoc: { file: 'gauge.md', schema: OutDocFrontmatter } },
    });
    assert.ok(
      prompt.includes(
        `source="lens diff/test-design, file defaults/lenses/diff/test-design.md" name="testDesign">\n${lens}\n</`,
      ),
      'the prompt does not hold the lens as an input',
    );
    assert.match(prompt, /source="issue #12 body" name="order">\nAdd a --json flag to status\.\n/);
  });
});

describe("a sub-order's plan entry in the default brewers' prompts (ADR 0290)", () => {
  const sessionId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const plan = {
    status: 'done',
    summary: 'Planned',
    assumptions: [],
    subOrders: [
      {
        id: 'api',
        title: 'A --json flag for status',
        repo: 'acme/api',
        size: { lines: 120, mechanism: 'one flag on one command' },
        doneWhen: 'status --json prints every batch as one JSON array',
        touches: [{ path: 'src/cli/status.ts' }, { path: 'test/unit/status.test.ts' }],
        recipe: 'nip',
        why: 'a test pins the output',
        ready: true,
      },
    ],
    alternatives: {
      considered: [{ cut: 'a new command', whyNot: 'status already lists the batches' }],
      whyThis: 'the smallest change that answers the order',
    },
  };
  // Batch 7-1 planned the order, and 12-1 brews its entry api, ordered from it.
  const parent: Event[] = [
    {
      type: 'batch.ordered',
      batchId: '7-1',
      order: { issue: 7 },
      routeBy: '2026-10-21T13:00:00.000Z',
    },
    {
      type: 'step.scheduled',
      batchId: '7-1',
      stepId: 'plan',
      attempt: 1,
      deadlineAt: '2026-10-21T13:00:00.000Z',
    },
    { type: 'step.started', batchId: '7-1', stepId: 'plan', attempt: 1 },
    {
      type: 'step.finished',
      batchId: '7-1',
      stepId: 'plan',
      attempt: 1,
      outcome: { kind: 'succeeded', output: plan },
    },
  ];
  const eventsOf = (stepId: string, subOrder: boolean): Event[] => {
    const ref = { batchId: '12-1', stepId, attempt: 1 };
    const path = join('/work', `${stepId}-1`);
    return [
      ...parent,
      {
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        routeBy: '2026-10-21T13:00:00.000Z',
        ...(subOrder
          ? {
              parentBatchId: '7-1',
              plan: { batchId: '7-1', stepId: 'plan', attempt: 1, entry: 'api' },
            }
          : {}),
      },
      {
        type: 'batch.recipe_chosen',
        batchId: '12-1',
        recipe: 'nip',
        reason: 'label',
        source: 'label',
      },
      // The Cellarman's batch skipped the Gauger, so its prompt holds no tests input.
      ...(stepId === 'implement'
        ? [
            {
              type: 'step.skipped',
              batchId: '12-1',
              stepId: 'gauge',
              when: 'recipe.testFirst',
            } satisfies Event,
          ]
        : []),
      { type: 'step.scheduled', ...ref, deadlineAt: '2026-10-21T13:00:00.000Z' },
      {
        type: 'step.started',
        ...ref,
        session: { id: sessionId, worktree: path },
        worktree: {
          repo: 'acme/api',
          path,
          branch: `foedrum/12-1/${stepId}/1`,
          commit: 'c'.repeat(40),
        },
      },
    ];
  };
  const defaults = () => valid(loadRecipes(noFiles)).brewers;
  /** The defaults' brewers with no plan entry input, as they were before ADR 0290. */
  const withoutEntry = () => {
    const brewers = defaults();
    return {
      find: (recipe: string, stepId: string) => {
        const found = brewers.find(recipe, stepId);
        if (found === undefined) return undefined;
        const inputs = found.brewer.inputs.filter(({ from }) => from !== 'plan-entry');
        return { ...found, brewer: { ...found.brewer, inputs } };
      },
      has: (recipe: string, stepId: string) => brewers.has(recipe, stepId),
    };
  };
  const promptOf = async (
    stepId: string,
    subOrder: boolean,
    brewers: ReturnType<typeof withoutEntry> = defaults(),
  ): Promise<string> => {
    const plans = createAttemptPlans({
      state: () => fold(eventsOf(stepId, subOrder)),
      brewers,
      models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
      repoTools: () => [],
      clone: (repo) => join('/clones', repo),
      sandbox: false,
      workRoot: join('/root'),
      env: { base: { PATH: '/usr/bin' }, forced: {} },
      platform: 'linux',
      orderText: async () => 'Add a --json flag to status.',
      orderComments: async () => [],
      // The Taster's change: one commit, no diff to show.
      git: async () => ({ code: 0, stdout: '', stderr: '' }),
      files: { read: () => ({ kind: 'missing' }), makeFolder: () => {} },
      random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    const ref = { batchId: '12-1', stepId, attempt: 1 };
    const { prompt } = await plans.plan({
      ref,
      limits: { outDoc: { file: 'out.md', schema: OutDocFrontmatter } },
    });
    return prompt;
  };
  const entry =
    /source="entry api of the plan of batch 7-1, step plan#1" name="planEntry">\n#### `api`: A --json flag for status\n[\s\S]*- Done when: status --json prints every batch as one JSON array\n[\s\S]*- src\/cli\/status\.ts\n[\s\S]*Chosen because: the smallest change that answers the order\n<\/untrusted-input-/;

  it("puts a sub-order's plan entry in its Gauger's prompt, which says what to do with it", async () => {
    const prompt = await promptOf('gauge', true);
    assert.match(prompt, entry);
    assert.match(prompt.split('## Untrusted input')[0] ?? '', /\{planEntry\}/);
  });

  it("puts a sub-order's plan entry in its acceptance Taster's prompt", async () => {
    assert.match(await promptOf('acceptance', true), entry);
  });

  it('the Cellarman of a sub-order gets its plan entry as an input', async () => {
    const prompt = await promptOf('implement', true);
    assert.match(prompt, entry);
    assert.match(prompt.split('## Untrusted input')[0] ?? '', /\{planEntry\}[^\n]*touches/);
  });

  it('gives the Cellarman of a batch that is no sub-order no planEntry input: regression test', async () => {
    const prompt = await promptOf('implement', false);
    assert.match(prompt, /name="order">\nAdd a --json flag to status\.\n/);
    assert.doesNotMatch(prompt, /name="planEntry"/);
  });

  it('gives a Cellarman whose recipe skipped the gauge step no tests input: regression test', async () => {
    const prompt = await promptOf('implement', true);
    assert.match(prompt, /name="order">\nAdd a --json flag to status\.\n/);
    assert.doesNotMatch(prompt, /name="tests"/);
  });

  it('gives an order that is no sub-order the Gauger and acceptance prompts it had without the input: regression test', async () => {
    for (const step of ['gauge', 'acceptance']) {
      const prompt = await promptOf(step, false);
      assert.equal(prompt, await promptOf(step, false, withoutEntry()), step);
      assert.doesNotMatch(prompt, /name="planEntry"/, step);
    }
  });
});

describe("the release a sub-order waited for in the default brewers' prompts (ADR 0291)", () => {
  const sessionId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const lib = 'https://github.com/acme/lib/pull/5';
  const routeBy = '2026-10-21T13:00:00.000Z';
  /** Order #1: #12 in acme/api waits for a release of #11's acme/lib, which pull request 5 merged. */
  const eventsOf = (stepId: string): Event[] => {
    const ref = { batchId: '12-1', stepId, attempt: 1 };
    const path = join('/work', `${stepId}-1`);
    return [
      { type: 'batch.ordered', batchId: '1-1', order: { issue: 1 }, routeBy },
      {
        type: 'order.decomposed',
        batchId: '1-1',
        subOrders: [
          { issue: 11, repo: 'acme/lib' },
          { issue: 12, repo: 'acme/api' },
        ],
        dependencies: [{ subOrder: 12, blockedBy: 11, kind: 'release' }],
      },
      { type: 'batch.on_tap', batchId: '1-1', pullRequests: [] },
      {
        type: 'batch.ordered',
        batchId: '11-1',
        order: { issue: 11 },
        parentBatchId: '1-1',
        routeBy,
      },
      { type: 'batch.on_tap', batchId: '11-1', pullRequests: [lib] },
      { type: 'pull_request.ended', batchId: '11-1', pullRequest: lib, state: 'merged' },
      { type: 'release.observed', repo: 'acme/lib', package: 'lib', version: 'lib@1.4.0' },
      {
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        parentBatchId: '1-1',
        routeBy,
      },
      {
        type: 'batch.recipe_chosen',
        batchId: '12-1',
        recipe: 'nip',
        reason: 'label',
        source: 'label',
      },
      { type: 'step.scheduled', ...ref, deadlineAt: routeBy },
      {
        type: 'step.started',
        ...ref,
        session: { id: sessionId, worktree: path },
        worktree: {
          repo: 'acme/api',
          path,
          branch: `foedrum/12-1/${stepId}/1`,
          commit: 'c'.repeat(40),
        },
      },
    ];
  };
  const brewers = () => valid(loadRecipes(noFiles)).brewers;
  const promptOf = async (stepId: string): Promise<string> => {
    const plans = createAttemptPlans({
      state: () => fold(eventsOf(stepId)),
      brewers: brewers(),
      models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
      repoTools: () => [],
      clone: (repo) => join('/clones', repo),
      sandbox: false,
      workRoot: join('/root'),
      env: { base: { PATH: '/usr/bin' }, forced: {} },
      platform: 'linux',
      orderText: async () => 'Use the new parser of acme/lib.',
      orderComments: async () => [],
      git: async () => ({ code: 0, stdout: '', stderr: '' }),
      files: { read: () => ({ kind: 'missing' }), makeFolder: () => {} },
      random: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    });
    const ref = { batchId: '12-1', stepId, attempt: 1 };
    const { prompt } = await plans.plan({
      ref,
      limits: { outDoc: { file: 'out.md', schema: OutDocFrontmatter } },
    });
    return prompt;
  };
  const release =
    /source="the releases sub-order #12 waited for: acme\/lib lib@1\.4\.0" name="release">\n#### The release of acme\/lib that #12 waited for\n- Tag, as written: lib@1\.4\.0\n/;

  it("puts the release in a release-blocked sub-order's Gauger prompt, which says to bump to it", async () => {
    const prompt = await promptOf('gauge');
    assert.match(prompt, release);
    assert.match(prompt.split('## Untrusted input')[0] ?? '', /\{release\}[^\n]*dependency/);
  });

  it("puts the release in a release-blocked sub-order's acceptance Taster prompt", async () => {
    assert.match(await promptOf('acceptance'), release);
  });

  it('gives the Cellarman the release input, and says to bump to it', () => {
    const found = brewers().find('nip', 'implement');
    assert.ok(found);
    assert.ok(found.brewer.inputs.some(({ from }) => from === 'release'));
    assert.match(found.instructions, /\{release\}[^\n]*dependency/);
  });
});

describe("the default Nip's round back to the Cellarman carries every Taster's finding (#938, ADR 0349)", () => {
  const blockingFinding = {
    file: 'src/wait.ts',
    line: 12,
    severity: 'major',
    why: 'waitForMerge polls with no deadline',
    introduced: true,
  } as const;
  const advisoryFinding = {
    file: 'src/status.ts',
    line: 40,
    severity: 'major',
    why: 'The order asks for --json; the flag added is --JSON',
    introduced: true,
  } as const;
  const tasted = (findings: readonly unknown[]) => {
    const { facts } = behave.succeed() as Extract<Behaviour, { kind: 'settle' }>;
    const verdict = findings.length === 0 ? 'approve' : 'changes';
    const doc = outDoc({ status: 'done', summary: 'Tasted', verdict, findings });
    return { behaviour: { kind: 'settle', facts: { ...facts, outDoc: doc } } as Behaviour, doc };
  };
  const dispositions = [
    { file: 'src/wait.ts', line: 12, disposition: 'fixed' },
    {
      step: 'acceptance',
      file: 'src/status.ts',
      line: 40,
      disposition: 'dismissed',
      why: "The order's second sentence asks for --JSON",
    },
  ];

  /**
   * Nip brewed with correctness asking for changes and acceptance advising one finding in the
   * first round, every Taster approving in the second, and what each attempt of `watched` saw.
   */
  const brewed = async (
    second: { correctness: Behaviour; acceptance: Behaviour },
    watched: (batch: Batch, ref: AttemptRef) => void,
    disposed: readonly unknown[] = dispositions,
  ) => {
    const store = openSqliteEventStore(':memory:');
    try {
      const done = behave.succeed();
      const { facts } = done as Extract<Behaviour, { kind: 'settle' }>;
      const fixed = outDoc({
        status: 'done',
        summary: 'Fixed',
        assumptions: [],
        dispositions: disposed,
      });
      const scripts: Record<string, Behaviour[]> = {
        survey: [done],
        'survey-check': [done],
        gauge: [done],
        red: [done],
        implement: [done, { kind: 'settle', facts: { ...facts, outDoc: fixed } }],
        fine: [done, done],
        green: [done, done],
        correctness: [tasted([blockingFinding]).behaviour, second.correctness],
        acceptance: [tasted([advisoryFinding]).behaviour, second.acceptance],
        security: [tasted([]).behaviour, tasted([]).behaviour],
        'design-conformance': [tasted([]).behaviour, tasted([]).behaviour],
        'open-pull-request': [done],
      };
      const { brewers, recipes } = valid(loadRecipes(noFiles));
      const brewing = createBrewing({
        store,
        runner: fakeBrewerRunner(({ ref }) => {
          const batch = fold(brewing.events()).batches.get('b1');
          assert.ok(batch !== undefined);
          watched(batch, ref);
          return scripts[ref.stepId]?.shift() ?? done;
        }),
        recipes,
        limits: (stepId) => {
          const found = brewers.find('nip', stepId);
          return found?.lens === undefined
            ? defaultLimits
            : attemptLimits(found.brewer, undefined, found.blocking, found.together);
        },
        clock: () => new Date('2026-11-08T12:00:00.000Z'),
      });
      assert.ok(brewing.command({ kind: 'order', batchId: 'b1', order: { issue: 1 } }));
      assert.ok(
        brewing.command({
          kind: 'route',
          batchId: 'b1',
          recipe: 'nip',
          reason: 'label',
          source: 'label',
        }),
      );
      await brewing.drive();
      return { events: [...brewing.events()], brewers };
    } finally {
      store.close();
    }
  };

  it("gives the Cellarman's second attempt correctness's findings and acceptance's advisory one, and the next round of each its disposition", async () => {
    const { brewers } = valid(loadRecipes(noFiles));
    const outDocOf = (id: string) => brewers.find('nip', id)?.brewer.output.doc;
    const groupOf = (id: string) => groupOfStep(brewers.find('nip', id));
    let told: PromptInput | undefined;
    const earlier = new Map<string, string>();
    const disposed = new Map<string, readonly unknown[]>();
    const correctnessDoc = tasted([blockingFinding]).doc;
    const { events } = await brewed(
      { correctness: tasted([]).behaviour, acceptance: tasted([]).behaviour },
      (batch, ref) => {
        if (ref.stepId === 'implement' && ref.attempt === 2) {
          const route = routeOf(batch, ref, outDocOf, undefined, groupOf);
          told =
            route === undefined
              ? undefined
              : routeInput(route, { kind: 'text', text: correctnessDoc });
        }
        if (ref.attempt === 2 && (ref.stepId === 'correctness' || ref.stepId === 'acceptance')) {
          const rounds = earlierRoundsOf(batch, ref, 'taste.md').filter(
            (round): round is EarlierRound => !('outDoc' in round),
          );
          earlier.set(ref.stepId, earlierFindingsInput(ref.stepId, rounds).text);
          disposed.set(ref.stepId, lensRounds(batch, ref.stepId)[0]?.dispositions ?? []);
        }
      },
    );
    const text = told?.text ?? '';
    assert.match(text, /^Step correctness ended: blocked \(findings\)/);
    assert.ok(text.includes(correctnessDoc), text);
    assert.match(
      text,
      /\nStep acceptance, through diff\/acceptance, advisory:\n- major in src\/status\.ts:40: The order asks for --json; the flag added is --JSON(\n|$)/,
    );
    // The fake runner keeps no worktree, so correctness's blocked round is read from the events.
    assert.deepEqual(disposed.get('correctness'), [dispositions[0]]);
    assert.deepEqual(disposed.get('acceptance'), [dispositions[1]]);
    assert.match(
      earlier.get('acceptance') ?? '',
      /src\/status\.ts:40: [^\n]*--JSON\n {2}dismissed: The order's second sentence asks for --JSON/,
    );
    const started = events.flatMap((event) =>
      event.type === 'step.started' ? [event.stepId] : [],
    );
    assert.equal(started.at(-1), 'open-pull-request');
  });

  it("goes on past acceptance's advisory changes alone, and counts correctness's rounds against its own route: regression test", async () => {
    const asks = tasted([advisoryFinding]).behaviour;
    const { events } = await brewed(
      { correctness: tasted([]).behaviour, acceptance: asks },
      () => {},
      // Correctness's finding only: an out doc any Foedrum reads.
      dispositions.slice(0, 1),
    );
    const routes = events.flatMap((event) =>
      event.type === 'step.scheduled' && event.route !== undefined
        ? [`${event.stepId}#${event.attempt} from ${event.route.from}`]
        : [],
    );
    // Acceptance asked for changes in both rounds; only correctness's first sent the batch back.
    assert.deepEqual(routes, ['implement#2 from correctness']);
    assert.equal(
      events.filter(
        (event) => event.type === 'step.started' && event.stepId === 'open-pull-request',
      ).length,
      1,
    );
  });
});
