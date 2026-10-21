// `node scripts/issue-draft.ts <draft.json>`: checks a pre-existing issue draft before
// /brew-review files it (issue #267). issue-draft/core.ts decides. Exit 0 prints the title the
// draft would file; exit 1 prints one line per problem; exit 2 is a usage error.

import { readFileSync } from 'node:fs';
import { checkDraft } from './issue-draft/core.ts';

export interface RunDeps {
  readFile: (file: string) => string;
  out: (text: string) => void;
  err: (text: string) => void;
}

// The command without the process: the exit code for these arguments.
export const run = ([file]: string[], deps: RunDeps): number => {
  if (file === undefined) {
    deps.err('usage: node scripts/issue-draft.ts <draft.json>\n');
    return 2;
  }
  let text: string;
  try {
    text = deps.readFile(file);
  } catch (error) {
    deps.out(`cannot read the draft: ${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  }
  const result = checkDraft(text);
  if (result.ok) {
    deps.out(`${result.title}\n`);
    return 0;
  }
  for (const problem of result.problems) deps.out(`${problem}\n`);
  return 1;
};

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    readFile: (file) => readFileSync(file, 'utf8'),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
