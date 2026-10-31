// npm run demo's decisions (ADR 0097, ADR 0139, ADR 0185): where its scratch folder may be, the
// Brewery it makes there and its recipe, the orders on the fake code host, and whether a run ended
// as it should. The shell is scripts/demo.ts; one life of the Cellar, or foedrum brew's or foedrum
// mash's run, is scripts/demo/cellar.ts.

import nodePath, { dirname, join, type PlatformPath } from 'node:path';
import type { ServeInputs } from '../../src/cli/serve-config.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { PLAN_HEADING } from '../../src/engine/plan-comment.ts';
import type { Event, StuckReason } from '../../src/schemas/events.ts';
import { NIP_ORDER, nipBreweryFiles } from '../../test/helpers/nip-fixture.ts';
import type { ProcessOutcome } from '../process-runner.ts';

/** The Brewery the demo makes, and its one target repository. */
export const BREWERY = 'demo/brewery';
export const TARGET = 'demo/web';
/** The user who may order work, and the code host's login for the Cellar. */
export const USER = 'ann';
export const LOGIN = 'cellar-bot';

/** The demo Brewery's own recipe, which its orders are labelled for. */
export const RECIPE = 'nip-parallel';

/**
 * The Tasters' lens steps of the recipe's parallel group, which run side by side (ADR 0168). The
 * correctness lens blocks: its changes send the batch back to implement once, so the demo shows a
 * tasting loop (ADR 0193); the others are advisory.
 */
const LENS_STEPS = [
  {
    id: 'correctness',
    brewer: 'taster',
    lens: 'diff/correctness',
    blocking: true,
    onBlocked: { findings: { goto: 'implement', maxRounds: 1 } },
  },
  { id: 'security', brewer: 'taster', lens: 'diff/security' },
  { id: 'test-design', brewer: 'taster', lens: 'diff/test-design' },
] as const;

/**
 * The recipe: Nip's steps from `defaults/recipes/nip.jsonc`, with its taste group of two lens
 * steps, correctness and acceptance (ADR 0197), swapped for a group of three, one of which blocks
 * (ADR 0193). Nip itself keeps its two, so no Nip batch pays for three Taster runs (#448); its
 * correctness blocks too, with two rounds where the demo's has one (ADR 0264).
 */
export const recipeText = (): string =>
  `// Nip's steps, tasted through three lenses side by side (ADR 0168), one of them blocking (ADR 0193).\n${JSON.stringify(
    {
      name: RECIPE,
      description: 'Quick fix in one repository, test-first, tasted through three lenses at once',
      steps: [
        { id: 'gauge', brewer: 'gauger', when: 'recipe.testFirst' },
        {
          id: 'red',
          check: 'test',
          expect: 'fail',
          of: 'gauge',
          when: 'recipe.testFirst',
          onFail: { goto: 'gauge', maxRounds: 1 },
        },
        {
          id: 'implement',
          brewer: 'cellarman',
          onBlocked: { findings: { goto: 'gauge', maxRounds: 1 } },
        },
        { id: 'fine', brewer: 'finer' },
        {
          id: 'green',
          check: ['build', 'typecheck', 'lint', 'format', 'test'],
          onFail: { goto: 'implement', maxRounds: 1 },
        },
        { id: 'taste', parallel: LENS_STEPS },
        { action: 'openPullRequest', onPullRequestFail: { goto: 'implement', maxRounds: 2 } },
      ],
    },
    null,
    2,
  )}\n`;

/** The issue the Cellar brews: the Nip fixture's, in the Brewery's repository, labelled for the recipe. */
export const ORDER = { ...NIP_ORDER, author: USER, labels: [`recipe:${RECIPE}`] };

/**
 * The issue `foedrum brew` brews: the same order again, filed unlabelled so the Cellar leaves it,
 * and labelled for the recipe by the demo once the Cellar has stopped.
 */
export const BREW_ORDER = { ...ORDER, number: 2, labels: [] as string[] };

/**
 * The issue `foedrum mash` routes to the Innkeeper (ADR 0232): an order of its own, broad enough to
 * plan first, filed unlabelled so the Cellar leaves it; the answer to the Innkeeper's question
 * chooses its recipe, and the engine labels it with it (ADR 0232), never a person.
 */
export const MASH_ORDER = {
  ...ORDER,
  number: 3,
  labels: [] as string[],
  title: 'Greet in French and Dutch, and say so in the README',
  body: 'greet takes a language, fr or nl, and greets in it; the README shows how to ask for one.',
};

/**
 * What serve would learn from doctor: no claude is started, so none is looked for, and no brewer
 * runs in Claude Code's sandbox.
 */
export const DIAGNOSIS: ServeInputs['diagnosis'] = {
  tools: [{ name: 'claude', version: undefined, path: 'the demo brewer, never started' }],
  isolation: { level: 'permissions only', why: 'the demo brewer is scripted' },
  problems: [],
};

/** Who the demo commits as, in its own git configuration. */
export const IDENTITY = { name: 'Demo brewer', email: 'brewer@demo.invalid' };

/**
 * The git configuration every git of the demo reads as its global one, with no system one: the
 * demo's identity, no commit signing, and the target repository's URL on GitHub rewritten to the
 * scratch `remote`, so serve's own fetches and pushes reach it. Every other GitHub URL goes to a
 * path next to it that does not exist (git takes the longest matching insteadOf), so a URL serve
 * names some other way fails on the machine instead of reaching github.com.
 */
export const gitConfig = (remote: string): string => {
  // A subsection name is quoted: its backslashes and double quotes are escaped.
  const subsection = (path: string): string =>
    `[url "${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`;
  return [
    '[user]',
    `\tname = ${IDENTITY.name}`,
    `\temail = ${IDENTITY.email}`,
    '[commit]',
    '\tgpgsign = false',
    subsection(remote),
    `\tinsteadOf = https://github.com/${TARGET}.git`,
    subsection(join(dirname(remote), 'no-such-remote')),
    '\tinsteadOf = https://github.com/',
    '',
  ].join('\n');
};

/**
 * The environment every git of the demo gets on top of the process's: the demo's configuration in
 * `<scratch>/gitconfig` as its global one, and no system one.
 */
export const gitEnvOf = (
  scratch: string,
): { GIT_CONFIG_GLOBAL: string; GIT_CONFIG_NOSYSTEM: '1' } => ({
  GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
});

/**
 * How a life of the Cellar ends: killed mid-attempt, or once the batch is on tap; or `brew`,
 * foedrum brew's run of the second order instead of the Cellar.
 */
export type Life = 'crash' | 'finish' | 'brew';

/** The line the Cellar prints right before its process is killed. */
export const CRASH_LINE = 'demo: the Gauger committed its test; the Cellar is killed mid-attempt';
/** The start of the line the Cellar prints once the batch is on tap. */
export const ON_TAP_LINE = 'demo: batch 1-1 is on tap';
/** The start of foedrum brew's last line once the second order's batch is on tap. */
export const BREW_ON_TAP_LINE = 'foedrum brew: batch 2-1 is on tap';
/** The line foedrum mash stops at: the Innkeeper's question of the third order's batch. */
export const QUESTION_LINE = 'foedrum mash: batch 3-1 needs input at innkeep:';
/** The start of foedrum brew's last line once the Brewmaster's plan waits for its review. */
export const PLAN_REVIEW_LINE =
  'foedrum brew: batch 3-1 is stuck: the plan of plan #1 is ready for your review';

/**
 * The demo's scratch folder: `.foedrum/tmp/demo` in the checkout, or `asked` resolved against
 * `cwd`, which must be inside the checkout's `.foedrum/tmp` (and not that folder itself): the
 * folder is removed at the start of every run. `paths` is the platform's path module, given so
 * a test can read Windows paths on every platform.
 */
export const scratchFolder = (
  root: string,
  asked: string | undefined,
  cwd: string,
  paths: PlatformPath = nodePath,
): string => {
  const tmp = paths.join(root, '.foedrum', 'tmp');
  if (asked === undefined) return paths.join(tmp, 'demo');
  const path = paths.resolve(cwd, asked);
  // On another drive, relative() gives the absolute path itself, with no `..` in front.
  const inside = paths.relative(tmp, path);
  if (
    inside === '' ||
    inside === '..' ||
    inside.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(inside)
  ) {
    throw new Error(`npm run demo works only in a folder inside ${tmp}, not in ${path}`);
  }
  return path;
};

/**
 * The Brewery's files, by path relative to its checkout: the Nip fixture's, whose brewers and
 * lenses come from Foedrum's defaults (ADR 0098), and the demo's recipe.
 */
export const breweryFiles = (): Record<string, string> => ({
  ...nipBreweryFiles({ brewery: BREWERY, target: TARGET, user: USER }),
  [`recipes/${RECIPE}.jsonc`]: recipeText(),
});

/** `.foedrum/local.jsonc`: the work root and the user's clone of the target repository. */
export const localConfig = (workRoot: string, clone: string): string =>
  `${JSON.stringify({ workRoot, clones: { [TARGET]: clone } }, null, 2)}\n`;

/** How a life of the Cellar ends, read from its store. */
export type LifeEnd =
  | { kind: 'on_tap'; pullRequests: readonly string[] }
  | { kind: 'stuck'; reason: string }
  | { kind: 'cancelled' };

/** Why a batch is Stuck, in one line. */
const stuckReason = (reason: StuckReason): string => {
  const why =
    'lastReason' in reason ? reason.lastReason : 'summary' in reason ? reason.summary : '';
  const step = 'stepId' in reason ? ` at step ${reason.stepId}` : '';
  return `${reason.kind}${step}${why === '' ? '' : `: ${why}`}`;
};

/**
 * How the life ends, from the store's events in order, or undefined while the batch still
 * brews: on tap once the status comment's revision that shows it is applied after it (ADR
 * 0072), and at once when the batch is Stuck or cancelled, which the demo cannot recover from.
 */
export const lifeEndOf = (events: readonly { event: Event }[]): LifeEnd | undefined => {
  let end: LifeEnd | undefined;
  let tapped: readonly string[] | undefined;
  for (const { event } of events) {
    switch (event.type) {
      case 'batch.on_tap':
        tapped = event.pullRequests;
        break;
      case 'effect.applied':
        if (tapped !== undefined && effectKey.decode(event.key).effect.startsWith('status.')) {
          end = { kind: 'on_tap', pullRequests: tapped };
        }
        break;
      case 'batch.stuck':
        end = { kind: 'stuck', reason: stuckReason(event.reason) };
        break;
      case 'batch.resumed':
      case 'batch.rewound':
        end = undefined;
        break;
      case 'batch.cancelled':
        end = { kind: 'cancelled' };
        break;
      // The batch brews on: none of these ends a life.
      case 'order.decomposed':
      case 'batch.ordered':
      case 'batch.recipe_chosen':
      case 'step.scheduled':
      case 'step.skipped':
      case 'step.started':
      case 'step.finished':
      case 'input.received':
      case 'batch.waiting':
      case 'bottle.opened':
      case 'release.observed':
      case 'batch.taken_over':
      case 'pull_request.ended':
      case 'pull_request.base_checked':
      case 'pull_request.pair_checked':
      case 'pull_request.checks_pending':
      case 'pull_request.checks_finished':
      case 'order.paused':
      case 'order.continued':
      case 'order.ranked':
      case 'step.rescheduled':
      case 'usage.window_closed':
      case 'usage.window_opened':
        break;
      default:
        event satisfies never;
    }
  }
  return end;
};

/** What a run left, as the demo's shell gathered it. */
export interface DemoRun {
  /** The first life of the Cellar, killed mid-attempt. */
  crash: ProcessOutcome;
  /** The second, started again on the same Brewery. */
  restart: ProcessOutcome;
  /** foedrum brew's run of the second order. */
  brew: ProcessOutcome;
  /** foedrum mash's run of the third order, to the Innkeeper's question. */
  mash: ProcessOutcome;
  /** foedrum brew's run of the third order after the answer, to its plan. */
  plan: ProcessOutcome;
  /** The pull requests on the fake code host. */
  pulls: readonly { title: string; head: string; base: string }[];
  /** The comments on each order's issue there, by issue number. */
  comments: ReadonlyMap<number, readonly { author: string; body: string }[]>;
  /** The foedrum commands the walkthrough ran, and how each ended. */
  commands?: readonly { argv: readonly string[]; exitCode: number; stderr: string }[];
}

/** The last lines of a process's output, to say why. */
const tail = (output: string): string => {
  const lines = output.trimEnd().split(/\r?\n/).slice(-10);
  return lines.length === 1 && lines[0] === '' ? '(no output)' : lines.join('\n');
};

/** How a process ended, in a few words. */
const ending = ({ exitCode, killed }: ProcessOutcome): string =>
  killed === undefined ? `exit code ${exitCode}` : `killed: ${killed}`;

/** What went wrong in a run, one line each; none when it ended as it should. */
export const problemsOf = (run: DemoRun): string[] => {
  const { crash, restart, brew, mash, plan, pulls, comments } = run;
  const problems: string[] = [];
  // Killed by the process itself, never by the runner: a deadline means it never crashed.
  if (crash.exitCode === 0 || crash.killed !== undefined || !crash.output.includes(CRASH_LINE)) {
    problems.push(
      `the first Cellar was not killed mid-attempt (${ending(crash)}):\n${tail(crash.output)}`,
    );
  }
  if (restart.exitCode !== 0 || !restart.output.includes(ON_TAP_LINE)) {
    problems.push(
      `the batch is not on tap after the restart (${ending(restart)}):\n${tail(restart.output)}`,
    );
  }
  if (brew.exitCode !== 0 || !brew.output.includes(BREW_ON_TAP_LINE)) {
    problems.push(
      `foedrum brew did not put batch 2-1 on tap (${ending(brew)}):\n${tail(brew.output)}`,
    );
  }
  // foedrum brew's exit codes (ADR 0123): 4 when the batch needs input, 3 when it is Stuck.
  if (mash.exitCode !== 4 || !mash.output.includes(QUESTION_LINE)) {
    problems.push(
      `foedrum mash did not stop batch 3-1 at its question (${ending(mash)}):
${tail(mash.output)}`,
    );
  }
  if (plan.exitCode !== 3 || !plan.output.includes(PLAN_REVIEW_LINE)) {
    problems.push(
      `foedrum brew did not leave the plan of batch 3-1 Stuck for its review (${ending(plan)}):
${tail(plan.output)}`,
    );
  }
  if (pulls.length !== 2) problems.push(`the code host has ${pulls.length} pull requests, not 2`);
  for (const { number } of [ORDER, BREW_ORDER, MASH_ORDER]) {
    const all = comments.get(number) ?? [];
    // The mashed order has a plan comment beside its status comment (ADR 0233), told by its heading.
    const plans = all.filter(({ body }) => body.includes(PLAN_HEADING)).length;
    const count = all.length - plans;
    if (count !== 1) problems.push(`order #${number} has ${count} status comments, not 1`);
    const expected = number === MASH_ORDER.number ? 1 : 0;
    if (plans !== expected) {
      problems.push(`order #${number} has ${plans} plan comments, not ${expected}`);
    }
  }
  for (const { argv, exitCode, stderr } of run.commands ?? []) {
    if (exitCode !== 0) {
      problems.push(
        `foedrum ${argv.join(' ')} failed (exit code ${exitCode}): ${stderr.trim() || '(no output)'}`,
      );
    }
  }
  return problems;
};
