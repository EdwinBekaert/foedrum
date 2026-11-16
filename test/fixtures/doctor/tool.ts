// A stub tool for test/integration/doctor.test.ts: `node tool.ts <answers.json> <name> <args>...`
// prints what the real tool printed for those arguments, the captured answer under
// `<name> <args>` in answers.json, and exits with its code. Arguments with no captured answer
// fail loudly.

import { readFileSync } from 'node:fs';
import type { CapturedAnswer } from '../../integration/stub-tools.ts';

const [answersFile = '', name = '', ...args] = process.argv.slice(2);
const answers: Record<string, CapturedAnswer> = JSON.parse(readFileSync(answersFile, 'utf8'));
const asked = [name, ...args].join(' ');
const answer = answers[asked];
if (answer === undefined) {
  process.stderr.write(`stub ${name}: no captured answer for ${asked}\n`);
  process.exitCode = 99;
} else {
  process.stdout.write(answer.stdout ?? '');
  process.stderr.write(answer.stderr ?? '');
  process.exitCode = answer.exitCode ?? 0;
}
