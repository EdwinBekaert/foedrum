// `node scripts/adr-index.ts [--check]`: rebuilds the table in docs/adr/README.md and the
// "Amended by" / "Superseded by" part of each record's status line from the records (issue #312).
// adr-index/core.ts decides; this shell reads and writes docs/adr/ (ADR 0021). With --check it
// writes nothing and exits 1 naming what differs.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuild } from './adr-index/core.ts';

export interface RunDeps {
  /** The names of the files in docs/adr/. */
  list: () => string[];
  /** A file's text, by its name in docs/adr/. */
  readFile: (name: string) => string;
  writeFile: (name: string, text: string) => void;
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE = 'usage: node scripts/adr-index.ts [--check]\n';
const README = 'README.md';
const FOLDER = 'docs/adr/';

// The command without the process: the exit code for these arguments.
export const run = (args: string[], deps: RunDeps): number => {
  const check = args.length === 1 && args[0] === '--check';
  if (args.length > 0 && !check) {
    deps.err(USAGE);
    return 2;
  }
  const records = deps
    .list()
    .filter((name) => name !== README)
    .map((name) => ({ name, text: deps.readFile(name) }));
  const result = rebuild(deps.readFile(README), records);
  if (!result.ok) {
    for (const problem of result.problems) deps.err(`${FOLDER}${problem}\n`);
    return 1;
  }
  for (const change of result.changes) deps.out(`${FOLDER}${change}\n`);
  if (check) return result.changes.length > 0 ? 1 : 0;
  if (result.changes.some((change) => change.startsWith(`${README}:`))) {
    deps.writeFile(README, result.readme);
  }
  for (const record of result.records) deps.writeFile(record.name, record.text);
  return 0;
};

if (import.meta.main) {
  const folder = fileURLToPath(new URL('../docs/adr/', import.meta.url));
  process.exitCode = run(process.argv.slice(2), {
    list: () => readdirSync(folder),
    readFile: (name) => readFileSync(join(folder, name), 'utf8'),
    writeFile: (name, text) => writeFileSync(join(folder, name), text),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
