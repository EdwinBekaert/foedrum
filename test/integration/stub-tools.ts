// Stub executables for an integration test (#212): a folder of commands that print captured output
// (test/fixtures/doctor/tool.ts), for a PATH of their own, so what a test sees does not depend on
// which tools this machine has, their versions, their logins or how fast they answer.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tool = join(import.meta.dirname, '..', 'fixtures', 'doctor', 'tool.ts');

/** What a stub prints for one command line; `hang` names the file it writes to, then hangs. */
export interface CapturedAnswer {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  hang?: string;
}

/** The file the stub `name` in the folder `bin` is: `name.cmd` on Windows, `name` elsewhere. */
export const stubPath = (bin: string, name: string): string =>
  join(bin, process.platform === 'win32' ? `${name}.cmd` : name);

/**
 * Makes the folder `bin` with one stub per tool that `answers` names. `answers` maps a command
 * line, `<name> <args>` joined by spaces, to what that tool printed for it.
 */
export const writeStubTools = (bin: string, answers: Record<string, CapturedAnswer>): void => {
  mkdirSync(bin, { recursive: true });
  const answersFile = join(bin, 'answers.json');
  writeFileSync(answersFile, JSON.stringify(answers));
  // The scripts quote these paths as they are: a % would expand in cmd.exe even inside quotes,
  // and a single quote would end sh's quoting, so a stub would start the wrong file.
  const unquotable = process.platform === 'win32' ? /[%"]/ : /'/;
  for (const path of [process.execPath, tool, answersFile]) {
    if (unquotable.test(path)) throw new Error(`a stub tool cannot quote the path ${path}`);
  }
  const names = new Set(Object.keys(answers).map((line) => line.split(' ')[0] ?? ''));
  for (const name of names) {
    const file = stubPath(bin, name);
    if (process.platform === 'win32') {
      // Started through cmd.exe by the runner, with arguments it has checked (ADR 0031).
      writeFileSync(file, `@"${process.execPath}" "${tool}" "${answersFile}" ${name} %*\r\n`);
    } else {
      writeFileSync(
        file,
        `#!/bin/sh\nexec '${process.execPath}' '${tool}' '${answersFile}' ${name} "$@"\n`,
      );
      chmodSync(file, 0o755);
    }
  }
};
