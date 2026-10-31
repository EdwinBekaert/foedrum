// npm run demo's brewers (ADR 0097, ADR 0139): the Nip fixture's scripted Gauger, Cellarman and
// Finer (test/helpers/nip-fixture.ts), a Taster for each lens step of the demo's parallel group, and
// the third order's Innkeeper and Brewmaster (ADR 0232, ADR 0234), in serve's runner seam, as the E2E test runs them, so the Gauger's and the Cellarman's attempts
// commit in their worktrees and no model is asked. In the life that crashes, the Cellar's process is
// killed once the first attempt has committed, before that attempt ends.

import { devNull } from 'node:os';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import type { Git } from '../../src/workspace/git.ts';
import { NIP_SCRIPT, type Scripted, scriptedNip } from '../../test/helpers/nip-fixture.ts';
import { IDENTITY, type Life, MASH_ORDER, RECIPE, TARGET } from './core.ts';

export interface DemoBrewersOptions {
  /** The attempt's plan, serve's own: its worktree and its prompt. */
  plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>;
  git: Git;
  write: (path: string, text: string) => void;
  life: Life;
  /** Kills the Cellar's process; called once the commit is made, in the life that crashes. */
  crash: () => void;
  /** Called once the attempt has started, before the brewer writes; the demo shows it there. */
  started?: (ref: AttemptStart['ref']) => Promise<void>;
  /** Called with the prompt the attempt was planned with, once it has brewed. */
  brewed?: (ref: AttemptStart['ref'], prompt: string) => void;
}

/**
 * Who commits, for this call only: the user's own configuration (an identity, commit signing, a
 * hooks folder) takes no part in the demo.
 */
export const DEMO_GIT_CONFIG = {
  'user.name': IDENTITY.name,
  'user.email': IDENTITY.email,
  'commit.gpgsign': 'false',
  'core.hooksPath': devNull,
};

/** A Taster's out doc that approves with one minor finding, as the Nip fixture's Taster's does. */
const tasting = (lens: string, file: string, line: number, why: string): Scripted => ({
  files: {},
  message: '',
  summary: `One minor finding through ${lens}.`,
  tasting: {
    verdict: 'approve',
    findings: [{ file, line, severity: 'minor', why, introduced: true }],
  },
});

/** The finding the blocking correctness lens asks changes for in round 1 (ADR 0193). */
const SPACES = {
  file: 'greet.mjs',
  line: 2,
  severity: 'major',
  why: 'a name of only spaces is greeted as itself, not as a stranger',
  introduced: true,
} as const;

/** The Cellarman's fix of the finding, and its disposition (ADR 0191). */
const FIX_SPACES: Scripted = {
  files: {
    'greet.mjs':
      "export function greet(name) {\n  return 'Hello, ' + (name.trim() === '' ? 'stranger' : name) + '!';\n}\n",
  },
  message: 'Greet a visitor whose name is only spaces as a stranger',
  summary: 'greet greets a name of only spaces as a stranger, as the correctness lens asked.',
  dispositions: [
    {
      file: SPACES.file,
      line: SPACES.line,
      disposition: 'fixed',
      why: 'greet trims the name before it asks whether it is empty',
    },
  ],
};

const security = tasting(
  'diff/security',
  'greet.mjs',
  2,
  'the name goes into the greeting as it is: a caller that writes the greeting into HTML must escape it',
);
const testDesign = tasting(
  'diff/test-design',
  'greet.test.mjs',
  10,
  'the new test covers the empty name only; a name of only spaces has no test',
);

/**
 * The Innkeeper's out doc for the third order (ADR 0232): one question, which recipe brews it, with
 * mash suggested, since the order touches the code and the README.
 */
const INNKEEP: Scripted = {
  files: {},
  message: '',
  summary: 'Asks which recipe brews #3.',
  doc: {
    status: 'needs_input',
    questions: [
      {
        q: `Which recipe brews #${MASH_ORDER.number}? Suggested: mash: it changes greet and the README, two parts to plan first`,
        options: ['mash', RECIPE],
        recommended: 'mash',
        whyBlocking: 'The recipe decides what runs next',
      },
    ],
  },
};

/**
 * The Brewmaster's plan of the third order (ADR 0233, ADR 0234): two sub-orders in the target
 * repository, the README's after greet's, so the plan comment draws their order; with its
 * assumptions and the cut it did not choose.
 */
const PLAN: Scripted = {
  files: {},
  message: '',
  summary: 'Greet in a language first, then show it in the README.',
  doc: {
    subOrders: [
      {
        id: 'languages',
        title: 'greet takes a language',
        repo: TARGET,
        size: { lines: 40, mechanism: 'a second parameter and a table of greetings' },
        doneWhen: "greet('Ann', 'fr') returns 'Bonjour, Ann!'",
        touches: [{ path: 'greet.mjs' }, { path: 'greet.test.mjs' }],
        recipe: 'nip',
        why: 'one small change, test-first',
        ready: true,
      },
      {
        id: 'readme',
        title: 'The README shows the languages',
        repo: TARGET,
        size: { lines: 15, mechanism: 'one section' },
        doneWhen: 'the README names fr and nl with an example of each',
        touches: [{ path: 'README.md', new: true }],
        dependencies: [{ on: 'languages', kind: 'code' }],
        recipe: 'nip',
        why: 'a page after the code it shows',
        testFirst: false,
        testFirstOff: 'a page has no test',
        ready: true,
      },
    ],
    alternatives: {
      considered: [{ cut: 'one sub-order', whyNot: 'the README would show a greet not yet built' }],
      whyThis: 'each part merges alone, the code first',
    },
    assumptions: [
      'English stays the greeting when no language is given.',
      'Only fr and nl for now; another language is a new order.',
    ],
  },
};

/**
 * The Nip fixture's Gauger and Cellarman, with a Taster for each lens step of the demo's parallel
 * group (ADR 0168), playing a tasting loop (ADR 0193). In round 1 the blocking correctness lens
 * asks for changes with one finding, and the advisory ones approve with a finding of their own,
 * so the status comment shows each one's findings under its own step. The Cellarman's third
 * attempt fixes the finding and records it fixed, and the Finer runs after it once more. In
 * round 2 correctness approves, and the advisory lenses, whose findings are still open, raise
 * them again.
 */
export const DEMO_SCRIPT: Readonly<Record<string, readonly Scripted[]>> = {
  gauge: NIP_SCRIPT.gauge ?? [],
  implement: [...(NIP_SCRIPT.implement ?? []), FIX_SPACES],
  fine: [...(NIP_SCRIPT.fine ?? []), ...(NIP_SCRIPT.fine ?? []).slice(0, 1)],
  correctness: [
    {
      files: {},
      message: '',
      summary: 'One major finding through diff/correctness: changes asked for.',
      tasting: { verdict: 'changes', findings: [SPACES] },
    },
    {
      files: {},
      message: '',
      summary: 'The finding of round 1 is fixed, and the fix brings in no defect.',
      tasting: { verdict: 'approve', findings: [] },
    },
  ],
  security: [security, security],
  'test-design': [testDesign, testDesign],
  // The third order's mash: the Innkeeper's question, then the Brewmaster's plan (ADR 0232).
  innkeep: [INNKEEP],
  plan: [PLAN],
};

export const demoBrewers = (options: DemoBrewersOptions): BrewerRunner => {
  const { life, crash, started, brewed } = options;
  const nip = scriptedNip({ ...options, config: DEMO_GIT_CONFIG, script: DEMO_SCRIPT });
  return {
    progress: nip.progress,
    start: (start) => {
      let run: ReturnType<BrewerRunner['start']> | undefined;
      // A stop (a deadline, serve's own stop) ends the attempt; no crash after it.
      let stopped = false;
      const ended = (async (): Promise<AttemptEnd> => {
        // Showing the attempt never fails it: the Cellar says itself why it could not.
        await started?.(start.ref).catch(() => undefined);
        if (stopped) return { ending: { kind: 'cancelled' } };
        run = nip.start(start);
        const end = await run.ended;
        brewed?.(start.ref, nip.prompts.get(attemptKey.encode(start.ref)) ?? '');
        if (life !== 'crash' || stopped || end.ending.kind !== 'succeeded') return end;
        crash();
        // The process dies with the attempt still running.
        return new Promise<never>(() => {});
      })();
      return {
        ended,
        stop: () => {
          stopped = true;
          run?.stop();
        },
      };
    },
  };
};
