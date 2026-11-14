// npm run demo's brewers (ADR 0097, ADR 0139): the Nip fixture's scripted Maltster, Gauger,
// Cellarman and Finer (test/helpers/nip-fixture.ts), a Taster for each lens step of the demo's parallel group, and
// the third order's Innkeeper, Brewmaster and plan Tasters (ADR 0232, ADR 0234, ADR 0321), in serve's runner seam, as the E2E test runs them, so the Maltster's, the Gauger's and the Cellarman's attempts
// commit in their worktrees and no model is asked. In the life that crashes, the Cellar's process is
// killed once the Gauger's first attempt has committed, before that attempt ends.

import { devNull } from 'node:os';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import type { Git } from '../../src/workspace/git.ts';
import { NIP_SCRIPT, type Scripted, scriptedNip } from '../../test/helpers/nip-fixture.ts';
import { FIX_MESSAGE, IDENTITY, type Life, MASH_ORDER, RECIPE, TARGET } from './core.ts';

export interface DemoBrewersOptions {
  /** The attempt's plan, serve's own: its worktree and its prompt. */
  plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>;
  git: Git;
  write: (path: string, text: string) => void;
  life: Life;
  /** Kills the Cellar's process; called once the Gauger's commit is made, in the life that crashes. */
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

/** A Taster's out doc that approves with no finding, once round 1's findings were answered. */
const approved = (lens: string): Scripted => ({
  files: {},
  message: '',
  summary: `Round 1's finding through ${lens} is answered, and nothing new is found.`,
  tasting: { verdict: 'approve', findings: [] },
});

/** The finding the correctness lens asks changes for in round 1 (ADR 0193). */
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
  message: FIX_MESSAGE,
  summary: 'greet greets a name of only spaces as a stranger, as the correctness lens asked.',
  // Every finding of round 1 sent the batch back, each answered here (ADR 0191, ADR 0354).
  dispositions: [
    {
      file: SPACES.file,
      line: SPACES.line,
      disposition: 'fixed',
      why: 'greet trims the name before it asks whether it is empty',
    },
    {
      step: 'security',
      file: 'greet.mjs',
      line: 2,
      disposition: 'dismissed',
      why: 'greet returns plain text, as the order asks; escaping it is for whoever writes it into HTML',
    },
    {
      step: 'test-design',
      file: 'greet.test.mjs',
      line: 10,
      disposition: 'dismissed',
      why: "the Gauger's tests are the order's; a name of only spaces is the fix's own case, which Brett's mutants measure",
    },
    {
      step: 'design-conformance',
      file: 'greet.mjs',
      line: 2,
      disposition: 'dismissed',
      why: 'the repository keeps no design documents: its README is the only page, and the order does not touch it',
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
const designConformance = tasting(
  'diff/design-conformance',
  'greet.mjs',
  2,
  'the change decides what a visitor with no name is called, and no document of the repository records it',
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

/** The sub-orders of the Brewmaster's plan of the third order. */
const SUB_ORDERS: readonly Record<string, unknown>[] = [
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
];

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
    subOrders: SUB_ORDERS,
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

/** The plan corrected for the naive reader's finding, and what came of it (ADR 0191, ADR 0354). */
const PLAN_CORRECTED: Scripted = {
  ...PLAN,
  summary: 'Greet in a language first, then show it in a section of the README after its title.',
  doc: {
    ...PLAN.doc,
    subOrders: SUB_ORDERS.map((entry) =>
      entry.id === 'readme'
        ? { ...entry, size: { lines: 15, mechanism: 'one section, after the title' } }
        : entry,
    ),
    dispositions: [
      { disposition: 'fixed', why: 'the readme entry says the section goes after the title' },
    ],
  },
};

/** A plan lens's Taster that approves, with `findings` for the plan comment's Review (ADR 0321). */
const planTasting = (
  summary: string,
  findings: readonly Record<string, unknown>[] = [],
): Scripted => ({
  files: {},
  message: '',
  summary,
  tasting: { verdict: 'approve', findings },
});

/** The line of greet.mjs the Cellarman's fix of the finding leaves, which Brett mutates. */
const TRIMMED = "return 'Hello, ' + (name.trim() === '' ? 'stranger' : name) + '!';";

/**
 * Brett's out doc (ADR 0311): two mutants of that line, which the engine runs in scratch trees
 * (ADR 0313). Greeting a name as a stranger kills the one, by the Gauger's test; greeting a name
 * of only spaces as itself survives the other, since no test gives one (ADR 0319).
 */
const MUTANTS: Scripted = {
  files: {},
  message: '',
  summary: 'Two mutants of greet.mjs:2.',
  doc: {
    mutants: [
      {
        file: 'greet.mjs',
        line: 2,
        original: TRIMMED,
        replacement: "return 'Hello, ' + (name.trim() !== '' ? 'stranger' : name) + '!';",
        description: 'greet greets every visitor who gives a name as a stranger',
      },
      {
        file: 'greet.mjs',
        line: 2,
        original: TRIMMED,
        replacement: "return 'Hello, ' + (name === '' ? 'stranger' : name) + '!';",
        description: 'greet greets a name of only spaces as itself',
      },
    ],
  },
};

/**
 * The Nip fixture's Maltster (its survey and its map), Gauger and Cellarman, with a Taster for each lens step of the
 * demo's parallel group (ADR 0168), playing a tasting loop (ADR 0193). In round 1 the correctness lens
 * asks for changes with one finding, and the other three approve with a finding of their own, and
 * every finding sends the batch back (ADR 0354). The Cellarman's third attempt fixes correctness's
 * finding and dismisses the other three with a reason, and the Finer runs after it once more. In
 * round 2 every lens approves with no finding. Brett mutates the change after them, once.
 */
export const DEMO_SCRIPT: Readonly<Record<string, readonly Scripted[]>> = {
  survey: NIP_SCRIPT.survey ?? [],
  map: NIP_SCRIPT.map ?? [],
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
  security: [security, approved('diff/security')],
  'test-design': [testDesign, approved('diff/test-design')],
  'design-conformance': [designConformance, approved('diff/design-conformance')],
  mutants: [MUTANTS],
  // The third order's mash: the Innkeeper's question, the Brewmaster's plan (ADR 0232), and three
  // Tasters of it side by side (ADR 0321); the naive reader's note sends the plan back once
  // (ADR 0354), and the corrected plan passes all three.
  innkeep: [INNKEEP],
  plan: [PLAN, PLAN_CORRECTED],
  coverage: [
    planTasting('The two sub-orders build what the order asks, and nothing more.'),
    planTasting('The two sub-orders still build what the order asks, and nothing more.'),
  ],
  sizing: [
    planTasting('Each sub-order is one mechanism, far under 1,000 lines.'),
    planTasting('Each sub-order is still one mechanism, far under 1,000 lines.'),
  ],
  'naive-reader': [
    planTasting('One entry leaves a small guess.', [
      {
        severity: 'minor',
        why: 'readme: "one section" does not say where in the README it goes',
        introduced: true,
      },
    ]),
    planTasting('The readme entry now says where its section goes.'),
  ],
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
        // The kill takes the Gauger's attempt, which has committed its test: the Maltster's
        // survey before it ends as it would.
        const gauged = start.ref.stepId === 'gauge';
        if (life !== 'crash' || !gauged || stopped || end.ending.kind !== 'succeeded') return end;
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
