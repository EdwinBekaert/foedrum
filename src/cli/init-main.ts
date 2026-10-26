// `foedrum init` on the real machine, in the Brewery's clone `cwd` or the folder it clones it into
// (ADR 0199, ADR 0207): the terminal, the files, GitHub through gh's own login, git, doctor and the
// PATH and home the foedrum command goes on (ADR 0210), given to init.ts.

import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  createLabel,
  createRepository,
  labelExists,
  repositoryExists,
} from '../github/brewery-repository.ts';
import { createGitHubClient } from '../github/client.ts';
import { githubLogin } from '../github/login.ts';
import { repositoryFacts } from '../github/repository-facts.ts';
import { resolveExecutable } from '../platform/executables.ts';
import { execProcess } from '../platform/processes.ts';
import { runGitWith } from '../workspace/git.ts';
import { diagnose, formatDiagnosis } from './doctor.ts';
import type { DoctorShell } from './doctor-facts.ts';
import { doctorFromCheckout } from './doctor-main.ts';
import { type InitAnswers, runInit } from './init.ts';
import type { ShimPorts } from './init-shim.ts';
import { type CliResult, printable } from './run.ts';

/** How long init's clone, commit and push may each take. */
const GIT_TIMEOUT_MS = 120_000;

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
 * real runner and PATH, the questions `given` does not answer on `terminal`, default standard input
 * and output (ADR 0212).
 */
export const initFromCheckout = async (
  cwd: string,
  options?: Partial<Pick<DoctorShell, 'exec' | 'resolve' | 'denylist'>> & {
    terminal?: InitTerminal;
    /** The environment and home the foedrum command is written for; default this process's. */
    shim?: Partial<Pick<ShimPorts, 'env' | 'home'>>;
  },
  given: InitAnswers = {},
): Promise<CliResult> => {
  const { input, output } = options?.terminal ?? { input: process.stdin, output: process.stdout };
  const at = (path: string) => join(cwd, ...path.split('/'));
  // gh's own login, never a token (ADR 0073), on github.com: the Brewery names no other host yet.
  const github = createGitHubClient({
    ...(options?.exec === undefined ? {} : { exec: options.exec }),
    cwd,
  });
  const git = runGitWith(options?.exec ?? execProcess);
  const answers = linesOf(input);
  try {
    return await runInit(
      {
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
        // The git Foedrum runs: no prompt, no token variable, gh as git's credential helper (ADR 0073).
        git: (folder, args) => git(at(folder), args, { timeoutMs: GIT_TIMEOUT_MS }),
        doctor: async (folder) => {
          const diagnosis = diagnose(await doctorFromCheckout(at(folder), options));
          return { ok: diagnosis.ok, report: formatDiagnosis(diagnosis) };
        },
        shim: machineShim(options?.shim),
      },
      given,
    );
  } finally {
    answers.close();
  }
};

/** This machine, for the foedrum command (ADR 0210); `given` stands in for its PATH and home. */
const machineShim = (given: Partial<Pick<ShimPorts, 'env' | 'home'>> | undefined): ShimPorts => {
  const env = given?.env ?? process.env;
  const platform = process.platform;
  return {
    platform,
    env,
    home: given?.home ?? homedir(),
    // The checkout of the Foedrum that runs, never the working directory, which is the Brewery's.
    entry: fileURLToPath(new URL('./main.ts', import.meta.url)),
    writable: (folder) => {
      try {
        if (!statSync(folder).isDirectory()) return false;
        accessSync(folder, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    read: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    write: (path, text, executable) => {
      writeFileSync(path, text);
      // The mode a new file gets is masked, and one that was there keeps its own.
      if (executable) chmodSync(path, 0o755);
    },
    resolve: (name) => resolveExecutable(name, { env, platform }),
  };
};
