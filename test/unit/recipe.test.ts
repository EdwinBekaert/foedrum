import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readJsonc } from '../../src/schemas/read.ts';
import {
  DefaultRecipe,
  Recipe,
  Step,
  type StepKind,
  stepId,
  stepKind,
} from '../../src/schemas/recipe.ts';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'recipes');

const recipe = (steps: unknown[], fields: Record<string, unknown> = {}) => ({
  name: 'test-recipe',
  description: 'A recipe for tests',
  steps,
  ...fields,
});

const plan = { id: 'plan', brewer: 'brewmaster' };
const gauge = { id: 'gauge', brewer: 'gauger' };
const tasting = {
  id: 'tasting',
  parallel: [{ id: 'correctness', brewer: 'taster', lens: 'correctness' }],
};

const accepted = (value: unknown): boolean => Recipe.safeParse(value).success;

describe('Recipe', () => {
  describe('the serving-volume recipes (#44)', () => {
    const files = readdirSync(fixtures).filter((name) => name.endsWith('.jsonc'));
    for (const file of files) {
      it(`accepts ${file} as a recipe and as a default recipe`, () => {
        const text = readFileSync(join(fixtures, file), 'utf8');
        for (const schema of [Recipe, DefaultRecipe]) {
          const result = readJsonc(text, schema);
          assert.equal(result.valid, true, result.valid ? '' : result.reason);
        }
      });
    }
  });

  // ADR 0017: the default is true only for recipes that write code, which the schema cannot see.
  it('leaves testFirst unset when the recipe does not say', () => {
    const parsed = Recipe.parse(recipe([plan])) as { testFirst?: boolean };
    assert.equal(parsed.testFirst, undefined);
  });

  it('defaults a check to expect a pass', () => {
    const step = Step.parse({ id: 'green', check: 'test' });
    assert.deepEqual(step, { id: 'green', check: 'test', expect: 'pass' });
  });

  it('accepts a $schema reference, a match and a budget', () => {
    const value = recipe([plan], {
      $schema: '../.foedrum/schemas/recipe.json',
      match: { labels: ['feature'] },
      budget: { minutes: 60 },
      testFirst: false,
    });
    assert.equal(accepted(value), true);
  });

  const invalid: [string, unknown][] = [
    ['no steps', recipe([])],
    ['an unknown field', recipe([plan], { bottling: 'perRepo' })],
    ['a name that is not path-safe', recipe([plan], { name: 'Half Pint' })],
    ['an empty description', recipe([plan], { description: ' ' })],
    ['a budget of zero minutes', recipe([plan], { budget: { minutes: 0 } })],
    ['a match without labels', recipe([plan], { match: { labels: [] } })],
    ['a testFirst that is not a boolean', recipe([plan], { testFirst: 'yes' })],
    ['an array', [recipe([plan])]],
  ];
  for (const [what, value] of invalid) {
    it(`rejects ${what}`, () => {
      assert.equal(accepted(value), false);
    });
  }
});

describe('step kinds', () => {
  // Typed as a record so that adding a step kind fails the typecheck until this list follows.
  const examples: Record<StepKind, unknown[]> = {
    brewer: [{ brewer: 'cellarman' }, { id: 'review', brewer: 'taster', lens: 'security' }],
    session: [{ id: 'refine', session: 'refine', deadline: '2d', fallback: 'brewmaster' }],
    check: [
      { id: 'green', check: ['typecheck', 'lint', 'test'] },
      { id: 'red', check: 'test', expect: 'fail', of: 'gauge' },
      { id: 'e2e', check: { run: 'npm run e2e' } },
    ],
    parallel: [tasting],
    loop: [{ id: 'review', loop: { maxRounds: 2, until: 'tasting.verdict', steps: [tasting] } }],
    gate: [{ id: 'approve-plan', gate: 'human', deadline: '3d' }],
    action: [{ action: 'openPullRequest' }, { id: 'merge', action: 'blend' }],
    fanOut: [{ id: 'brew', fanOut: { recipe: 'half-pint', bottling: 'perRepo' } }],
  };
  for (const [kind, steps] of Object.entries(examples)) {
    it(`recognises ${kind} steps`, () => {
      for (const step of steps) {
        assert.equal(stepKind(Step.parse(step)), kind, JSON.stringify(step));
      }
    });
  }

  it('defaults a loop to Stuck when its rounds run out', () => {
    const step = Step.parse({ id: 'review', loop: { maxRounds: 1, until: 'x.y', steps: [plan] } });
    assert.equal((step as { onExhausted?: string }).onExhausted, 'stuck');
  });

  it('defaults a fan-out to approval and one bottle per sub-order', () => {
    const step = Step.parse({ id: 'brew', fanOut: {} });
    assert.deepEqual((step as { fanOut?: unknown }).fanOut, {
      approval: true,
      bottling: 'perSubOrder',
    });
  });

  const invalid: [string, unknown][] = [
    ['a step of no kind', { id: 'nothing' }],
    ['a step of two kinds', { id: 'both', brewer: 'cellarman', check: 'test' }],
    ['an unknown field', { brewer: 'cellarman', retries: 2 }],
    ['a brewer name that is not path-safe', { brewer: 'Cellar Man' }],
    ['a lens name that is not path-safe', { brewer: 'taster', lens: '../secrets' }],
    ['a blocking flag that is not a boolean', { brewer: 'brett', blocking: 'yes' }],
    ['onFail on a brewer step', { brewer: 'cellarman', onFail: { goto: 'plan', maxRounds: 1 } }],
    ['an invalid deadline', { brewer: 'cellarman', deadline: '30 minutes' }],
    [
      'onBlocked for an environment blocker, which is always Stuck',
      { brewer: 'cellarman', onBlocked: { environment: { goto: 'plan', maxRounds: 1 } } },
    ],
    [
      'a route of zero rounds',
      { brewer: 'x', onBlocked: { findings: { goto: 'p', maxRounds: 0 } } },
    ],
    ['a session without an id', { session: 'refine', deadline: '2d' }],
    ['an unknown session', { id: 'chat', session: 'chat', deadline: '2d' }],
    ['a session without a deadline', { id: 'refine', session: 'refine' }],
    ['a gate other than human', { id: 'wait', gate: 'robot', deadline: '1d' }],
    ['a gate without a deadline', { id: 'approve', gate: 'human' }],
    ['an unknown action', { action: 'mergePullRequest' }],
    ['a parallel group without children', { id: 'tasting', parallel: [] }],
    ['a parallel group without an id', { parallel: [{ brewer: 'taster' }] }],
    ['a check in a parallel group', { id: 'p', parallel: [{ id: 'green', check: 'test' }] }],
    [
      'a gate in a parallel group',
      { id: 'p', parallel: [{ id: 'g', gate: 'human', deadline: '1d' }] },
    ],
    ['a loop of zero rounds', { id: 'r', loop: { maxRounds: 0, until: 'x.y', steps: [plan] } }],
    ['a loop without until', { id: 'r', loop: { maxRounds: 1, steps: [plan] } }],
    ['a loop without steps', { id: 'r', loop: { maxRounds: 1, until: 'x.y', steps: [] } }],
    [
      'a loop that does not end in Stuck',
      { id: 'r', loop: { maxRounds: 1, until: 'x.y', steps: [plan] }, onExhausted: 'continue' },
    ],
    ['an unknown bottling policy', { id: 'brew', fanOut: { bottling: 'perOrder' } }],
    ['a fan-out without an id', { fanOut: {} }],
  ];
  for (const [what, value] of invalid) {
    it(`rejects ${what}`, () => {
      assert.equal(Step.safeParse(value).success, false);
    });
  }
});

describe('check steps', () => {
  it('accepts a literal command, with per-OS overrides, in a Brewery recipe', () => {
    const e2e = { id: 'e2e', check: { run: 'npm run e2e', windows: 'npm.cmd run e2e' } };
    assert.equal(accepted(recipe([e2e])), true);
    assert.equal(accepted(recipe([{ id: 'all', check: ['test', { run: 'make e2e' }] }])), true);
  });

  const invalid: [string, unknown][] = [
    ['an unknown check name', { id: 'c', check: 'tests' }],
    ['a command as a plain string', { id: 'c', check: 'npm run e2e' }],
    ['an empty list of checks', { id: 'c', check: [] }],
    ['a check listed twice', { id: 'c', check: ['test', 'lint', 'test'] }],
    ['a check without an id', { check: 'test' }],
    ['an unknown expectation', { id: 'c', check: 'test', expect: 'maybe' }],
    ['a red proof without of', { id: 'red', check: 'test', expect: 'fail' }],
    ['of on a check that expects a pass', { id: 'c', check: 'test', of: 'gauge' }],
    ['a red proof of lint', { id: 'red', check: 'lint', expect: 'fail', of: 'gauge' }],
    [
      'a red proof of several checks',
      { id: 'r', check: ['test', 'lint'], expect: 'fail', of: 'g' },
    ],
    ['a red proof of a literal command', { id: 'r', check: { run: 'x' }, expect: 'fail', of: 'g' }],
    [
      'onBlocked on a check',
      { id: 'c', check: 'test', onBlocked: { findings: { goto: 'p', maxRounds: 1 } } },
    ],
    ['an onFail without maxRounds', { id: 'c', check: 'test', onFail: { goto: 'plan' } }],
  ];
  for (const [what, value] of invalid) {
    it(`rejects ${what}`, () => {
      assert.equal(Step.safeParse(value).success, false);
    });
  }
});

describe('DefaultRecipe', () => {
  it('accepts named checks', () => {
    const value = recipe([gauge, { id: 'red', check: 'test', expect: 'fail', of: 'gauge' }]);
    assert.equal(DefaultRecipe.safeParse(value).success, true);
  });

  const literal: [string, unknown][] = [
    ['a literal command', recipe([{ id: 'e2e', check: { run: 'npm run e2e' } }])],
    ['a literal command in a list', recipe([{ id: 'all', check: ['test', { run: 'make' }] }])],
    [
      'a literal command inside a loop',
      recipe([
        tasting,
        {
          id: 'review',
          loop: {
            maxRounds: 1,
            until: 'tasting.verdict',
            steps: [{ id: 'c', check: { run: 'x' } }],
          },
        },
      ]),
    ],
  ];
  for (const [what, value] of literal) {
    it(`rejects ${what}, which a Brewery recipe may use`, () => {
      assert.equal(accepted(value), true);
      const result = DefaultRecipe.safeParse(value);
      assert.equal(result.success, false);
      assert.match(result.error?.message ?? '', /literal command/);
    });
  }
});

describe('step ids', () => {
  it('accepts an id of 64 characters', () => {
    assert.equal(accepted(recipe([{ id: 'x'.repeat(64), brewer: 'brewmaster' }])), true);
  });

  // One case per PathSafeId rule (src/schemas/ids.ts): step ids become file names (ADR 0024).
  const notPathSafe: [string, string][] = [
    ['an id of 65 characters', 'x'.repeat(65)],
    ['an upper-case letter', 'Plan'],
    ['a leading dash', '-plan'],
    ['a trailing dot', 'plan.'],
    ['a leading dot', '.plan'],
    ['a slash', 'a/b'],
    ['the Windows device name con', 'con'],
    ['the Windows device name com1', 'com1'],
    ['a Windows device name with an extension', 'nul.txt'],
  ];
  for (const [what, id] of notPathSafe) {
    it(`rejects ${what}`, () => {
      assert.equal(accepted(recipe([{ id, brewer: 'brewmaster' }])), false);
      assert.equal(accepted(recipe([{ id, gate: 'human', deadline: '1d' }])), false);
    });
  }

  it('rejects the id recipe, which expressions use for the recipe settings', () => {
    assert.equal(accepted(recipe([{ id: 'recipe', brewer: 'brewmaster' }])), false);
  });

  it('defaults the id of a brewer step to the brewer name', () => {
    assert.equal(stepId(Step.parse({ brewer: 'cellarman' })), 'cellarman');
  });

  it('defaults the id of an action to its name in kebab case', () => {
    assert.equal(stepId(Step.parse({ action: 'openPullRequest' })), 'open-pull-request');
    assert.equal(stepId(Step.parse({ action: 'comment' })), 'comment');
  });

  it('uses an explicit id', () => {
    assert.equal(stepId(Step.parse({ id: 'review', brewer: 'taster' })), 'review');
    assert.equal(stepId(Step.parse({ id: 'pr', action: 'openPullRequest' })), 'pr');
  });

  const duplicates: [string, unknown[]][] = [
    ['two steps with the same id', [plan, { id: 'plan', brewer: 'maltster' }]],
    [
      'two steps that default to the same brewer name',
      [{ brewer: 'taster' }, { brewer: 'taster' }],
    ],
    [
      'an explicit id equal to a default id',
      [{ brewer: 'taster' }, { id: 'taster', gate: 'human', deadline: '1d' }],
    ],
    [
      'the same id inside a loop',
      [plan, { id: 'r', loop: { maxRounds: 1, until: 'plan.x', steps: [plan] } }],
    ],
    ['the same id inside a parallel group', [{ id: 'g', parallel: [plan, plan] }]],
    ['two actions of the same kind', [{ action: 'comment' }, { action: 'comment' }]],
  ];
  for (const [what, steps] of duplicates) {
    it(`rejects ${what}`, () => {
      assert.equal(accepted(recipe(steps)), false);
    });
  }
});

describe('step references', () => {
  it('accepts references to steps anywhere in the recipe, and to the recipe settings', () => {
    const value = recipe([
      { ...gauge, when: 'recipe.testFirst' },
      {
        id: 'red',
        check: 'test',
        expect: 'fail',
        of: 'gauge',
        onFail: { goto: 'gauge', maxRounds: 1 },
      },
      {
        id: 'build',
        brewer: 'cellarman',
        onBlocked: { findings: { goto: 'gauge', maxRounds: 1 } },
      },
      {
        id: 'review',
        loop: {
          maxRounds: 2,
          until: "tasting.verdict == 'approve'",
          steps: [tasting, { id: 'fix', brewer: 'cooper', when: "tasting.verdict != 'approve'" }],
        },
      },
      { action: 'openPullRequest', when: 'mutants.survivors' },
      { id: 'mutants', brewer: 'brett', when: 'step.2.verdict' },
      { id: 'step.2', brewer: 'taster' },
    ]);
    const result = Recipe.safeParse(value);
    assert.equal(result.success, true, result.error?.message);
  });

  const unknown: [string, unknown[], (string | number)[]][] = [
    [
      'a goto to an unknown step',
      [plan, { id: 'green', check: 'test', onFail: { goto: 'ghost', maxRounds: 1 } }],
      ['steps', 1, 'onFail', 'goto'],
    ],
    [
      'a red proof of an unknown step',
      [{ id: 'red', check: 'test', expect: 'fail', of: 'ghost' }],
      ['steps', 0, 'of'],
    ],
    [
      'an onBlocked route to an unknown step',
      [{ brewer: 'cellarman', onBlocked: { findings: { goto: 'ghost', maxRounds: 1 } } }],
      ['steps', 0, 'onBlocked', 'findings', 'goto'],
    ],
    [
      'a when that reads an unknown step',
      [{ ...plan, when: 'ghost.verdict' }],
      ['steps', 0, 'when'],
    ],
    [
      'an until that reads an unknown step',
      [{ id: 'r', loop: { maxRounds: 1, until: "ghost.verdict == 'approve'", steps: [plan] } }],
      ['steps', 0, 'loop', 'until'],
    ],
    [
      'a reference from inside a loop to an unknown step',
      [
        {
          id: 'r',
          loop: { maxRounds: 1, until: 'plan.done', steps: [{ ...plan, when: 'ghost.x' }] },
        },
      ],
      ['steps', 0, 'loop', 'steps', 0, 'when'],
    ],
  ];
  for (const [what, steps, path] of unknown) {
    it(`rejects ${what}, pointing at the reference`, () => {
      const result = Recipe.safeParse(recipe(steps));
      assert.equal(result.success, false);
      assert.deepEqual(
        result.error?.issues.map((issue) => issue.path),
        [path],
      );
    });
  }

  const malformed = [
    'tasting',
    'tasting.verdict = approve',
    "tasting.verdict == 'approve",
    'tasting.verdict == "approve"',
    "tasting.verdict > 'approve'",
    'Tasting.verdict',
    'tasting.verdict && plan.done',
    'rm -rf .',
    '',
  ];
  for (const expression of malformed) {
    it(`rejects the expression ${JSON.stringify(expression)}`, () => {
      assert.equal(accepted(recipe([tasting, { ...plan, when: expression }])), false);
    });
  }
});
