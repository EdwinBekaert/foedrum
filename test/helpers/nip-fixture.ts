// The Nip fixture (#180, ADR 0121): a tiny target repository with one source file and one
// `node --test` test, a Brewery that brews with Nip from `defaults/` (ADR 0098), the order that
// routes to it, and the scripted Gauger, Cellarman, Finer and Taster that play it in serve's runner
// seam: the Gauger commits a failing test, the Cellarman's first fix fails the check once, its
// second one passes, the Finer finds nothing to simplify, and the Taster reports one advisory
// finding. Each attempt commits in its own worktree and leaves its out doc there, as a brewer
// would, so the red proof, the testsUnchanged guard, the checks and the route input (ADR 0128)
// all read what a real run gives them. No model is asked. The E2E test, foedrum brew's integration
// test and `npm run demo` (ADR 0139) use it.

import { join } from 'node:path';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import type { Git, GitOptions } from '../../src/workspace/git.ts';
import { behave, fakeBrewerRunner, outDoc } from './fake-brewer-runner.ts';

/** The order: an issue of the Brewery, labelled for Nip. */
export const NIP_ORDER = {
  number: 1,
  title: 'Greet a visitor who gives no name',
  body: 'greet("") should say "Hello, stranger!" instead of "Hello, !".',
  labels: ['recipe:nip'],
};

/** The target repository on main: one source file and its one test. */
export const NIP_TARGET_FILES: Readonly<Record<string, string>> = {
  'greet.mjs': "export function greet(name) {\n  return 'Hello, ' + name + '!';\n}\n",
  'greet.test.mjs': [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { greet } from './greet.mjs';",
    '',
    "test('greets a visitor by name', () => {",
    "  assert.equal(greet('Ann'), 'Hello, Ann!');",
    '});',
    '',
  ].join('\n'),
};

/** The test the Gauger adds, by the name the runner reports. */
const NIP_TEST = 'greets a stranger when no name is given';

/**
 * One scripted attempt: the files it writes, its commit, and its out doc's summary; a Taster
 * commits nothing and adds its verdict and findings (ADR 0161), and a Finer with nothing to
 * simplify commits nothing and says why (ADR 0166).
 */
export interface Scripted {
  files: Record<string, string>;
  message: string;
  summary: string;
  tasting?: { verdict: 'approve' | 'changes'; findings: readonly Record<string, unknown>[] };
  fining?: { unchanged: string };
}

/**
 * What each attempt of a step commits, by step id and then in the order the runner starts that
 * step's attempts in a batch (ADR 0139): the Gauger's failing test,
 * the Cellarman's fix that forgets the `!` (the check reads it red), then the one that does not,
 * the Finer after each with nothing to simplify, and the Taster's advisory finding through the
 * correctness lens.
 */
export const NIP_SCRIPT: Readonly<Record<string, readonly Scripted[]>> = {
  gauge: [
    {
      files: {
        'greet.test.mjs': `${NIP_TARGET_FILES['greet.test.mjs']}\ntest('${NIP_TEST}', () => {\n  assert.equal(greet(''), 'Hello, stranger!');\n});\n`,
      },
      message: 'Test the greeting of a visitor with no name',
      summary: `Added the test "${NIP_TEST}"; it fails against greet.mjs as it is.`,
    },
  ],
  implement: [
    {
      files: {
        'greet.mjs':
          "export function greet(name) {\n  return name === '' ? 'Hello, stranger' : 'Hello, ' + name + '!';\n}\n",
      },
      message: 'Greet a stranger',
      summary: 'greet("") greets a stranger.',
    },
    {
      files: {
        'greet.mjs':
          "export function greet(name) {\n  return 'Hello, ' + (name === '' ? 'stranger' : name) + '!';\n}\n",
      },
      message: 'Greet a stranger with the same exclamation mark',
      summary: 'greet("") says "Hello, stranger!", as the test asks.',
    },
  ],
  fine: [1, 2].map(() => ({
    files: {},
    message: '',
    summary: 'Nothing to simplify in greet.mjs.',
    fining: { unchanged: 'greet is one expression, and the change reuses nothing it repeats' },
  })),
  taste: [
    {
      files: {},
      message: '',
      summary: 'One minor finding through diff/correctness.',
      tasting: {
        verdict: 'approve',
        findings: [
          {
            file: 'greet.mjs',
            line: 2,
            severity: 'minor',
            why: 'a name of only spaces is greeted as itself, not as a stranger',
            introduced: true,
          },
        ],
      },
    },
  ],
};

/** The out doc of a scripted attempt that is done. */
export const scriptedOutDoc = ({ summary, tasting, fining }: Scripted): string =>
  outDoc({ status: 'done', summary, ...tasting, ...fining });

/**
 * The repository's checks and test report: only `test`, which writes TAP to stdout, as the red
 * proof reads it (ADR 0017).
 */
export const nipTargetConfig = () => ({
  checks: {
    build: null,
    typecheck: null,
    lint: null,
    format: null,
    test: 'node --test --test-reporter=tap',
  },
  testReport: { format: 'tap' },
});

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The Brewery's files, by path relative to its checkout: no recipe or brewer of its own, so Nip,
 * the Gauger, the Cellarman, the Finer and the Taster come from `defaults/`. Their model alias is builder (ADR 0100).
 */
export const nipBreweryFiles = (options: {
  brewery: string;
  target: string;
  user: string;
}): Record<string, string> => ({
  'foedrum.jsonc': json({
    brewery: options.brewery,
    users: [options.user],
    repositories: { [options.target]: nipTargetConfig() },
  }),
  'models.jsonc': json({ models: { builder: 'claude-haiku-5-5' } }),
  '.gitignore': '.foedrum/\n',
});

export interface ScriptedNipOptions {
  /** The attempt's plan, serve's own: its worktree and its prompt. */
  plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>;
  git: Git;
  /** The git configuration of the brewer's commits: who commits, no signing, no hooks. */
  config: NonNullable<GitOptions['config']>;
  write: (path: string, text: string) => void;
  /** What each step's attempts play, when not `NIP_SCRIPT`: `npm run demo`'s adds its own Tasters. */
  script?: Readonly<Record<string, readonly Scripted[]>>;
}

export interface ScriptedNip extends BrewerRunner {
  /** The prompt each attempt was planned with, by attempt key. */
  readonly prompts: ReadonlyMap<string, string>;
}

/** The scripted Gauger, Cellarman, Finer and Taster of `NIP_SCRIPT` (or `script`), in serve's runner seam. */
export const scriptedNip = (options: ScriptedNipOptions): ScriptedNip => {
  const { plan, git, config, write, script = NIP_SCRIPT } = options;
  const prompts = new Map<string, string>();
  // Each step's attempts play its script in the order this runner starts them, so the retry of an
  // attempt lost with an earlier process (npm run demo's kill) plays what that one would have.
  const played = new Map<string, Scripted>();
  const turns = new Map<string, number>();
  const scriptOf = (ref: AttemptStart['ref']): Scripted => {
    const key = attemptKey.encode(ref);
    const known = played.get(key);
    if (known !== undefined) return known;
    const step = `${ref.batchId} ${ref.stepId}`;
    const turn = turns.get(step) ?? 0;
    const scripted = script[ref.stepId]?.[turn];
    if (scripted === undefined) {
      throw new Error(`Nip's script has no turn ${turn + 1} of ${ref.stepId} for attempt ${key}`);
    }
    turns.set(step, turn + 1);
    played.set(key, scripted);
    return scripted;
  };
  // The tests' runner settles each attempt with the out doc the brewer wrote, and its commit when
  // it wrote files.
  const settled = fakeBrewerRunner(({ ref }) => {
    const done = behave.succeed();
    if (done.kind !== 'settle') return done;
    const scripted = scriptOf(ref);
    const count = Object.keys(scripted.files).length === 0 ? 0 : 1;
    const commits = { kind: 'counted', count } as const;
    return { ...done, facts: { ...done.facts, outDoc: scriptedOutDoc(scripted), commits } };
  });
  /** Writes and commits the attempt's change and its out doc; why it could not, if not. */
  const brew = async (start: AttemptStart): Promise<string | undefined> => {
    try {
      const planned = await plan(start);
      prompts.set(attemptKey.encode(start.ref), planned.prompt);
      const scripted = scriptOf(start.ref);
      const { files, message } = scripted;
      for (const [path, text] of Object.entries(files)) write(join(planned.cwd, path), text);
      write(join(planned.cwd, start.limits.outDoc.file), scriptedOutDoc(scripted));
      // A Taster, and a Finer with nothing to simplify, commit nothing.
      if (Object.keys(files).length === 0) return undefined;
      for (const args of [
        ['add', '--', ...Object.keys(files)],
        ['commit', '-q', '-m', message],
      ]) {
        const result = await git(planned.cwd, args, { config });
        if (result.code !== 0) {
          return `git ${args[0]}: ${(result.stderr || result.stdout).trim() || `exit code ${result.code}`}`;
        }
      }
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  return {
    prompts,
    progress: settled.progress,
    start: (start) => {
      // A stop while git commits (a deadline, serve's own stop) cancels the attempt, as it would
      // a brewer's process.
      let stopped = false;
      const ended = brew(start).then((failure): AttemptEnd | Promise<AttemptEnd> => {
        if (stopped) return { ending: { kind: 'cancelled' } };
        if (failure !== undefined) {
          const reason = `the scripted brewer could not commit: ${failure}`;
          return { ending: { kind: 'failed', retryable: false, reason } };
        }
        return settled.start(start).ended;
      });
      return {
        ended,
        stop: () => {
          stopped = true;
        },
      };
    },
  };
};
