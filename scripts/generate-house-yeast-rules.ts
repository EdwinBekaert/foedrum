// Regenerates the session rule files in .claude/rules/house-yeast/ from the house-yeast rules in
// .foedrum/house-yeast/ (npm run house-yeast:rules; #677, ADR 0271).

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionRuleFiles } from './house-yeast/session-rules.ts';

const root = join(import.meta.dirname, '..');
const rules = join(root, '.foedrum', 'house-yeast');
const out = join(root, '.claude', 'rules', 'house-yeast');

const { files, invalid } = sessionRuleFiles(
  readdirSync(rules)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({
      path: `.foedrum/house-yeast/${name}`,
      text: readFileSync(join(rules, name), 'utf8'),
    })),
);
if (invalid.length > 0) {
  for (const { path, reason } of invalid) process.stderr.write(`${path}: ${reason}\n`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
// The folder holds only generated files, so one a rule no longer makes goes.
for (const name of readdirSync(out)) {
  if (!files.some((file) => file.name === name)) rmSync(join(out, name));
}
for (const { name, text } of files) writeFileSync(join(out, name), text);
process.stdout.write(`${files.length} files in .claude/rules/house-yeast/\n`);
