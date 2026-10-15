// JSON Schema files generated from the zod schemas, for editors and other tools (ADR 0007).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Event } from './events.ts';
import { OutDocFrontmatter } from './out-doc.ts';
import { StepOutcome } from './step-outcome.ts';
import { z } from './zod.ts';

const schemas: Record<string, z.ZodType> = {
  'event.json': Event,
  'out-doc.json': OutDocFrontmatter,
  'step-outcome.json': StepOutcome,
};

/** Writes one file per schema into `dir`; the same schemas always give the same bytes. */
export function writeJsonSchemas(dir: string): void {
  for (const [name, schema] of Object.entries(schemas)) {
    // The input form: what a person or model writes, so fields with a default are optional.
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
    writeFileSync(join(dir, name), `${JSON.stringify(json, null, 2)}\n`);
  }
}
