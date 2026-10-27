import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readOutDoc } from '../../src/schemas/out-doc.ts';
import { PlanOutDoc, planOf } from '../../src/schemas/plan.ts';

const outDoc = (frontmatter: unknown): string =>
  `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n# Plan\n`;

const subOrder = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  title: `Build ${id}`,
  repo: 'acme/api',
  size: { lines: 300, mechanism: 'one endpoint and its handler' },
  doneWhen: 'GET /health answers 200',
  touches: [{ path: 'src/server.ts' }, { path: 'src/health.ts', new: true }],
  dependencies: [],
  recipe: 'tdd',
  why: 'a behaviour a test can pin',
  ready: true,
  ...more,
});

const done = (subOrders: unknown[], more: Record<string, unknown> = {}) => ({
  status: 'done',
  summary: 'Three sub-orders',
  assumptions: [],
  subOrders,
  ...more,
});

/** Why the out doc is invalid, or undefined when it reads. */
const refused = (frontmatter: unknown): string | undefined => {
  const read = readOutDoc(outDoc(frontmatter), PlanOutDoc);
  return read.valid ? undefined : read.reason;
};

describe('PlanOutDoc (ADR 0233)', () => {
  it('reads a done plan with every field, and its alternatives', () => {
    const plan = done([subOrder('api'), subOrder('ui', { repo: 'acme/web' })], {
      alternatives: {
        considered: [{ cut: 'one pull request', whyNot: 'over 2,000 lines' }],
        whyThis: 'each half merges on its own',
      },
    });
    const read = readOutDoc(outDoc(plan), PlanOutDoc);
    assert.equal(read.valid, true);
    assert.deepEqual(read.valid && read.frontmatter, plan);
  });

  it('reads a needs_input plan without sub-orders', () => {
    const question = {
      q: 'One repository or two?',
      options: ['one', 'two'],
      recommended: 'two',
      whyBlocking: 'The cut depends on it',
    };
    const asking = { status: 'needs_input', summary: 'Unsure', questions: [question] };
    assert.equal(refused(asking), undefined);
  });

  it('refuses a done plan without sub-orders', () => {
    const { subOrders: _, ...none } = done([]);
    assert.match(refused(none) ?? '', /subOrders/);
    assert.match(refused(done([])) ?? '', /subOrders/);
  });

  for (const field of [
    'id',
    'title',
    'repo',
    'size',
    'doneWhen',
    'touches',
    'recipe',
    'why',
    'ready',
  ]) {
    it(`refuses a done sub-order without its ${field}, naming it`, () => {
      const { [field]: _, ...without } = subOrder('api');
      assert.match(refused(done([without])) ?? '', new RegExp(`subOrders\\[0\\]\\.${field}`));
    });
  }

  it('refuses a size without its lines or its mechanism, and a touch that is no relative path', () => {
    const noLines = subOrder('api', { size: { mechanism: 'one endpoint' } });
    assert.match(refused(done([noLines])) ?? '', /subOrders\[0\]\.size\.lines/);
    const noMechanism = subOrder('api', { size: { lines: 10 } });
    assert.match(refused(done([noMechanism])) ?? '', /subOrders\[0\]\.size\.mechanism/);
    for (const path of ['/etc/passwd', '../up.ts', 'src/*.ts', 'src\\a.ts']) {
      const touching = subOrder('api', { touches: [{ path }] });
      assert.match(refused(done([touching])) ?? '', /subOrders\[0\]\.touches\[0\]\.path/, path);
    }
    assert.match(
      refused(done([subOrder('api', { touches: [] })])) ?? '',
      /subOrders\[0\]\.touches/,
    );
  });

  it('refuses a text of two lines and an id that is no plain name', () => {
    assert.match(
      refused(done([subOrder('api', { doneWhen: 'a\nb' })])) ?? '',
      /subOrders\[0\]\.doneWhen/,
    );
    assert.match(refused(done([subOrder('API one')])) ?? '', /subOrders\[0\]\.id/);
  });

  it('refuses testFirst false without a reason, and takes it with one', () => {
    const off = subOrder('docs', { testFirst: false });
    assert.match(refused(done([off])) ?? '', /subOrders\[0\]\.testFirstOff/);
    const reasoned = subOrder('docs', { testFirst: false, testFirstOff: 'documentation only' });
    assert.equal(refused(done([reasoned])), undefined);
  });

  it('refuses ready false without the reason it needs refining', () => {
    const unready = subOrder('api', { ready: false });
    assert.match(refused(done([unready])) ?? '', /subOrders\[0\]\.refinement/);
    const reasoned = subOrder('api', { ready: false, refinement: 'the API shape is open' });
    assert.equal(refused(done([reasoned])), undefined);
  });

  it('refuses two sub-orders with one id', () => {
    assert.match(refused(done([subOrder('api'), subOrder('api')])) ?? '', /subOrders\[1\]\.id/);
  });

  it('refuses a dependency on an unknown id, naming it', () => {
    const waiting = subOrder('ui', { dependencies: [{ on: 'nowhere', kind: 'code' }] });
    assert.match(
      refused(done([subOrder('api'), waiting])) ?? '',
      /subOrders\[1\]\.dependencies\[0\]\.on/,
    );
  });

  it('refuses a dependency on itself', () => {
    const self = subOrder('api', { dependencies: [{ on: 'api', kind: 'code' }] });
    assert.match(refused(done([self])) ?? '', /subOrders\[0\]\.dependencies\[0\]\.on/);
  });

  it('refuses dependencies that form a cycle, and takes a chain', () => {
    const a = subOrder('a', { dependencies: [{ on: 'c', kind: 'code' }] });
    const b = subOrder('b', { dependencies: [{ on: 'a', kind: 'release' }] });
    const c = subOrder('c', { dependencies: [{ on: 'b', kind: 'code' }] });
    assert.match(refused(done([a, b, c])) ?? '', /cycle/);
    const first = subOrder('a');
    assert.equal(refused(done([first, b, c])), undefined);
  });

  it('refuses a kind of dependency other than code or release', () => {
    const waiting = subOrder('ui', { dependencies: [{ on: 'api', kind: 'merge' }] });
    assert.match(
      refused(done([subOrder('api'), waiting])) ?? '',
      /subOrders\[1\]\.dependencies\[0\]\.kind/,
    );
  });

  it('refuses more than 100 sub-orders', () => {
    const many = Array.from({ length: 101 }, (_, i) => subOrder(`s${i}`));
    assert.match(refused(done(many)) ?? '', /subOrders/);
    assert.equal(refused(done(many.slice(0, 100))), undefined);
  });
});

describe('planOf (ADR 0233)', () => {
  it("gives a done plan's sub-orders and alternatives, and nothing for another out doc", () => {
    const alternatives = { considered: [{ cut: 'one', whyNot: 'too big' }], whyThis: 'halves' };
    const plan = done([subOrder('api')], { alternatives });
    assert.deepEqual(planOf(plan), { subOrders: [subOrder('api')], alternatives });
    assert.deepEqual(planOf(done([subOrder('api')])), { subOrders: [subOrder('api')] });
    assert.equal(planOf({ status: 'done', summary: 'Fixed', assumptions: [] }), undefined);
    assert.equal(planOf(undefined), undefined);
  });
});
