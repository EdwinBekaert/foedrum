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
  FiningOutDoc,
  GAUGE,
  GaugeOutDoc,
  MAX_BEFORE_AFTER,
  MAX_DISPOSITION_WHY,
  MAX_FINING_FILE,
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
  PullRequestOutDoc,
  TASTING,
  TastingOutDoc,
} from '../../src/schemas/out-doc.ts';
import {
  MAX_PLAN_LINE,
  MAX_TITLE,
  MAX_TOUCH_PATH,
  MOST_ALTERNATIVES,
  MOST_TOUCHES,
  PLAN,
  PlanOutDoc,
} from '../../src/schemas/plan.ts';
import { readDoc } from '../../src/schemas/read.ts';
import { RECIPE_CHOICE, recipeChoiceOutDocOf } from '../../src/schemas/recipe-choice.ts';
import { z } from '../../src/schemas/zod.ts';

/** A limit of a field: its most, and what it counts. */
type Limit = readonly [field: string, most: number, unit: string];

/** A default brewer's out doc schema, the limits its prompt states, and those it leaves out, why. */
interface Expected {
  name: string;
  schema: z.ZodType;
  stated: readonly Limit[];
  unstated: Readonly<Record<string, string>>;
}

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

// Every out doc may list dispositions, but only a brewer a Taster's findings come back to writes
// them: in the default recipes, the Cellarman alone (nip's routes go to `implement` and `gauge`, and
// the Gauger's carries the Cellarman's out doc, not a Taster's findings).
const noFindingsBack = 'no Taster findings come back to it in the default recipes';
const noDispositions = {
  dispositions: noFindingsBack,
  'dispositions.file': noFindingsBack,
  'dispositions.why': noFindingsBack,
};

/** Every default brewer, by its file's name. */
const brewers: Record<string, Expected> = {
  brewmaster: {
    name: PLAN,
    schema: PlanOutDoc,
    stated: [
      ['title', MAX_TITLE, 'characters'],
      ...planLines.map((field): Limit => [field, MAX_PLAN_LINE, 'characters']),
      ['touches', MOST_TOUCHES, 'paths'],
      ['path', MAX_TOUCH_PATH, 'characters'],
      ['considered', MOST_ALTERNATIVES, 'cuts'],
    ],
    unstated: {
      ...noDispositions,
      subOrders:
        'the cap of 100 sits far above any plan a person reviews; the prompt keeps each sub-order to one mechanism',
    },
  },
  cellarman: {
    name: PULL_REQUEST,
    schema: PullRequestOutDoc,
    stated: [
      ['howItWorks', MAX_HOW_IT_WORKS, 'characters'],
      ['seeIt', MAX_SEE_IT, 'characters'],
      ['beforeAfter', MOST_BEFORE_AFTER, 'rows'],
      ['case', MAX_BEFORE_AFTER, 'characters'],
      ['before', MAX_BEFORE_AFTER, 'characters'],
      ['after', MAX_BEFORE_AFTER, 'characters'],
      ['dispositions', MOST_DISPOSITIONS, 'entries'],
      ['why', MAX_DISPOSITION_WHY, 'characters'],
    ],
    unstated: {
      'dispositions.file':
        "it copies the Taster's file exactly and cannot shorten it; a finding's file has no cap of its own yet",
    },
  },
  finer: {
    name: FINING,
    schema: FiningOutDoc,
    stated: [
      ['changes', MOST_FINING_CHANGES, 'changes'],
      ['file', MAX_FINING_FILE, 'characters'],
      ['unchanged', MAX_UNCHANGED, 'characters'],
    ],
    unstated: noDispositions,
  },
  gauger: {
    name: GAUGE,
    schema: GaugeOutDoc,
    stated: [
      ['tests', MOST_TESTS, 'names'],
      ['regressionTests', MOST_TESTS, 'names'],
      ['tests', MAX_TEST_NAME, 'characters'],
      ['regressionTests', MAX_TEST_NAME, 'characters'],
    ],
    unstated: noDispositions,
  },
  innkeeper: {
    name: RECIPE_CHOICE,
    schema: recipeChoiceOutDocOf(['nip', 'mash']),
    stated: [],
    unstated: noDispositions,
  },
  taster: {
    name: TASTING,
    schema: TastingOutDoc,
    stated: [
      ['riskLeft', MOST_RISKS_LEFT, 'lines'],
      ['riskLeft', MAX_RISK_LEFT, 'characters'],
    ],
    unstated: noDispositions,
  },
};

const folder = join(FOEDRUM_DEFAULTS, 'brewers');

const promptOf = (name: string) => {
  const doc = readDoc(readFileSync(join(folder, `${name}.md`), 'utf8'), BrewerFrontmatter);
  assert.ok(doc.valid, `${name}.md does not read`);
  return { schema: doc.frontmatter.output.schema, body: doc.body };
};

/** The text a prompt states for `limit`: "at most <most> <unit>". */
const atMost = ([, most, unit]: Limit) => `at most ${most.toLocaleString('en-US')} ${unit}`;

/** Whether a sentence of `body` names the limit's field and states the limit. */
const states = (body: string, limit: Limit) => {
  const [field] = limit;
  return body
    .split(/(?<=\.)\s+|\n/)
    .some(
      (sentence) =>
        (sentence.includes(`\`${field}\``) || sentence.includes(`"${field}"`)) &&
        sentence.includes(atMost(limit)),
    );
};

/** A limit a schema sets: where (its fields' names, by dots), and its most. */
interface SchemaLimit {
  path: string;
  most: number;
}

/** Every `maxLength` and `maxItems` in `schema`'s JSON Schema, by the path of fields to it. */
const limitsOf = (schema: z.ZodType): SchemaLimit[] => {
  const found = new Map<string, SchemaLimit>();
  const walk = (node: unknown, path: readonly string[]) => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'maxLength' || key === 'maxItems') && typeof value === 'number') {
        const limit = { path: path.join('.'), most: value };
        found.set(`${limit.path} ${key}`, limit);
      } else if (key === 'properties' && value !== null && typeof value === 'object') {
        for (const [field, child] of Object.entries(value)) walk(child, [...path, field]);
      } else {
        walk(value, path);
      }
    }
  };
  walk(z.toJSONSchema(schema, { io: 'input' }), []);
  return [...found.values()];
};

describe("the default brewers' prompts state their out doc limits (#655)", () => {
  it('lists every default brewer', () => {
    const names = readdirSync(folder)
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.slice(0, -'.md'.length))
      .sort();
    assert.deepEqual(names, Object.keys(brewers).sort());
  });

  it('takes a limit only from a sentence that names its field', () => {
    const swapped = 'A `title` is at most 300 characters. Each `why` is at most 120 characters.';
    assert.equal(states(swapped, ['title', 120, 'characters']), false);
    assert.equal(states(swapped, ['why', 120, 'characters']), true);
  });

  // Every limit the schema sets has a row the prompt states, or is named as left out with why.
  for (const [name, { name: schemaName, schema, stated, unstated }] of Object.entries(brewers)) {
    it(`${name}.md writes the ${schemaName} out doc and states each limit its schema sets next to the field`, () => {
      const prompt = promptOf(name);
      assert.equal(prompt.schema, schemaName);
      const limits = limitsOf(schema);
      const missing = stated
        .filter((limit) => !states(prompt.body, limit))
        .map((limit) => `${limit[0]}: ${atMost(limit)}`);
      const unaccounted = limits
        .filter(({ path, most }) => {
          const field = path.split('.').at(-1);
          return !(path in unstated) && !stated.some(([f, m]) => f === field && m === most);
        })
        .map(({ path, most }) => `${path}: ${most}`);
      const stale = Object.keys(unstated).filter(
        (path) => !limits.some((limit) => limit.path === path),
      );
      assert.deepEqual(
        { missing, unaccounted, stale },
        { missing: [], unaccounted: [], stale: [] },
      );
    });
  }
});
