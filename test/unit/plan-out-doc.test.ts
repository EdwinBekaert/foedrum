import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readOutDoc } from '../../src/schemas/out-doc.ts';
import { PlanOutDoc, planOf } from '../../src/schemas/plan.ts';

const outDoc = (frontmatter: unknown): string =>
  `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n# Plan\n`;

const subOrder = (id: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({
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

  const without = (field: string) => {
    const { [field]: _, ...rest } = subOrder('api');
    return rest;
  };
  const many = Array.from({ length: 101 }, (_, i) => subOrder(`s${i}`));
  const chain = (first: unknown[]) => [
    subOrder('a', { dependencies: first }),
    subOrder('b', { dependencies: [{ on: 'a', kind: 'release' }] }),
    subOrder('c', { dependencies: [{ on: 'b', kind: 'code' }] }),
  ];
  // Each refused plan, and the path its reason names.
  const refusals: [string, unknown, RegExp][] = [
    ['a done plan without sub-orders', { status: 'done', summary: 'None' }, /subOrders/],
    ['a done plan with no sub-order', done([]), /subOrders/],
    ...['id', 'title', 'repo', 'size', 'doneWhen', 'touches', 'recipe', 'why', 'ready'].map(
      (field): [string, unknown, RegExp] => [
        `a sub-order without its ${field}`,
        done([without(field)]),
        new RegExp(`subOrders\\[0\\]\\.${field}`),
      ],
    ),
    [
      'a size without its lines',
      done([subOrder('api', { size: { mechanism: 'one endpoint' } })]),
      /subOrders\[0\]\.size\.lines/,
    ],
    [
      'a size without its mechanism',
      done([subOrder('api', { size: { lines: 10 } })]),
      /subOrders\[0\]\.size\.mechanism/,
    ],
    ...['/etc/passwd', '../up.ts', 'src/*.ts', 'src\\a.ts'].map(
      (path): [string, unknown, RegExp] => [
        `a touch of ${path}`,
        done([subOrder('api', { touches: [{ path }] })]),
        /subOrders\[0\]\.touches\[0\]\.path/,
      ],
    ),
    ['no touch', done([subOrder('api', { touches: [] })]), /subOrders\[0\]\.touches/],
    [
      'a text of two lines',
      done([subOrder('api', { doneWhen: 'a\nb' })]),
      /subOrders\[0\]\.doneWhen/,
    ],
    ['an id that is no plain name', done([subOrder('API one')]), /subOrders\[0\]\.id/],
    [
      'testFirst false without a reason',
      done([subOrder('docs', { testFirst: false })]),
      /subOrders\[0\]\.testFirstOff/,
    ],
    [
      'ready false without the reason it needs refining',
      done([subOrder('api', { ready: false })]),
      /subOrders\[0\]\.refinement/,
    ],
    ['two sub-orders with one id', done([subOrder('api'), subOrder('api')]), /subOrders\[1\]\.id/],
    [
      'a dependency on an unknown id',
      done([subOrder('api'), subOrder('ui', { dependencies: [{ on: 'nowhere', kind: 'code' }] })]),
      /subOrders\[1\]\.dependencies\[0\]\.on/,
    ],
    [
      'a dependency on itself',
      done([subOrder('api', { dependencies: [{ on: 'api', kind: 'code' }] })]),
      /subOrders\[0\]\.dependencies\[0\]\.on/,
    ],
    [
      'a dependency named twice',
      done([
        subOrder('api'),
        subOrder('ui', {
          dependencies: [
            { on: 'api', kind: 'code' },
            { on: 'api', kind: 'release' },
          ],
        }),
      ]),
      /subOrders\[1\]\.dependencies\[1\]\.on/,
    ],
    ['dependencies that form a cycle', done(chain([{ on: 'c', kind: 'code' }])), /cycle/],
    [
      'a kind of dependency other than code or release',
      done([subOrder('api'), subOrder('ui', { dependencies: [{ on: 'api', kind: 'merge' }] })]),
      /subOrders\[1\]\.dependencies\[0\]\.kind/,
    ],
    ['more than 100 sub-orders', done(many), /subOrders/],
    // Regression tests (review of #607): each bound, just past it.
    ['an id of 41 characters', done([subOrder('a'.repeat(41))]), /subOrders\[0\]\.id/],
    ['an id that starts with "-"', done([subOrder('-api')]), /subOrders\[0\]\.id/],
    ['an id that ends with "-"', done([subOrder('api-')]), /subOrders\[0\]\.id/],
    [
      'a title of 121 characters',
      done([subOrder('api', { title: 't'.repeat(121) })]),
      /subOrders\[0\]\.title/,
    ],
    [
      'a line of 301 characters',
      done([subOrder('api', { why: 'w'.repeat(301) })]),
      /subOrders\[0\]\.why/,
    ],
    [
      'a path of 301 characters',
      done([subOrder('api', { touches: [{ path: 'p'.repeat(301) }] })]),
      /subOrders\[0\]\.touches\[0\]\.path/,
    ],
    [
      '21 touches',
      done([
        subOrder('api', { touches: Array.from({ length: 21 }, (_, i) => ({ path: `f${i}` })) }),
      ]),
      /subOrders\[0\]\.touches/,
    ],
    [
      'a size of 0 lines',
      done([subOrder('api', { size: { lines: 0, mechanism: 'none' } })]),
      /subOrders\[0\]\.size\.lines/,
    ],
    [
      'testFirst true',
      done([subOrder('api', { testFirst: true, testFirstOff: 'why' })]),
      /subOrders\[0\]\.testFirst/,
    ],
    [
      'no alternative considered',
      done([subOrder('api')], { alternatives: { considered: [], whyThis: 'one' } }),
      /alternatives\.considered/,
    ],
    [
      '11 alternatives',
      done([subOrder('api')], {
        alternatives: {
          considered: Array.from({ length: 11 }, (_, i) => ({ cut: `cut ${i}`, whyNot: 'no' })),
          whyThis: 'one',
        },
      }),
      /alternatives\.considered/,
    ],
    [
      'more than 1,000 dependencies',
      // Each sub-order waits for up to 11 before it: 1,034 in all, and no cycle.
      done(
        Array.from({ length: 100 }, (_, i) =>
          subOrder(`s${i}`, {
            dependencies: Array.from({ length: Math.min(i, 11) }, (_, j) => ({
              on: `s${i - j - 1}`,
              kind: 'code',
            })),
          }),
        ),
      ),
      /1000 dependencies/,
    ],
  ];
  for (const [what, frontmatter, path] of refusals) {
    it(`refuses ${what}, naming the field`, () => {
      assert.match(refused(frontmatter) ?? '', path);
    });
  }

  it('takes testFirst false and ready false with their reasons, a chain, and 100 sub-orders', () => {
    const reasoned = subOrder('docs', {
      testFirst: false,
      testFirstOff: 'documentation only',
      ready: false,
      refinement: 'the API shape is open',
    });
    assert.equal(refused(done([reasoned])), undefined);
    assert.equal(refused(done(chain([]))), undefined);
    // Regression test (review of #607): two sub-orders may wait for the same one.
    const fanOut = [
      subOrder('api'),
      subOrder('ui', { dependencies: [{ on: 'api', kind: 'code' }] }),
      subOrder('docs', { dependencies: [{ on: 'api', kind: 'code' }] }),
    ];
    assert.equal(refused(done(fanOut)), undefined);
    assert.equal(refused(done(many.slice(0, 100))), undefined);
  });

  it('takes each bound at its limit (regression test)', () => {
    const atLimits = subOrder('a'.repeat(40), {
      title: 't'.repeat(120),
      why: 'w'.repeat(300),
      size: { lines: 1, mechanism: 'one' },
      touches: [
        { path: 'p'.repeat(300) },
        ...Array.from({ length: 19 }, (_, i) => ({ path: `f${i}` })),
      ],
    });
    const alternatives = {
      considered: Array.from({ length: 10 }, (_, i) => ({ cut: `cut ${i}`, whyNot: 'no' })),
      whyThis: 'one',
    };
    assert.equal(refused(done([atLimits], { alternatives })), undefined);
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
