// Regenerates the committed JSON Schema files in schemas/ (npm run schemas).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonSchemas } from '../src/schemas/json-schema.ts';

const dir = join(import.meta.dirname, '..', 'schemas');
mkdirSync(dir, { recursive: true });
writeJsonSchemas(dir);
