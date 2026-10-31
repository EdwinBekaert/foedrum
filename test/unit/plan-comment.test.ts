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
import { planCommentOf, planEffects, renderPlan } from '../../src/engine/plan-comment.ts';
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
  it('says who changed the plan in a session without a time when it has none: regression test (#589)', () => {
    const changed = { by: 'ann', via: 'terminal' } as const;
    const text = renderPlan('7-1', 'lauter', three, undefined, undefined, true, undefined, changed);
    assert.match(text, /\nChanged in a session by ann \(terminal\)\.\n/);
  });

  const next =
    'Next: read the plan and its assumptions; sign it off with `foedrum approve 7-1`, correct it in a session with `foedrum lauter 7-1`, plan it again with `foedrum retry 7-1`, or end it with `foedrum cancel 7-1`. Its sub-orders become issues once #590 is built.';
  const outDoc = 'https://github.com/alice/brewery/blob/foedrum/state/batches/7-1/plan-2.md';

  it('shows a table of the sub-orders, a graph of their order and a section of each', () => {
    assert.equal(
      renderPlan('7-1', 'plan', three, undefined, undefined, true),
      [
        '### Foedrum · plan of batch `7-1`',
        '',
        '**Sub-orders**',
        '',
        '| Sub-order | Size | Recipe | Depends on | Ready |',
        '| --- | --- | --- | --- | --- |',
        '| `api`: Build api | about 300 lines | `tdd` | none | yes |',
        '| `ui`: Build ui | about 300 lines | `docs` | `api` (code) | yes |',
        '| `cli`: Build cli | about 300 lines | `tdd` | `api` (release) | no |',
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
        '#### `api`: Build api',
        '',
        '- Builds in acme/api: one endpoint, about 300 lines',
        '- Done when: GET /health answers 200',
        '- Recipe `tdd`: a test can pin it',
        '',
        '<details><summary>Touches 2 paths</summary>',
        '',
        '- src/server.ts',
        '- src/health.ts (new)',
        '',
        '</details>',
        '',
        '#### `ui`: Build ui',
        '',
        '- Builds in acme/web: one endpoint, about 300 lines',
        '- Done when: GET /health answers 200',
        '- Recipe `docs`: copy only; test-first off: documentation only',
        '',
        '<details><summary>Touches 1 path</summary>',
        '',
        '- src/server.ts',
        '',
        '</details>',
        '',
        '#### `cli`: Build cli',
        '',
        '- Builds in acme/api: one endpoint, about 300 lines',
        '- Done when: GET /health answers 200',
        '- Recipe `tdd`: a test can pin it',
        '- Not ready: the flags are open',
        '',
        '<details><summary>Touches 1 path</summary>',
        '',
        '- src/server.ts',
        '',
        '</details>',
        '',
        '**Review**',
        '',
        'None yet.',
        '',
        '**Gate**',
        '',
        'Waiting for `foedrum approve 7-1`.',
        '',
        next,
      ].join('\n'),
    );
  });

  it("opens with the link to the plan's out doc (#658)", () => {
    const text = renderPlan('7-1', 'plan', three, undefined, outDoc);
    assert.ok(
      text.startsWith(
        `### Foedrum · plan of batch \`7-1\`\n\nFull plan: <${outDoc}>\n\n**Sub-orders**\n`,
      ),
      text,
    );
    assert.equal(text.split(outDoc).length, 2, 'linked once');
  });

  it('shows the sub-orders in a table of five columns: sub-order, size, recipe, depends on, ready (#658)', () => {
    const lines = renderPlan('7-1', 'plan', three).split('\n');
    const header = lines.indexOf('| Sub-order | Size | Recipe | Depends on | Ready |');
    assert.ok(header > 0, lines.join('\n'));
    assert.equal(lines[header + 1], '| --- | --- | --- | --- | --- |');
    assert.equal(
      lines[header + 4],
      '| `cli`: Build cli | about 300 lines | `tdd` | `api` (release) | no |',
    );
  });

  it('shows a section of each sub-order, its touched paths folded in a details (#658)', () => {
    const text = renderPlan('7-1', 'plan', three);
    assert.match(
      text,
      /\n#### `api`: Build api\n\n- Builds in acme\/api: one endpoint, about 300 lines\n- Done when: GET \/health answers 200\n- Recipe `tdd`: a test can pin it\n\n<details><summary>Touches 2 paths<\/summary>\n\n- src\/server\.ts\n- src\/health\.ts \(new\)\n\n<\/details>\n/,
    );
    assert.match(text, /\n- Not ready: the flags are open\n/);
    assert.equal(text.split('<details>').length, 4, 'one details per sub-order');
  });

  it('shows no flowchart with one sub-order (#658)', () => {
    const text = renderPlan('7-1', 'plan', { subOrders: [subOrder('api')] });
    assert.doesNotMatch(text, /mermaid|\*\*Order\*\*/);
  });

  it('shows a flowchart with two sub-orders: regression test (#658)', () => {
    const text = renderPlan('7-1', 'plan', { subOrders: [subOrder('api'), subOrder('ui')] });
    assert.match(
      text,
      /\n\*\*Order\*\*\n\n```mermaid\nflowchart LR\n {2}s1\["api: Build api"\]\n {2}s2\["ui: Build ui"\]\n```\n/,
    );
  });

  it('ends with no next step when the plan does not wait for its review (#658)', () => {
    const text = renderPlan('7-1', 'plan', three, undefined, outDoc);
    assert.doesNotMatch(text, /Next:|foedrum retry/);
    assert.ok(text.endsWith('**Gate**\n\nNone yet.'), text.slice(-80));
  });

  it('says the gate waits for foedrum approve while the plan waits for its review (#588)', () => {
    const text = renderPlan('7-1', 'plan', three, undefined, outDoc, true);
    assert.ok(text.includes('\n\n**Gate**\n\nWaiting for `foedrum approve 7-1`.\n\n'), text);
  });

  it('says who approved the plan, from where and when, with no next step, once it is approved (#588)', () => {
    const approval = {
      stepId: 'plan',
      attempt: 2,
      plan: '0123456789abcdef',
      by: 'grace',
      via: 'plugin',
      at: '2026-10-28T10:30:00.000Z',
    } as const;
    const text = renderPlan('7-1', 'plan', three, undefined, outDoc, false, approval);
    assert.ok(
      text.endsWith(
        '**Gate**\n\nApproved by grace (plugin) at 2026-10-28T10:30:00.000Z.\n\nNot ready: `cli`.',
      ),
      text.slice(-120),
    );
    assert.doesNotMatch(text, /Next:|Waiting for/);
  });

  it('names the sub-orders that are not ready in the Gate section once the plan is approved (#588)', () => {
    const approval = {
      stepId: 'plan',
      attempt: 2,
      plan: '0123456789abcdef',
      by: 'grace',
      via: 'plugin',
      at: '2026-10-28T10:30:00.000Z',
    } as const;
    const four = { subOrders: [...three.subOrders, subOrder('docs', { ready: false })] };
    const text = renderPlan('7-1', 'plan', four, undefined, outDoc, false, approval);
    assert.ok(
      text.endsWith(
        '**Gate**\n\nApproved by grace (plugin) at 2026-10-28T10:30:00.000Z.\n\nNot ready: `cli`, `docs`.',
      ),
      text.slice(-160),
    );
  });

  it('ends with the next step (#658)', () => {
    assert.ok(renderPlan('7-1', 'plan', three, undefined, outDoc, true).endsWith(`\n\n${next}`));
  });

  it('shows a text with a quote, a hash, a line break, a mention and a backtick as itself, in the table and the graph', () => {
    const odd = {
      subOrders: [subOrder('api', { title: 'Say "hi" #1\n@alice ```end' }), subOrder('ui')],
    };
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
    const leaky = { subOrders: [subOrder('api', { title: `use ${token}` }), subOrder('ui')] };
    const text = renderPlan('7-1', 'plan', leaky);
    assert.doesNotMatch(text, new RegExp(token));
    assert.match(text, /`api`: \\\[left out: a text of step plan that looks like a secret\\\]/);
    assert.match(text, /s1\["api: \[left out: a text of step plan that looks like a secret\]"\]/);
  });

  it('leaves out an id, a dependency and a recipe that look like a secret', () => {
    // A long hexadecimal string that is no commit, which the secret scan reports (ADR 0088).
    const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const leaky = {
      subOrders: [
        subOrder(hex, { title: 'Build the API', recipe: hex }),
        subOrder('ui', { dependencies: [{ on: hex, kind: 'code' }] }),
      ],
    };
    const text = renderPlan('7-1', 'plan', leaky);
    assert.doesNotMatch(text, new RegExp(hex));
    assert.match(text, /^\| `\[left out: a text of step plan that looks like a secret\]`: Build/m);
    assert.match(text, /`\[left out: a text of step plan that looks like a secret\]` \(code\)/);
    assert.match(text, /s1\["\[left out: a text of step plan that looks like a secret\]: Build/);
  });

  it('leaves the graph out, and nothing else, when only the graph takes the text past its length', () => {
    // 100 sub-orders of about 560 characters fit; their 100 graph lines of about 130 do not.
    const many = Array.from({ length: 100 }, (_, i) =>
      subOrder(`s${i}`, { title: 'y'.repeat(120), doneWhen: 'x'.repeat(50), why: 'x'.repeat(50) }),
    );
    const text = renderPlan('7-1', 'plan', { subOrders: many }, undefined, undefined, true);
    assert.ok(text.length <= 60_000, `${text.length}`);
    assert.doesNotMatch(text, /```mermaid|rest is cut/);
    assert.match(text, /\*\*Order\*\*\n\nThe graph is left out: GitHub keeps comments shorter\.\n/);
    assert.match(text, /\*\*Gate\*\*\n\nWaiting for `foedrum approve 7-1`\.\n\nNext: /);
  });

  /** 100 sub-orders at the longest the schema takes: past GitHub's length even without the graph. */
  const longest = (): PlanReport => {
    const long = 'x'.repeat(300);
    return {
      subOrders: Array.from({ length: 100 }, (_, i) =>
        subOrder(`s${i}`, {
          title: long,
          doneWhen: long,
          why: long,
          touches: Array.from({ length: 20 }, (_, j) => ({ path: `${'d'.repeat(280)}/${j}` })),
        }),
      ),
    };
  };

  it("keeps the whole text within GitHub's length, cut after a whole sub-order", () => {
    const text = renderPlan('7-1', 'plan', longest(), undefined, undefined, true);
    assert.ok(text.length <= 60_000, `${text.length}`);
    assert.doesNotMatch(text, /```mermaid/);
    assert.match(
      text,
      /\n<\/details>\n\n… the rest is cut: GitHub keeps comments shorter\.\n\nNext: [^\n]+$/,
    );
  });

  it('leaves no details open where it cuts: regression test (#658)', () => {
    const text = renderPlan('7-1', 'plan', longest());
    assert.match(text, /rest is cut/);
    assert.equal(text.split('<details>').length, text.split('</details>').length);
  });

  it('keeps the link and the next step when the text is cut to length (#658)', () => {
    const text = renderPlan('7-1', 'plan', longest(), undefined, outDoc, true);
    assert.ok(text.length <= 60_000, `${text.length}`);
    assert.ok(text.startsWith(`### Foedrum · plan of batch \`7-1\`\n\nFull plan: <${outDoc}>\n\n`));
    assert.match(text, /… the rest is cut: GitHub keeps comments shorter\.\n\nNext: [^\n]+$/);
  });

  it('counts the link in the length, for a text that fits only without it: regression test (#659)', () => {
    const link = `\n\nFull plan: <${outDoc}>`;
    const sized = (n: number, extra: number): PlanReport => ({
      subOrders: Array.from({ length: n }, (_, i) =>
        subOrder(`s${i}`, { title: i === 0 ? 'y'.repeat(extra) : 'Build' }),
      ),
    });
    const length = (plan: PlanReport) => renderPlan('7-1', 'plan', plan).length;
    // A text past the limit comes back without its graph: the most sub-orders kept whole.
    const whole = (plan: PlanReport) => renderPlan('7-1', 'plan', plan).includes('```mermaid');
    let [n, over] = [2, 1_000];
    while (over - n > 1) {
      const middle = Math.floor((n + over) / 2);
      if (whole(sized(middle, 0))) n = middle;
      else over = middle;
    }
    // The shortest first title that brings the text within the link's length of the limit.
    let [short, long] = [-1, 200];
    while (long - short > 1) {
      const middle = Math.floor((short + long) / 2);
      const tried = sized(n, middle);
      if (!whole(tried) || length(tried) > 60_000 - link.length) long = middle;
      else short = middle;
    }
    const plan = sized(n, long);
    // Within the link's length of the limit: whole without it, too long with it.
    assert.ok(whole(plan));
    assert.ok(length(plan) + link.length > 60_000, `${length(plan)}`);
    const text = renderPlan('7-1', 'plan', plan, undefined, outDoc);
    assert.ok(text.length <= 60_000, `${text.length}`);
    assert.ok(text.includes(link), text.slice(0, 200));
  });

  it('cuts a table too long alone to whole rows, keeping the link and the next step: regression test (#658)', () => {
    // Ten dependencies of 40-character ids on each row take the table past the limit alone.
    const id = (i: number) => `s${String(i).padStart(3, '0')}-${'x'.repeat(34)}`;
    const many = Array.from({ length: 100 }, (_, i) =>
      subOrder(id(i), {
        title: 'y'.repeat(120),
        dependencies: Array.from({ length: Math.min(i, 10) }, (_, j) => ({
          on: id(j),
          kind: 'code' as const,
        })),
      }),
    );
    const text = renderPlan('7-1', 'plan', { subOrders: many }, undefined, outDoc, true);
    assert.ok(text.length <= 60_000, `${text.length}`);
    assert.doesNotMatch(text, /\n#### /);
    assert.ok(text.startsWith(`### Foedrum · plan of batch \`7-1\`\n\nFull plan: <${outDoc}>\n\n`));
    assert.match(
      text,
      /\n\| `s\d{3}-x+`: y+ \| [^\n]+ \|\n\n… the rest is cut: GitHub keeps comments shorter\.\n\nNext: [^\n]+$/,
    );
  });

  it('reads as before without a link: regression test (#659)', () => {
    assert.doesNotMatch(renderPlan('7-1', 'plan', three), /Full plan/);
  });
});

/** A fake of the comments host: the Brewery's own comments, ids from 1, and the writes it took. */
const fakeComments = () => {
  const comments: { id: number; repo: string; issue: number; body: string }[] = [];
  const calls: string[] = [];
  let ids = 0;
  const byId = (repo: string, id: number) => comments.find((c) => c.repo === repo && c.id === id);
  const host: StatusComments = {
    find: async (repo, issue, marker) =>
      comments.find((c) => c.repo === repo && c.issue === issue && c.body.endsWith(marker)),
    read: async (repo, id) => byId(repo, id)?.body,
    create: async (repo, issue, body) => {
      calls.push('create');
      ids += 1;
      comments.push({ id: ids, repo, issue, body });
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
  const recipes = fakeRecipes({
    mash: fakeRecipe({ steps: ['plan', 'replan'] }),
    // One plan step and no pull request: its plan waits for review (ADR 0275).
    pale: fakeRecipe({ steps: ['plan'], pullRequests: [] }),
  });
  let store: EventStore;
  let log: CommandLog;
  let comments: ReturnType<typeof fakeComments>;
  const drivers: Driver[] = [];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    comments = fakeComments();
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

  it('ends the comment with the next step while its batch waits Stuck for review: regression test (#658)', async () => {
    const driver = await open();
    issue({ kind: 'order', batchId: '7-1', order: { issue: 7 } });
    issue({ kind: 'route', batchId: '7-1', recipe: 'pale', reason: 'label', source: 'label' });
    step('plan', planned(three));
    assert.equal(log.state().batches.get('7-1')?.lane.kind, 'stuck');
    await driver.applyEffects();
    assert.equal(
      only().body,
      `${renderPlan('7-1', 'plan', three, undefined, undefined, true)}\n\n${marker(1)}`,
    );
    assert.match(only().body, /\n\nNext: read the plan/);
  });

  it('edits the plan comment once its plan is approved, to say by whom, with no next step (#588)', async () => {
    const driver = await open();
    issue({ kind: 'order', batchId: '7-1', order: { issue: 7 } });
    issue({ kind: 'route', batchId: '7-1', recipe: 'pale', reason: 'label', source: 'label' });
    step('plan', planned(three));
    await driver.applyEffects();
    assert.match(only().body, /\n\nWaiting for `foedrum approve 7-1`\.\n\nNext: /);
    issue({ kind: 'approve', batchId: '7-1', by: 'grace', via: 'terminal' });
    assert.equal(log.state().batches.get('7-1')?.lane.kind, 'on_tap');
    await driver.applyEffects();
    assert.ok(
      only().body.endsWith(
        `**Gate**\n\nApproved by grace (terminal) at ${at}.\n\nNot ready: \`cli\`.\n\n${marker(2)}`,
      ),
      only().body.slice(-200),
    );
  });

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
    assert.deepEqual(comments.calls, ['create', 'edit']);
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

  it("names the comment its batch's plan revision made: regression test (#656)", async () => {
    issue({ kind: 'order', batchId: '8-1', order: { issue: 8 } });
    issue({ kind: 'route', batchId: '8-1', recipe: 'mash', reason: 'label', source: 'label' });
    step('plan', planned(second), '8-1');
    order();
    step('plan', planned(three));
    const driver = await open();
    await driver.applyEffects();
    assert.equal(planCommentOf(log.state(), '7-1'), 2);
  });

  it("names the order's comment for a later batch whose own revision is not made yet: regression test (#656)", async () => {
    order();
    step('plan', planned(three));
    const driver = await open();
    await driver.applyEffects();
    order('7-2');
    step('plan', planned(second), '7-2');
    assert.equal(planCommentOf(log.state(), '7-2'), 1);
  });

  it('names no comment for a batch without a plan, though its order has one: regression test (#656)', async () => {
    order();
    step('plan', planned(three));
    const driver = await open();
    await driver.applyEffects();
    order('7-2');
    assert.equal(planCommentOf(log.state(), '7-2'), undefined);
  });

  it("never edits another order's comment: each order's plan is on its own issue (regression test)", async () => {
    order();
    step('plan', planned(three));
    issue({ kind: 'order', batchId: '8-1', order: { issue: 8 } });
    issue({ kind: 'route', batchId: '8-1', recipe: 'mash', reason: 'label', source: 'label' });
    step('plan', planned(second), '8-1');
    const driver = await open();
    await driver.applyEffects();
    assert.deepEqual(
      comments.comments.map(({ issue, body }) => [issue, body]),
      [
        [7, `${renderPlan('7-1', 'plan', three)}\n\n${marker(1)}`],
        [8, `${renderPlan('8-1', 'plan', second)}\n\n${marker(1, '8-1')}`],
      ],
    );
    assert.deepEqual(comments.calls, ['create', 'create']);
  });

  it("links the latest plan's own out doc on the state branch the driver was given (#659)", async () => {
    const stateBranchUrl = 'https://github.example/alice/brewery/blob/foedrum/state';
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => new Date(at),
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects: planEffects({ brewery, comments: comments.host, stateBranchUrl }),
      report: () => {},
    });
    drivers.push(driver);
    order();
    step('plan', planned(three));
    await driver.applyEffects();
    const link = (path: string) => `\n\nFull plan: <${stateBranchUrl}/batches/7-1/${path}>\n\n`;
    assert.ok(only().body.includes(link('plan-1.md')), only().body);
    step('replan', planned(second));
    await driver.applyEffects();
    assert.ok(only().body.includes(link('replan-1.md')), only().body);
    assert.ok(only().body.endsWith(`\n\n${marker(2)}`), only().body);
  });

  it('links the attempt of the plan that succeeded, not the one before it: regression test (#659)', async () => {
    const stateBranchUrl = 'https://github.example/alice/brewery/blob/foedrum/state';
    const driver = await openDriver({
      store,
      runner: { start: () => assert.fail('no attempt starts'), progress: () => undefined },
      recipes,
      clock: () => new Date(at),
      lock: () => fakeLock('cellar'),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: () => defaultLimits,
      effects: planEffects({ brewery, comments: comments.host, stateBranchUrl }),
      report: () => {},
    });
    drivers.push(driver);
    order();
    const first = { batchId: '7-1', stepId: 'plan', attempt: 1 };
    issue({ kind: 'record', event: { type: 'step.started', ...first } });
    const lost: Ending = { kind: 'failed', retryable: true, reason: 'the session ended' };
    issue({ kind: 'finish', ...first, ending: lost });
    const retried = { ...first, attempt: 2 };
    issue({ kind: 'record', event: { type: 'step.started', ...retried } });
    issue({ kind: 'finish', ...retried, ending: planned(three) });
    await driver.applyEffects();
    const link = `\n\nFull plan: <${stateBranchUrl}/batches/7-1/plan-2.md>\n\n`;
    assert.ok(only().body.includes(link), only().body);
  });
});
