// Each default brewer's prompt states the out doc limits its schema sets, next to the field, so a
// brewer does not learn them by failing (#655).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FOEDRUM_DEFAULTS } from '../../src/engine/brewery-files.ts';
import { BrewerFrontmatter } from '../../src/schemas/brewer.ts';
import {
  FINING,
  GAUGE,
  MAX_BEFORE_AFTER,
  MAX_DISPOSITION_WHY,
  MAX_HOW_IT_WORKS,
  MAX_RISK_LEFT,
  MAX_SEE_IT,
  MAX_TEST_NAME,
  MAX_UNCHANGED,
  MOST_BEFORE_AFTER,
  MOST_DISPOSITIONS,
  MOST_FINING_CHANGES,
  MOST_RISKS_LEFT,
  MOST_TESTS,
  PULL_REQUEST,
  TASTING,
} from '../../src/schemas/out-doc.ts';
import {
  MAX_PLAN_LINE,
  MAX_TITLE,
  MOST_ALTERNATIVES,
  MOST_TOUCHES,
  PLAN,
} from '../../src/schemas/plan.ts';
import { readDoc } from '../../src/schemas/read.ts';
import { RECIPE_CHOICE } from '../../src/schemas/recipe-choice.ts';

/** A limit of a field: its most, and what it counts. */
type Limit = readonly [field: string, most: number, unit: string];

const planLines = [
  'mechanism',
  'doneWhen',
  'why',
  'testFirstOff',
  'refinement',
  'cut',
  'whyNot',
  'whyThis',
];

/** Every default brewer, the schema of its out doc, and the limits of it its prompt states. */
const brewers: Record<string, { schema: string; limits: readonly Limit[] }> = {
  brewmaster: {
    schema: PLAN,
    limits: [
      ['title', MAX_TITLE, 'characters'],
      ...planLines.map((field): Limit => [field, MAX_PLAN_LINE, 'characters']),
      ['touches', MOST_TOUCHES, 'paths'],
      ['alternatives', MOST_ALTERNATIVES, 'cuts'],
    ],
  },
  cellarman: {
    schema: PULL_REQUEST,
    limits: [
      ['howItWorks', MAX_HOW_IT_WORKS, 'characters'],
      ['seeIt', MAX_SEE_IT, 'characters'],
      ['beforeAfter', MOST_BEFORE_AFTER, 'rows'],
      ['beforeAfter', MAX_BEFORE_AFTER, 'characters'],
      ['dispositions', MOST_DISPOSITIONS, 'dispositions'],
      ['why', MAX_DISPOSITION_WHY, 'characters'],
    ],
  },
  finer: {
    schema: FINING,
    limits: [
      ['changes', MOST_FINING_CHANGES, 'changes'],
      ['unchanged', MAX_UNCHANGED, 'characters'],
    ],
  },
  gauger: {
    schema: GAUGE,
    limits: [
      ['tests', MOST_TESTS, 'names'],
      ['regressionTests', MOST_TESTS, 'names'],
      ['tests', MAX_TEST_NAME, 'characters'],
      ['regressionTests', MAX_TEST_NAME, 'characters'],
    ],
  },
  // A recipe choice's question sets no length or count.
  innkeeper: { schema: RECIPE_CHOICE, limits: [] },
  taster: {
    schema: TASTING,
    limits: [
      ['riskLeft', MOST_RISKS_LEFT, 'lines'],
      ['riskLeft', MAX_RISK_LEFT, 'characters'],
    ],
  },
};

const folder = join(FOEDRUM_DEFAULTS, 'brewers');

const promptOf = (name: string) => {
  const doc = readDoc(readFileSync(join(folder, `${name}.md`), 'utf8'), BrewerFrontmatter);
  assert.ok(doc.valid, `${name}.md does not read`);
  return { schema: doc.frontmatter.output.schema, body: doc.body };
};

/** Whether a line of `body` names `field` and, after it, says "at most <most> <unit>". */
const states = (body: string, [field, most, unit]: Limit) => {
  const limit = `at most ${most.toLocaleString('en-US')} ${unit}`;
  return body.split('\n').some((line) =>
    [`\`${field}\``, `"${field}"`].some((name) => {
      const at = line.indexOf(name);
      return at !== -1 && line.slice(at).includes(limit);
    }),
  );
};

describe("the default brewers' prompts state their out doc limits (#655)", () => {
  it('lists every default brewer', () => {
    const names = readdirSync(folder)
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.slice(0, -'.md'.length))
      .sort();
    assert.deepEqual(names, Object.keys(brewers).sort());
  });

  for (const [name, { schema, limits }] of Object.entries(brewers)) {
    it(`${name}.md writes the ${schema} out doc and states each of its limits next to the field`, () => {
      const prompt = promptOf(name);
      assert.equal(prompt.schema, schema);
      const missing = limits
        .filter((limit) => !states(prompt.body, limit))
        .map(([field, most, unit]) => `${field}: at most ${most.toLocaleString('en-US')} ${unit}`);
      assert.deepEqual(missing, []);
    });
  }
});
