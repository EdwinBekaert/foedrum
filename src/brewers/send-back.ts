// The checks before a brewer's end, the core (ADR 0381): once a session of a brewer with
// `checksBeforeEnd` ends done with commits, the runner runs the repository's build, typecheck, lint
// and format, and the red step's tests where the test line takes files, and sends the first failure
// back to the same session once. Which lines run, the message, and what the two runs took together.
// Pure; claude-runner.ts runs them.

import { randomBytes } from 'node:crypto';
import { commandLine, type RepositoryChecks } from '../checks/gravity.ts';
import type { Env } from '../engine/brewer-env.ts';
import { type GravityReading, MOST_REFUSED, type Receipt, type Usage } from '../schemas/events.ts';
import { CheckName } from '../schemas/primitives.ts';
import type { StreamFacts } from './claude-stream.ts';
import { assembleBrewerPrompt, type BrewerPrompt, type RandomBytes } from './prompt.ts';

/** A check of the repository as the checks before the end run it on this platform. */
export interface SendBackCheck {
  check: CheckName;
  command: string;
  /** Whether its line takes paths (`"files": true`). */
  files: boolean;
}

/** What the plan of an attempt with checks before its end holds (ADR 0381). */
export interface SendBackPlan {
  /** The repository's checks it has, in the order green runs them. */
  checks: readonly SendBackCheck[];
  /** The red step's test files, as the repository names them; none without a red step. */
  redTests: readonly string[];
  /** The attempt's deadline: each line is killed before it. */
  deadlineAt: string;
  /** The checks' environment, without claude's login (ADR 0069). */
  env: Env;
  /** Whether no sandbox holds the checks: on native Windows (ADR 0076). */
  unsandboxed: boolean;
}

/** A line the checks before the end run. */
export interface SendBackLine {
  check: CheckName;
  command: string;
}

/** The repository's checks the checks before the end can run, for `platform`. */
export function sendBackChecks(
  repository: RepositoryChecks,
  platform: NodeJS.Platform,
): SendBackCheck[] {
  return CheckName.options.flatMap((check) => {
    const command = repository[check];
    if (command === null) return [];
    const files = typeof command === 'object' && command.files === true;
    return [{ check, command: commandLine(command, platform), files }];
  });
}

/**
 * A path a shell line names in double quotes alike in `/bin/sh` and cmd.exe: no character either
 * expands or ends the quote on (`$`, a backquote, `"`, `%`, `!`, `^`, `\`), and none an option
 * starts with. A brewer names the files (ADR 0381).
 */
const SAFE_PATH = /^[A-Za-z0-9_.@+][A-Za-z0-9_.@+ /-]*$/;

/** Under cmd.exe's 8,191 characters a line, with room for the shell's own words. */
const MAX_LINE = 8000;

/** `command` with `paths` after it, each in double quotes; undefined past `MAX_LINE`. */
const withPaths = (command: string, paths: readonly string[]): string | undefined => {
  const line = [command, ...paths.map((path) => `"${path}"`)].join(' ');
  return line.length > MAX_LINE ? undefined : line;
};

/**
 * The lines to run: build and typecheck whole, lint and format on `changed` when their line takes
 * files, else whole, and the test line on the red step's test files only, when it takes files.
 */
export function sendBackLines(
  checks: readonly SendBackCheck[],
  changed: readonly string[] | undefined,
  redTests: readonly string[],
): SendBackLine[] {
  return checks.flatMap(({ check, command, files }): SendBackLine[] => {
    switch (check) {
      case 'build':
      case 'typecheck':
        // Each reads the project as a whole: a file alone is not what it builds or checks.
        return [{ check, command }];
      case 'lint':
      case 'format': {
        if (!files || changed === undefined) return [{ check, command }];
        // Commits that only deleted files left nothing to lint.
        if (changed.length === 0) return [];
        // A path it cannot name safely is still read when the line runs whole.
        const line = changed.every((path) => SAFE_PATH.test(path))
          ? withPaths(command, changed)
          : undefined;
        return [{ check, command: line ?? command }];
      }
      case 'test': {
        // Never the whole suite: only the red step's tests, on a line that takes them.
        const named = redTests.filter((path) => SAFE_PATH.test(path));
        const line = files && named.length > 0 ? withPaths(command, named) : undefined;
        return line === undefined ? [] : [{ check, command: line }];
      }
      default: {
        const unhandled: never = check;
        throw new Error(`Unhandled check ${JSON.stringify(unhandled)}`);
      }
    }
  });
}

/** A reading of a line that ran: the checks before the end never skip one. */
type Ran = Exclude<GravityReading, { result: 'skipped' }>;

/** How a reading that did not pass ended, in words. */
const endedWith = (reading: Ran): string => {
  switch (reading.result) {
    case 'exited':
      return `exited with ${reading.exitCode}`;
    case 'killed':
      return `was killed: ${reading.killed}`;
    case 'signaled':
      return `ended on signal ${reading.signal}`;
    case 'unstarted':
      return 'could not start';
    default: {
      const unhandled: never = reading;
      throw new Error(`Unhandled reading ${JSON.stringify(unhandled)}`);
    }
  }
};

/**
 * The message that sends the brewer back: which check failed, and the end of what it printed, as an
 * untrusted input, since code the brewer wrote may have printed it (ADR 0041).
 */
export function sendBackMessage(reading: Ran, random: RandomBytes = randomBytes): BrewerPrompt {
  const named = `${reading.check ?? 'a check'} (\`${reading.command}\`)`;
  const { tail } = reading;
  const instructions = [
    `The checks Foedrum ran after your session found a failure. ${named} ${endedWith(reading)}.`,
    'Fix what it found in the files you changed, run that check again with the command the repository uses, and commit. Then end as before: update your out doc when what you did changes it.',
  ].join('\n\n');
  const assembled = assembleBrewerPrompt(
    instructions,
    [{ source: { kind: 'send-back' }, text: tail }],
    random,
  );
  // A tail that holds the input tag's nonce is left out, as a likely injection.
  return assembled.kind === 'assembled' ? assembled.prompt : (instructions as BrewerPrompt);
}

/** The denials of two runs, each tool once in the order it was first denied, its counts added. */
const deniedOf = (first: Receipt['denied'], second: Receipt['denied']): Receipt['denied'] => {
  const families = first.map((family) => ({ ...family, refused: [...family.refused] }));
  for (const family of second) {
    const known = families.find(({ tool }) => tool === family.tool);
    if (known === undefined) {
      families.push({ ...family, refused: [...family.refused] });
      continue;
    }
    known.count += family.count;
    for (const prefix of family.refused) {
      if (!known.refused.includes(prefix) && known.refused.length < MOST_REFUSED) {
        known.refused.push(prefix);
      }
    }
  }
  return families;
};

/** The tokens of two runs added: on `--resume`, `usage` covers that run alone (ADR 0042). */
const usageOf = (first: Usage | undefined, second: Usage | undefined): Usage | undefined => {
  if (first === undefined || second === undefined) return first ?? second;
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cacheReadTokens: first.cacheReadTokens + second.cacheReadTokens,
    cacheWriteTokens: first.cacheWriteTokens + second.cacheWriteTokens,
  };
};

/**
 * What a run and the run that resumed its session took together: the resumed run's session and how
 * it ended, the counts of both. Its receipt is the resumed run's, whose API duration and tokens per
 * model are already the session's (ADR 0172), with the counts of each run added.
 */
export function afterSendBack(
  first: { facts: StreamFacts; receipt: Receipt },
  second: { facts: StreamFacts; receipt: Receipt },
): { facts: StreamFacts; receipt: Receipt } {
  const usage = usageOf(first.facts.usage, second.facts.usage);
  const { durationMs: before } = first.receipt;
  const { durationMs: after } = second.receipt;
  const { durationMs: _, ...resumed } = second.receipt;
  return {
    facts: {
      ...second.facts,
      denials: first.facts.denials + second.facts.denials,
      deniedTools: [...new Set([...first.facts.deniedTools, ...second.facts.deniedTools])],
      turns: first.facts.turns + second.facts.turns,
      lines: first.facts.lines + second.facts.lines,
      ...(usage === undefined ? {} : { usage }),
    },
    receipt: {
      ...resumed,
      complete: first.receipt.complete && second.receipt.complete,
      ...(before === undefined || after === undefined ? {} : { durationMs: before + after }),
      turns: first.receipt.turns + second.receipt.turns,
      edits: first.receipt.edits + second.receipt.edits,
      toolErrors: first.receipt.toolErrors + second.receipt.toolErrors,
      denied: deniedOf(first.receipt.denied, second.receipt.denied),
    },
  };
}
