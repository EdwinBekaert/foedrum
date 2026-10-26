// `foedrum init` on the real machine, in the Brewery's clone `cwd` (ADR 0199): the terminal, the
// clone's files, GitHub through gh's own login and doctor, given to init.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  createLabel,
  createRepository,
  labelExists,
  repositoryExists,
} from '../github/brewery-repository.ts';
import { createGitHubClient } from '../github/client.ts';
import { githubLogin } from '../github/login.ts';
import { repositoryFacts } from '../github/repository-facts.ts';
import { diagnose, formatDiagnosis } from './doctor.ts';
import type { DoctorShell } from './doctor-facts.ts';
import { doctorFromCheckout } from './doctor-main.ts';
import { runInit } from './init.ts';
import { type CliResult, printable } from './run.ts';

/** Where the questions are asked and the lines shown: standard input and output by default. */
export interface InitTerminal {
  input: NodeJS.ReadableStream;
  output: { write: (text: string) => unknown };
}

/**
 * The answers on `input`, one a line, in order: each question takes the next line that came, or
 * waits for it; `undefined` once the input has ended.
 */
const linesOf = (input: NodeJS.ReadableStream) => {
  const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const lines: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;
  reader.on('line', (line) => {
    const next = waiting.shift();
    if (next === undefined) lines.push(line);
    else next(line);
  });
  reader.on('close', () => {
    ended = true;
    for (const next of waiting.splice(0)) next(undefined);
  });
  return {
    next: (): Promise<string | undefined> => {
      const line = lines.shift();
      if (line !== undefined || ended) return Promise.resolve(line);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () => reader.close(),
  };
};

/**
 * Runs `foedrum init` in `cwd`: gh and doctor's tools run through `exec` and `resolve`, default the
 * real runner and PATH, and the questions on `terminal`, default standard input and output.
 */
export const initFromCheckout = async (
  cwd: string,
  options?: Partial<Pick<DoctorShell, 'exec' | 'resolve' | 'denylist'>> & {
    terminal?: InitTerminal;
  },
): Promise<CliResult> => {
  const { input, output } = options?.terminal ?? { input: process.stdin, output: process.stdout };
  const at = (path: string) => join(cwd, ...path.split('/'));
  // gh's own login, never a token (ADR 0073), on github.com: the Brewery names no other host yet.
  const github = createGitHubClient({
    ...(options?.exec === undefined ? {} : { exec: options.exec }),
    cwd,
  });
  const answers = linesOf(input);
  try {
    return await runInit({
      ask: async (question) => {
        output.write(printable(question));
        return answers.next();
      },
      say: (line) => {
        output.write(`${printable(line)}\n`);
      },
      files: {
        exists: (path) => existsSync(at(path)),
        read: (path) => (existsSync(at(path)) ? readFileSync(at(path), 'utf8') : undefined),
        write: (path, text) => {
          mkdirSync(dirname(at(path)), { recursive: true });
          writeFileSync(at(path), text);
        },
      },
      login: () => githubLogin(github),
      repository: (repo) => repositoryFacts(github, repo),
      github: {
        exists: (repo) => repositoryExists(github, repo),
        create: (repo, login, isPrivate) => createRepository(github, repo, login, isPrivate),
        hasLabel: (repo, label) => labelExists(github, repo, label),
        createLabel: (repo, label, description) => createLabel(github, repo, label, description),
      },
      git: async () => {
        throw new Error('not implemented');
      },
      doctor: async () => {
        const diagnosis = diagnose(await doctorFromCheckout(cwd, options));
        return { ok: diagnosis.ok, report: formatDiagnosis(diagnosis) };
      },
    });
  } finally {
    answers.close();
  }
};
