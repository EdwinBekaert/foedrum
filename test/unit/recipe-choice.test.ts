// The recipe choice (ADR 0232): the out doc of a step that chooses the batch's recipe, held to the
// Brewery's recipes it may offer, and the input that names them. Pure: no process starts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attemptLimits, inputsOf } from '../../src/brewers/attempt-plan.ts';
import { settleAttempt } from '../../src/engine/brewer-runner.ts';
import { fold } from '../../src/engine/fold.ts';
import { BrewerFrontmatter } from '../../src/schemas/brewer.ts';
import { recipeChoiceOutDocOf } from '../../src/schemas/recipe-choice.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';

const choices = [
  { name: 'nip', description: 'Quick fix in one repository, test-first' },
  { name: 'mash', description: 'A quick plan' },
];
const innkeeperFields = {
  name: 'innkeeper',
  description: 'Suggests a recipe and asks.',
  version: 1,
  model: 'builder',
  effort: 'low',
  inputs: [
    { name: 'order', from: 'order' },
    { name: 'recipes', from: 'recipes' },
  ],
  output: { doc: 'mash-in.md', schema: 'recipeChoice' },
  produces: 'report',
  tools: { allow: ['Read', 'Grep', 'Glob', 'Edit(mash-in.md)'] },
  access: 'read',
  tree: 'task',
  deadline: '10m',
  maxAttempts: 2,
};
/** Parsed in each test: a red step's schema refuses its input source. */
const innkeeper = (): BrewerFrontmatter => {
  const read = BrewerFrontmatter.safeParse(innkeeperFields);
  assert.ok(read.success, JSON.stringify(read.error?.issues));
  return read.data;
};
const asked = (options: string[], recommended = 'mash') => ({
  q: 'Which recipe brews #12? Suggested: mash: it touches three areas',
  options,
  recommended,
  whyBlocking: 'The recipe decides what runs next',
});
const needs = (questions: unknown[]) => ({
  status: 'needs_input',
  summary: 'A recipe to choose',
  questions,
});

describe('recipeChoiceOutDocOf (ADR 0232)', () => {
  const schema = () => recipeChoiceOutDocOf(choices.map(({ name }) => name));

  it('reads one question whose options are among the choices, the suggestion recommended', () => {
    const read = schema().safeParse(needs([asked(['nip', 'mash'])]));
    assert.ok(read.success, JSON.stringify(read.error?.issues));
  });

  const refused: [string, unknown, RegExp][] = [
    ['a done', { status: 'done', summary: 'Chose mash' }, /needs_input/],
    ['a second question', needs([asked(['nip', 'mash']), asked(['nip', 'mash'])]), /one question/],
    ['an option the Brewery lacks', needs([asked(['nip', 'decoction'])]), /decoction/],
  ];
  for (const [what, doc, reason] of refused) {
    it(`refuses ${what}, naming it`, () => {
      const read = schema().safeParse(doc);
      assert.equal(read.success, false);
      assert.match(JSON.stringify(read.error?.issues), reason);
    });
  }

  it('reads blocked and failed as for any brewer', () => {
    for (const doc of [
      { status: 'blocked', summary: 'The issue is gone', blockerKind: 'environment' },
      { status: 'failed', summary: 'Could not read the issue' },
    ]) {
      assert.ok(schema().safeParse(doc).success, JSON.stringify(doc));
    }
  });
});

describe("attemptLimits: a recipe choice's question (ADR 0232)", () => {
  const ended = (frontmatter: Record<string, unknown>) =>
    settleAttempt(
      {
        exit: { kind: 'exited', code: 0 },
        outDoc: outDoc(frontmatter),
        denials: 0,
        deniedTools: [],
        turns: 3,
      },
      attemptLimits(innkeeper(), undefined, false, undefined, ['nip', 'mash']),
    );

  it('ends needing input with the question, its suggestion and its reason', () => {
    const question = asked(['nip', 'mash']);
    assert.deepEqual(ended(needs([question])), { kind: 'needs_input', questions: [question] });
  });

  for (const [what, doc] of [
    ['a done', { status: 'done', summary: 'Chose mash' }],
    ['an option the Brewery lacks', needs([asked(['nip', 'decoction'])])],
  ] as const) {
    it(`fails ${what} retryably, naming it`, () => {
      const ending = ended(doc);
      assert.ok(ending.kind === 'failed' && ending.retryable, JSON.stringify(ending));
      assert.match(ending.reason, /^the out doc mash-in\.md is invalid: /);
    });
  }
});

describe('inputsOf: the recipes a step may offer (ADR 0232)', () => {
  it('names each choice on a line of its own, from the engine', () => {
    const batch = fold([
      {
        type: 'batch.ordered',
        batchId: '12-1',
        order: { issue: 12 },
        routeBy: '2026-10-28T12:00:00.000Z',
      },
    ]).batches.get('12-1');
    assert.ok(batch !== undefined);
    const [, recipes] = inputsOf(
      innkeeper().inputs,
      batch,
      () => undefined,
      'worktree',
      new Map(),
      undefined,
      choices,
    );
    assert.deepEqual(recipes, {
      name: 'recipes',
      source: { kind: 'recipes' },
      read: {
        kind: 'text',
        text: '- nip: Quick fix in one repository, test-first\n- mash: A quick plan\n',
      },
    });
  });

  it('is named only by a brewer that answers with recipeChoice', () => {
    const read = BrewerFrontmatter.safeParse({
      ...innkeeperFields,
      output: { doc: 'out.md', schema: 'outDoc' },
    });
    assert.equal(read.success, false);
    assert.match(JSON.stringify(read.error?.issues), /recipeChoice/);
  });
});
