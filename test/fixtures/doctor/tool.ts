// A stub tool for test/integration/doctor.test.ts: `node tool.ts <answers.json> <name> <args>...`
// prints what the real tool printed for those arguments, the captured answer under
// `<name> <args>` in answers.json, and exits with its code. An answer with `hang` writes the
// tool's name to that file and then runs until it is killed, as a container runtime waiting for
// its daemon does; it ends by itself after two minutes, so it never outlives a failed test long.
// Arguments with no captured answer fail loudly.

import { appendFileSync, readFileSync } from 'node:fs';

interface Answer {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  hang?: string;
}

const [answersFile = '', name = '', ...args] = process.argv.slice(2);
const answers: Record<string, Answer> = JSON.parse(readFileSync(answersFile, 'utf8'));
const asked = [name, ...args].join(' ');
const answer = answers[asked];
if (answer === undefined) {
  process.stderr.write(`stub ${name}: no captured answer for ${asked}\n`);
  process.exitCode = 99;
} else if (answer.hang !== undefined) {
  appendFileSync(answer.hang, `${name}\n`);
  setTimeout(() => process.exit(0), 120_000);
} else {
  process.stdout.write(answer.stdout ?? '');
  process.stderr.write(answer.stderr ?? '');
  process.exitCode = answer.exitCode ?? 0;
}
