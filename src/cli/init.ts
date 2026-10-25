// `foedrum init` (ADR 0199): asks a few questions on the terminal, builds a Brewery's files from
// the answers and from what GitHub says of each target repository, checks each against its schema,
// writes the new ones and asks before changing one that is there, then runs doctor. The ports are
// the terminal, the clone's files, GitHub through gh and doctor; init-main.ts gives the real ones.

import type { RepositoryFacts } from '../github/repository-facts.ts';
import type { CliResult } from './run.ts';

export interface InitPorts {
  /** Asks one question; `undefined` when standard input has ended. */
  ask: (question: string) => Promise<string | undefined>;
  /** Shows one line on the terminal, as it comes. */
  say: (line: string) => void;
  /** The Brewery's files, by their path from its root with `/`. */
  files: {
    exists: (path: string) => boolean;
    read: (path: string) => string | undefined;
    write: (path: string, text: string) => void;
  };
  /** The login gh uses (ADR 0073). */
  login: () => Promise<string>;
  /** What GitHub says of `repo`. */
  repository: (repo: string) => Promise<RepositoryFacts>;
  /** doctor's report on the clone, and whether it found the machine ready. */
  doctor: () => Promise<{ ok: boolean; report: string }>;
}

/** Runs `foedrum init` through `ports`. */
export const runInit = async (_ports: InitPorts): Promise<CliResult> => {
  throw new Error('not implemented');
};
