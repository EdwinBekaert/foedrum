// Scans a review summary for secrets before /brew-review posts it.
// Usage: node scripts/secret-scan.ts <file>, run from inside the repository.
// Exit 0: nothing found. Exit 1: secrets found, one line each on stdout. Exit 2: usage or read error.
// A 40-character hexadecimal string that is a commit in this repository is not a secret.
// The patterns are in src/formats/secrets.ts, which gravity readings share (ADR 0069).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findSecrets, type IsCommit } from '../src/formats/secrets.ts';

export { findSecrets, type IsCommit, type SecretMatch } from '../src/formats/secrets.ts';

const isCommitHere: IsCommit = (sha) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export interface RunDeps {
  readFile: (file: string) => string;
  isCommit: IsCommit;
  out: (text: string) => void;
  err: (text: string) => void;
}

// The command without the process: the exit code for these arguments.
export const run = ([file]: string[], deps: RunDeps): number => {
  if (file === undefined) {
    deps.err('usage: node scripts/secret-scan.ts <file>\n');
    return 2;
  }
  let text: string;
  try {
    text = deps.readFile(file);
  } catch (error) {
    deps.err(`cannot read ${file}: ${(error as Error).message}\n`);
    return 2;
  }
  const found = findSecrets(text, deps.isCommit);
  for (const { line, kind, excerpt } of found) deps.out(`line ${line}: ${kind} ${excerpt}\n`);
  return found.length > 0 ? 1 : 0;
};

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    readFile: (file) => readFileSync(file, 'utf8'),
    isCommit: isCommitHere,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
