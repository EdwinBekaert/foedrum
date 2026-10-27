// The plan comment of an order (ADR 0233): its text rendered from a plan alone, and its revisions
// applied through the ledger by a driver, with a fake of the comments host. Nothing reaches GitHub
// (ADR 0021).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { effectMarker } from '../../src/engine/claim-effects.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import { type Driver, openDriver } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { planEffects, renderPlan } from '../../src/engine/plan-comment.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { StatusComments } from '../../src/engine/status-comment.ts';
import type { PlannedSubOrder, PlanReport } from '../../src/schemas/plan.ts';
import { defaultLimits } from '../helpers/brewing.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

// Built at run time, so no scanner takes this file for one that holds a token.
const token = ['ghp', 'A1b2'.repeat(9)].join('_');

const subOrder = (id: string, more: Partial<PlannedSubOrder> = {}): PlannedSubOrder => ({
  id,
  title: `Build ${id}`,
  repo: 'acme/api',
  size: { lines: 300, mechanism: 'one endpoint' },
  doneWhen: 'GET /health answers 200',
  touches: [{ path: 'src/server.ts' }],
  dependencies: [],
  recipe: 'tdd',
  why: 'a test can pin it',
  ready: true,
  ...more,
});

/** Three sub-orders: `ui` waits for `api`'s code, `cli` for its release. */
const three: PlanReport = {
  subOrders: [
    subOrder('api', { touches: [{ path: 'src/server.ts' }, { path: 'src/health.ts', new: true }] }),
    subOrder('ui', {
      repo: 'acme/web',
      dependencies: [{ on: 'api', kind: 'code' }],
      recipe: 'docs',
      why: 'copy only',
      testFirst: false,
      testFirstOff: 'documentation only',
    }),
    subOrder('cli', {
      dependencies: [{ on: 'api', kind: 'release' }],
      ready: false,
      refinement: 'the flags are open',
    }),
  ],
};

describe('renderPlan (ADR 0233)', () => {
  it('shows a table of the sub-orders and a graph of their order', () => {
    assert.equal(
      renderPlan('7-1', 'plan', three),
      [
        '### Foedrum · plan of batch `7-1`',
        '',
        '**Sub-orders**',
        '',
        '| Sub-order | Repository | Size | Done when | Touches | Depends on | Recipe | Ready |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        '| `api`: Build api | acme/api | about 300 lines: one endpoint | GET /health answers 200 | src/server.ts, src/health.ts (new) | none | `tdd`: a test can pin it | yes |',
        '| `ui`: Build ui | acme/web | about 300 lines: one endpoint | GET /health answers 200 | src/server.ts | `api` (code) | `docs`: copy only; test-first off: documentation only | yes |',
        '| `cli`: Build cli | acme/api | about 300 lines: one endpoint | GET /health answers 200 | src/server.ts | `api` (release) | `tdd`: a test can pin it | no: the flags are open |',
        '',
        '**Order**',
        '',
        '```mermaid',
        'flowchart LR',
        '  s1["api: Build api"]',
        '  s2["ui: Build ui"]',
        '  s3["cli: Build cli"]',
        '  s1 -->|"code"| s2',
        '  s1 -->|"release"| s3',
        '```',
        '',
        '**Review**',
        '',
        'None yet.',
        '',
        '**Gate**',
        '',
        'None yet.',
      ].join('\n'),
    );
  });

  it('shows a text with a quote, a hash, a line break, a mention and a backtick as itself, in the table and the graph', () => {
    const odd = { subOrders: [subOrder('api', { title: 'Say "hi" #1\n@alice ```end' })] };
    const text = renderPlan('7-1', 'plan', odd);
    assert.match(text, /\| `api`: Say "hi" \\#1 &#64;alice \\`\\`\\`end \|/);
    assert.match(text, /\n {2}s1\["api: Say #quot;hi#quot; #35;1 @alice #96;#96;#96;end"\]\n/);
    // The graph's block ends only where Foedrum ends it.
    assert.equal(text.split('```').length, 3);
  });

  it('shows the alternatives when the plan has them, and no section without', () => {
    const alternatives = {
      considered: [
        { cut: 'one pull request', whyNot: 'over 2,000 lines' },
        { cut: 'by layer', whyNot: 'nothing merges alone' },
      ],
      whyThis: 'each sub-order merges on its own',
    };
    const text = renderPlan('7-1', 'plan', { ...three, alternatives });
    assert.match(
      text,
      /\n\*\*Alternatives\*\*\n\n- one pull request: over 2,000 lines\n- by layer: nothing merges alone\n\nChosen because: each sub-order merges on its own\n\n\*\*Review\*\*/,
    );
    assert.doesNotMatch(renderPlan('7-1', 'plan', three), /Alternatives/);
  });

  it('leaves out a text that looks like a secret, in the table and the graph', () => {
    const leaky = { subOrders: [subOrder('api', { title: `use ${token}` })] };
    const text = renderPlan('7-1', 'plan', leaky);
    assert.doesNotMatch(text, new RegExp(token));
    assert.match(text, /`api`: \\\[left out: a text of step plan that looks like a secret\\\]/);
    assert.match(text, /s1\["api: \[left out: a text of step plan that looks like a secret\]"\]/);
  });

  it("keeps the whole text within GitHub's length, cut at a whole line", () => {
    const long = 'x'.repeat(300);
    const many = Array.from({ length: 100 }, (_, i) =>
      subOrder(`s${i}`, {
        title: long,
        doneWhen: long,
        why: long,
        touches: Array.from({ length: 20 }, (_, j) => ({ path: `${'d'.repeat(280)}/${j}` })),
      }),
    );
    const text = renderPlan('7-1', 'plan', { subOrders: many });
    assert.ok(text.length <= 60_000, `${text.length}`);
    assert.match(text, /… the rest is cut: GitHub keeps comments shorter\.$/);
  });
});

/** A fake of the comments host: the comments of every issue, ids from 1, as `login` sees them. */
const fakeComments = (login: string) => {
  const comments: { id: number; repo: string; issue: number; author: string; body: string }[] = [];
  const calls: string[] = [];
  let ids = 0;
  const byId = (repo: string, id: number) =>
    comments.find((comment) => comment.repo === repo && comment.id === id);
  const host: StatusComments = {
    find: async (repo, issue, marker) => {
      calls.push('find');
      const found = comments.find(
        (comment) =>
          comment.repo === repo &&
          comment.issue === issue &&
          comment.author === login &&
          comment.body.endsWith(marker),
      );
      return found === undefined ? undefined : { id: found.id, body: found.body };
    },
    read: async (repo, id) => {
      calls.push('read');
      const found = byId(repo, id);
      return found?.author === login ? found.body : undefined;
    },
    create: async (repo, issue, body) => {
      calls.push('create');
      ids += 1;
      comments.push({ id: ids, repo, issue, author: login, body });
      return ids;
    },
    edit: async (repo, id, body) => {
      calls.push('edit');
      const found = byId(repo, id);
      if (found === undefined) return 'gone';
      found.body = body;
      return 'edited';
    },
  };
  return { host, comments, calls };
};

const brewery = 'alice/brewery';
const at = '2026-10-27T09:00:00.000Z';
const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);
const marker = (revision: number, batchId = '7-1'): string =>
  effectMarker(effectKey.encode({ batchId, effect: `plan.${revision}` }));
const planned = (plan: PlanReport): Ending => ({
  kind: 'succeeded',
  // Through JSON, as the event log keeps an outcome.
  output: JSON.parse(
    JSON.stringify({ status: 'done', summary: 'A plan', assumptions: [], ...plan }),
  ),
});
const second: PlanReport = { subOrders: [subOrder('api'), subOrder('docs')] };

describe('planEffects (ADR 0233)', () => {
  const recipes = fakeRecipes({ mash: fakeRecipe({ steps: ['plan', 'replan'] }) });
  let store: EventStore;
  let log: CommandLog;
  let comments: ReturnType<typeof fakeComments>;
  const drivers: Driver[] = [];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    comments = fakeComments('alice');
  });
  afterEach(() => {
    for (const driver of drivers.splice(0)) driver.close();
    store.close();
  });

  const open = async (): Promise<Driver> => {
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => new Date(at),
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects: planEffects({ brewery, comments: comments.host }),
      report: () => {},
    });
    drivers.push(driver);
    return driver;
  };
  const issue = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = log.issue(command, new Date(at));
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  const order = (batchId = '7-1'): void => {
    issue({ kind: 'order', batchId, order: { issue: 7 } });
    issue({ kind: 'route', batchId, recipe: 'mash', reason: 'label', source: 'label' });
  };
  /** Runs `stepId` of `batchId` once, ending as `ending`. */
  const step = (stepId: string, ending: Ending, batchId = '7-1'): void => {
    const ref = { batchId, stepId, attempt: 1 };
    issue({ kind: 'record', event: { type: 'step.started', ...ref } });
    issue({ kind: 'finish', ...ref, ending });
  };
  const revision = (n: number, batchId = '7-1') =>
    store.findEffect({ batchId, effect: `plan.${n}` });
  const only = () => {
    assert.equal(comments.comments.length, 1, 'one plan comment');
    return comments.comments[0] ?? assert.fail();
  };

  it('makes no comment before a plan succeeded, nor for a plan that asks a question', async () => {
    order();
    const driver = await open();
    await driver.applyEffects();
    const question = { q: 'Two?', options: ['one', 'two'], recommended: 'two', whyBlocking: 'cut' };
    issue({
      kind: 'record',
      event: { type: 'step.started', batchId: '7-1', stepId: 'plan', attempt: 1 },
    });
    issue({
      kind: 'finish',
      batchId: '7-1',
      stepId: 'plan',
      attempt: 1,
      ending: { kind: 'needs_input', questions: [question] },
    });
    await driver.applyEffects();
    assert.deepEqual(comments.comments, []);
  });

  it("comments the plan on the order's issue, ending with its revision's marker, and records the digest", async () => {
    order();
    step('plan', planned(three));
    const driver = await open();
    await driver.applyEffects();
    const comment = only();
    assert.equal(comment.repo, brewery);
    assert.equal(comment.issue, 7);
    assert.equal(comment.body, `${renderPlan('7-1', 'plan', three)}\n\n${marker(1)}`);
    assert.deepEqual(revision(1), {
      result: { comment: 1, digest: digest(renderPlan('7-1', 'plan', three)) },
    });
  });

  it("edits the same comment for a later round's plan, and nothing while the plan is unchanged", async () => {
    order();
    step('plan', planned(three));
    const driver = await open();
    await driver.applyEffects();
    await driver.applyEffects();
    assert.equal(revision(2), undefined);
    step('replan', planned(second));
    await driver.applyEffects();
    assert.equal(only().body, `${renderPlan('7-1', 'replan', second)}\n\n${marker(2)}`);
    assert.deepEqual(
      comments.calls.filter((call) => call !== 'read' && call !== 'find'),
      ['create', 'edit'],
    );
  });

  it('makes the comment again when it was deleted by hand', async () => {
    order();
    step('plan', planned(three));
    const driver = await open();
    await driver.applyEffects();
    comments.comments.splice(0);
    step('replan', planned(second));
    await driver.applyEffects();
    const comment = only();
    assert.equal(comment.id, 2);
    assert.ok(comment.body.endsWith(marker(2)));
    assert.deepEqual(revision(2)?.result, {
      comment: 2,
      digest: digest(renderPlan('7-1', 'replan', second)),
    });
  });

  it('finds an edit a run before made and was killed before it recorded, by its marker, and edits nothing twice', async () => {
    order();
    step('plan', planned(three));
    const driver = await open();
    await driver.applyEffects();
    step('replan', planned(second));
    // A run that was killed had edited the comment to revision 2 and recorded nothing.
    only().body = `${renderPlan('7-1', 'replan', second)}\n\n${marker(2)}`;
    await driver.applyEffects();
    assert.deepEqual(revision(2), {
      result: { comment: 1, digest: digest(renderPlan('7-1', 'replan', second)) },
    });
    assert.equal(comments.calls.includes('edit'), false);
    await driver.applyEffects();
    assert.equal(revision(3), undefined);
  });

  it("edits the order's comment from a later batch of the same order, so it never shows two plans", async () => {
    order();
    step('plan', planned(three));
    step('replan', planned(three));
    const driver = await open();
    await driver.applyEffects();
    order('7-2');
    step('plan', planned(second), '7-2');
    await driver.applyEffects();
    assert.equal(only().body, `${renderPlan('7-2', 'plan', second)}\n\n${marker(1, '7-2')}`);
    assert.deepEqual(revision(1, '7-2')?.result, {
      comment: 1,
      digest: digest(renderPlan('7-2', 'plan', second)),
    });
  });
});
