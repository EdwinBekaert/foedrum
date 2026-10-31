// JSON Schema files generated from the zod schemas, for editors and other tools (ADR 0007).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrewerFrontmatter } from './brewer.ts';
import { BreweryConfig } from './brewery-config.ts';
import { Event } from './events.ts';
import { HouseYeastRule } from './house-yeast.ts';
import { ModelsConfig } from './models.ts';
import { OutDocFrontmatter } from './out-doc.ts';
import { Recipe } from './recipe.ts';
import { StepOutcome } from './step-outcome.ts';
import { TestMap } from './test-map.ts';
import { z } from './zod.ts';

const schemas: Record<string, z.ZodType> = {
  'brewer.json': BrewerFrontmatter,
  'event.json': Event,
  'foedrum.json': BreweryConfig,
  'house-yeast.json': HouseYeastRule,
  'models.json': ModelsConfig,
  'out-doc.json': OutDocFrontmatter,
  'recipe.json': Recipe,
  'step-outcome.json': StepOutcome,
  'test-map.json': TestMap,
};

/** Writes one file per schema into `dir`; the same schemas always give the same bytes. */
export function writeJsonSchemas(dir: string): void {
  for (const [name, schema] of Object.entries(schemas)) {
    // The input form: what a person or model writes, so fields with a default are optional.
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
    writeFileSync(join(dir, name), `${JSON.stringify(json, null, 2)}\n`);
  }
}
