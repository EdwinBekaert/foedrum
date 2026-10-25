// `foedrum init` on the real machine, in the Brewery's clone `cwd` (ADR 0199): the terminal, the
// clone's files, GitHub through gh's own login and doctor, given to init.ts.

import type { DoctorShell } from './doctor-facts.ts';
import type { CliResult } from './run.ts';

/** Where the questions are asked and the lines shown: standard input and output by default. */
export interface InitTerminal {
  input: NodeJS.ReadableStream;
  output: { write: (text: string) => unknown };
}

/** Runs `foedrum init` in `cwd`; gh runs through `exec`, default the real runner. */
export const initFromCheckout = async (
  _cwd: string,
  _options?: Partial<Pick<DoctorShell, 'exec' | 'resolve' | 'denylist'>> & {
    terminal?: InitTerminal;
  },
): Promise<CliResult> => {
  throw new Error('not implemented');
};
