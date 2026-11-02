// npm run demo -- ladder (ADR 0294): M2's exit offline. One order of the demo Brewery, labelled for
// mash, is planned by the scripted Brewmaster from a folder of checkouts of two repositories, a
// library and an application that depends on it (ADR 0301); approved, its two sub-orders are
// opened as sub-issues, the library's is brewed to a pull request, merged and released by the
// library's CI as the demo plays it, and the application's, which waits for that release, bumps
// the library to it; both pull requests name each other, and once the second merged the order is
// done and its issue closed. Each life of the Cellar is scripts/demo/ladder-cellar.ts, and ends on
// a condition read from its store (`ladderLifeEnd`); the merges and the release stand in for a
// person and the library's CI. This module takes its processes from scripts/demo.ts, the shell.

import { join } from 'node:path';
import { effectKey } from '../../src/engine/effect-key.ts';
import { type Batch, fold } from '../../src/engine/fold.ts';
import { PLAN_HEADING } from '../../src/engine/plan-comment.ts';
import { messageOf } from '../../src/platform/errors.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { ProcessOutcome } from '../process-runner.ts';
import { type CodeHost, type CodeHostSetup, codeHost, fileJournal } from './code-host.ts';
import { BREWERY, IDENTITY, USER } from './core.ts';
import { ALIASES, LADDER_RECIPE, LIB, PACKAGE, VERSION, WEB } from './ladder-brewers.ts';
import { commentMarkdown, type Step, stepLines } from './walkthrough.ts';

/** The order: an issue of the Brewery, labelled for mash, so no Innkeeper chooses its recipe. */
export const LADDER_ORDER = {
  number: 1,
  author: USER,
  labels: ['recipe:mash'],
  title: 'Greet in French on the web',
  body: `${WEB} greets its visitors in French, with the greeting ${LIB} gives.`,
};
/** The order's batch, which the Brewmaster plans. */
export const PLANNED = `${LADDER_ORDER.number}-1`;
/** The released version of the library, as its CI tags it. */
export const RELEASED = '1.4.0';
export const RELEASE_TAG = `v${RELEASED}`;

/** The code host the shell and every life of the Cellar open: the order, and both repositories public. */
export const LADDER_HOST: CodeHostSetup = {
  issues: { [BREWERY]: [LADDER_ORDER] },
  visibilities: { [LIB]: 'public', [WEB]: 'public' },
};

/** How a life of the ladder's Cellar ends: at the plan, the library's or the application's pull request, or the close. */
export type LadderLife = 'plan' | 'lib' | 'web' | 'close';

/** The steps of the ladder, in the order it shows them. */
export const LADDER_STEPS: readonly (Omit<Step, 'id'> & { id: string })[] = [
  {
    id: 'plan',
    title: 'The order, and its plan from a folder of checkouts',
    lookFor: `recipe:mash, "chosen by its label"; the Brewmaster reads ${ALIASES[LIB]}/ and ${ALIASES[WEB]}/ and plans a sub-order in each, each with its recipe.`,
  },
  {
    id: 'approve',
    title: `foedrum approve ${PLANNED}`,
    lookFor: 'the plan signed off by its digest: the batch goes on tap.',
  },
  {
    id: 'sub-issues',
    title: 'The sub-issues',
    lookFor: `one Brewery issue per sub-order under the order, labelled foedrum:sub-order and recipe:${LADDER_RECIPE}, the second blocked by the first.`,
  },
  {
    id: 'lib',
    title: `The sub-order in ${LIB}`,
    lookFor: `ordered, brewed by the Cellarman and opened as a pull request on ${LIB}; the one in ${WEB} waits, ordered by no one.`,
  },
  {
    id: 'release',
    title: `The merge, and ${LIB}'s CI`,
    lookFor: `the demo merges the pull request as a person would, and plays the CI: package.json at ${RELEASED}, the tag ${RELEASE_TAG} on that commit, and a release.`,
  },
  {
    id: 'released',
    title: 'The merge and the release recorded',
    lookFor: `the intake reads the pull request merged and records ${RELEASE_TAG}, which holds the merge: the sub-order in ${WEB} is ready.`,
  },
  {
    id: 'release-input',
    title: `The sub-order in ${WEB}, with the release input`,
    lookFor:
      'ordered with the release it waited for, its tag as written, its page, its notes and the merged pull request.',
  },
  {
    id: 'bump',
    title: `The bump to ${RELEASED}`,
    lookFor: `the Cellarman read ${RELEASE_TAG} in its prompt and wrote ${RELEASED} into package.json: nothing in the demo names the version.`,
  },
  {
    id: 'web',
    title: `The pull request on ${WEB}`,
    lookFor: 'the second pull request of the order.',
  },
  {
    id: 'siblings',
    title: 'The pull requests of this order',
    lookFor: `each pull request names the other, its state, and that ${LIB}'s merges and is released first.`,
  },
  {
    id: 'merge',
    title: `The merge on ${WEB}`,
    lookFor: 'the demo merges the second pull request, as a person would.',
  },
  {
    id: 'done',
    title: "The order's status comment",
    lookFor: `every sub-order merged, ${LIB}'s with its release ${RELEASE_TAG}.`,
  },
  {
    id: 'closed',
    title: "The order's issue closed",
    lookFor: 'the engine closes the order with a comment that names both pull requests.',
  },
  {
    id: 'status',
    title: `foedrum status ${LADDER_ORDER.number}`,
    lookFor: "the order's batches and its sub-orders', planning tokens apart from brewing tokens.",
  },
];

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The library's files on main. */
export const LIB_FILES: Readonly<Record<string, string>> = {
  'package.json': json({ name: PACKAGE, version: VERSION }),
  'greet.mjs': "export function greet(name) {\n  return 'Hello, ' + name + '!';\n}\n",
};

/** The application's files on main: it takes the library from its releases. */
export const WEB_FILES: Readonly<Record<string, string>> = {
  'package.json': json({ name: 'web', private: true, dependencies: { [PACKAGE]: VERSION } }),
  'index.mjs': `import { greet } from '${PACKAGE}';\n\nconsole.log(greet('Ann', 'fr'));\n`,
};

/** No check of either repository runs: the ladder shows the order's path, not its checks. */
const NO_CHECKS = { build: null, typecheck: null, lint: null, format: null, test: null };

/**
 * The ladder's recipe: the Cellarman, then the pull request, with no test first and no Gauger, so
 * the Cellarman's `tests` input is left out (#774).
 */
export const ladderRecipeText = (): string =>
  `// The Cellarman, then the pull request: the ladder shows an order's path, not its checks.\n${json(
    {
      name: LADDER_RECIPE,
      description: 'One change, then its pull request, with no checks',
      testFirst: false,
      steps: [{ id: 'implement', brewer: 'cellarman' }, { action: 'openPullRequest' }],
    },
  )}`;

/** The Brewery's files: both repositories by their aliases, the models and the recipe. */
export const ladderBreweryFiles = (): Record<string, string> => ({
  'foedrum.jsonc': json({
    brewery: BREWERY,
    users: [USER],
    repositories: {
      [LIB]: { alias: ALIASES[LIB], checks: NO_CHECKS },
      [WEB]: { alias: ALIASES[WEB], checks: NO_CHECKS },
    },
  }),
  'models.jsonc': json({ models: { builder: 'claude-haiku-5-5', planner: 'claude-haiku-5-5' } }),
  '.gitignore': '.foedrum/\n',
  [`recipes/${LADDER_RECIPE}.jsonc`]: ladderRecipeText(),
});

/** `.foedrum/local.jsonc`: the work root and the clones of both repositories. */
export const ladderLocalConfig = (workRoot: string, clones: Record<string, string>): string =>
  json({ workRoot, clones });

/**
 * The git configuration every git of the ladder reads: the demo's identity, no signing, each
 * repository's GitHub URL sent to its scratch remote, and every other GitHub URL to a path that
 * does not exist, as the default demo's (`gitConfig`).
 */
export const ladderGitConfig = (scratch: string): string => {
  const subsection = (path: string): string =>
    `[url "${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`;
  return [
    '[user]',
    `\tname = ${IDENTITY.name}`,
    `\temail = ${IDENTITY.email}`,
    '[commit]',
    '\tgpgsign = false',
    ...([LIB, WEB] as const).flatMap((repo) => [
      subsection(join(scratch, `${ALIASES[repo]}.git`)),
      `\tinsteadOf = https://github.com/${repo}.git`,
    ]),
    subsection(join(scratch, 'no-such-remote')),
    '\tinsteadOf = https://github.com/',
    '',
  ].join('\n');
};

/** How a life of the Cellar stands, from its store's events. */
export type LadderLifeEnd =
  | { kind: 'brewing' }
  | { kind: 'ended'; line: string }
  | { kind: 'failed'; line: string };

/** The sub-orders' batches of the planned order, in the order they were ordered. */
const subOrderBatches = (batches: Iterable<Batch>): Batch[] =>
  [...batches].filter((batch) => batch.parentBatchId === PLANNED);

/**
 * Where a life stands, from the store's events: `plan` ends once the planned batch is Stuck with
 * its plan ready for review,
 * `lib` once one sub-order's batch is on tap, `web` once both are, and `close` once the order's
 * issue is closed; any other Stuck or cancelled batch fails it at once. The Cellar ends it on the
 * next quiet tick, so the effects of the last change are applied first.
 */
export const ladderLifeEnd = (
  life: LadderLife,
  events: readonly { event: Event }[],
): LadderLifeEnd => {
  const state = fold(events.map(({ event }) => event));
  /** Whether `batch` is the planned one, Stuck with its plan ready for review (ADR 0275). */
  const reviewing = (batch: Batch | undefined): boolean =>
    batch?.id === PLANNED &&
    batch.lane.kind === 'stuck' &&
    batch.lane.reason.kind === 'plan_review';
  for (const batch of state.batches.values()) {
    if (batch.lane.kind === 'stuck' && !(life === 'plan' && reviewing(batch))) {
      return {
        kind: 'failed',
        line: `demo: batch ${batch.id} is Stuck: ${batch.lane.reason.kind}`,
      };
    }
    if (batch.lane.kind === 'cancelled') {
      return { kind: 'failed', line: `demo: batch ${batch.id} was cancelled` };
    }
  }
  const tapped = subOrderBatches(state.batches.values()).filter(
    ({ lane }) => lane.kind === 'on_tap',
  );
  switch (life) {
    case 'plan':
      return reviewing(state.batches.get(PLANNED))
        ? { kind: 'ended', line: `demo: batch ${PLANNED} waits Stuck for the review of its plan` }
        : { kind: 'brewing' };
    case 'lib':
    case 'web': {
      const wanted = life === 'lib' ? 1 : 2;
      return tapped.length >= wanted
        ? { kind: 'ended', line: `demo: batch ${tapped[wanted - 1]?.id} is on tap` }
        : { kind: 'brewing' };
    }
    case 'close': {
      const closed = events.some(({ event }) => {
        if (event.type !== 'effect.applied') return false;
        const { batchId, effect } = effectKey.decode(event.key);
        return batchId === PLANNED && effect === 'close.issue';
      });
      return closed
        ? { kind: 'ended', line: `demo: order #${LADDER_ORDER.number} is closed` }
        : { kind: 'brewing' };
    }
    default:
      return life satisfies never;
  }
};

/** The marker the Cellar prints before the release input an attempt was told. */
export const TOLD_LINE = 'demo: the Cellarman of';

/** The section of a pull request's body that names the order's other pull requests (ADR 0292). */
export const siblingSection = (body: string): string[] => {
  const lines = commentMarkdown(body).split(/\r?\n/);
  const start = lines.indexOf('## Pull requests of this order');
  if (start === -1) return [];
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  const section = lines.slice(start, end === -1 ? undefined : end);
  while (section.at(-1)?.trim() === '') section.pop();
  return section;
};

/** What the Cellar does between ticks, given where its life stands and whether the last tick added no event. */
export const ladderTick = (end: LadderLifeEnd, quiet: boolean): 'wait' | 'end' =>
  end.kind === 'brewing' || (end.kind === 'ended' && !quiet) ? 'wait' : 'end';

/** The part of the demo `npm run demo -- <positionals>` asks for, or undefined for any other. */
export const demoPart = (positionals: readonly string[]): 'default' | 'ladder' | undefined => {
  if (positionals.length === 0) return 'default';
  return positionals.length === 1 && positionals[0] === 'ladder' ? 'ladder' : undefined;
};

/** Ends the ladder's walk at a failed life or command, which the report names. */
class Stopped extends Error {}

/** What the shell gives the ladder: its output, its pauses, git, the CLI and the Cellar. */
export interface LadderShell {
  scratch: string;
  say: (line: string) => void;
  /** Waits for Enter between steps, when the walkthrough pauses. */
  pause: () => Promise<void>;
  write: (path: string, text: string) => void;
  /** git in `cwd`, its stdout; it throws when git fails. */
  git: (cwd: string, args: string[]) => Promise<string>;
  /** A bare remote `<name>.git` and its clone `<name>` with `files` on main; the clone's path. */
  repository: (name: string, files: Record<string, string>) => Promise<string>;
  /** `foedrum <argv>` in the Brewery, shown as `shown` makes its lines; its exit code. */
  foedrum: (brewery: string, argv: string[]) => Promise<number>;
  /** A life of the ladder's Cellar. */
  live: (life: LadderLife) => Promise<ProcessOutcome>;
}

/** What went wrong in a ladder run, one line each; none when it ended as it should. */
export const ladderProblems = (run: {
  lives: ReadonlyMap<LadderLife, ProcessOutcome>;
  pulls: readonly { repo: string; body: string }[];
  orderState: string | undefined;
  failedCommands: readonly string[];
}): string[] => {
  const problems: string[] = [];
  for (const [life, outcome] of run.lives) {
    if (outcome.exitCode !== 0) {
      const tail = outcome.output.trimEnd().split(/\r?\n/).slice(-10).join('\n');
      problems.push(`the Cellar's ${life} life ended with exit code ${outcome.exitCode}:\n${tail}`);
    }
  }
  if (run.pulls.length !== 2)
    problems.push(`the code host has ${run.pulls.length} pull requests, not 2`);
  for (const pull of run.pulls) {
    const other = run.pulls.find((each) => each !== pull);
    if (
      other !== undefined &&
      !siblingSection(pull.body).some((line) => line.includes(other.repo))
    ) {
      problems.push(`the pull request on ${pull.repo} does not name the one on ${other.repo}`);
    }
  }
  if (run.orderState !== 'closed')
    problems.push(`order #${LADDER_ORDER.number} is ${run.orderState ?? 'not found'}, not closed`);
  problems.push(...run.failedCommands);
  return problems;
};

/** Runs the ladder in `shell.scratch`, which the shell emptied; 0 when it ended as it should. */
export const runLadder = async (shell: LadderShell): Promise<number> => {
  const { scratch, say, git, write } = shell;
  const indented = (lines: readonly string[]): void => {
    for (const line of lines) say(line === '' ? '' : `  ${line}`);
  };
  const outputLines = (outcome: ProcessOutcome): string[] =>
    outcome.output.trimEnd() === '' ? [] : outcome.output.trimEnd().split(/\r?\n/);
  let step = 0;
  const next = async (): Promise<void> => {
    if (step > 0) await shell.pause();
    for (const line of stepLines(step, LADDER_STEPS)) say(line);
    step += 1;
  };
  const lives = new Map<LadderLife, ProcessOutcome>();
  const live = async (life: LadderLife): Promise<ProcessOutcome> => {
    const outcome = await shell.live(life);
    lives.set(life, outcome);
    if (outcome.exitCode !== 0) throw new Stopped();
    return outcome;
  };
  const failedCommands: string[] = [];
  const foedrum = async (argv: string[]): Promise<void> => {
    const code = await shell.foedrum(brewery, argv);
    if (code === 0) return;
    failedCommands.push(`foedrum ${argv.join(' ')} failed (exit code ${code})`);
    throw new Stopped();
  };
  const journal = fileJournal(join(scratch, 'code-host.jsonl'));
  const host = (): Promise<CodeHost> => codeHost(journal, LADDER_HOST);
  const read = async (path: string): Promise<unknown> =>
    (await (await host()).fetch(`https://api.github.com/repos/${path}`)).json();
  const comments = async (issue: number) => (await host()).comments(BREWERY, issue);
  const pullOn = async (repo: string) => (await host()).pulls().find((pull) => pull.repo === repo);
  const orderState = async (): Promise<string | undefined> =>
    ((await read(`${BREWERY}/issues/${LADDER_ORDER.number}`)) as { state?: string }).state;

  write(join(scratch, 'gitconfig'), ladderGitConfig(scratch));
  const clones = {
    [LIB]: await shell.repository(ALIASES[LIB], LIB_FILES),
    [WEB]: await shell.repository(ALIASES[WEB], WEB_FILES),
  };
  const brewery = await shell.repository('brewery', ladderBreweryFiles());
  write(join(brewery, '.foedrum', 'local.jsonc'), ladderLocalConfig(join(scratch, 'work'), clones));

  /**
   * Merges `repo`'s pull request into main with a merge commit in its clone, pushes it, and tells
   * the code host, as a person merging on GitHub would; when it merged.
   */
  const merge = async (repo: typeof LIB | typeof WEB): Promise<Date> => {
    const pull = await pullOn(repo);
    if (pull === undefined) throw new Error(`no pull request on ${repo} to merge`);
    const clone = clones[repo];
    await git(clone, ['fetch', '-q', 'origin', pull.head]);
    await git(clone, [
      'merge',
      '-q',
      '--no-ff',
      '-m',
      `Merge pull request #${pull.number} from ${pull.head}`,
      'FETCH_HEAD',
    ]);
    await git(clone, ['push', '-q', 'origin', 'main']);
    const sha = (await git(clone, ['rev-parse', 'HEAD'])).trim();
    const at = new Date();
    (await host()).merge(repo, pull.number, { sha, at: at.toISOString() });
    say(`demo: ${USER} merges ${repo}#${pull.number} into main as ${sha.slice(0, 7)}`);
    return at;
  };

  /** The fourteen steps; a failed life or command, or a git that fails, ends them early. */
  const walk = async (): Promise<void> => {
    await next();
    say(
      `demo: issue #${LADDER_ORDER.number} of ${BREWERY} by ${USER}, labelled ${LADDER_ORDER.labels.join(', ')}:`,
    );
    indented([`"${LADDER_ORDER.title}"`, LADDER_ORDER.body]);
    say('demo: the Cellar starts and brews until the plan waits for its review');
    indented(outputLines(await live('plan')));
    for (const comment of await comments(LADDER_ORDER.number)) {
      const what = comment.body.includes(PLAN_HEADING) ? 'plan comment' : 'status comment';
      say(
        `demo: ${what} on ${BREWERY}#${LADDER_ORDER.number}, its Markdown without the hidden revision marker:`,
      );
      indented(commentMarkdown(comment.body).split('\n'));
    }

    await next();
    await foedrum(['approve', PLANNED]);

    await next();
    say('demo: the Cellar starts again, and brews until the first pull request is on tap');
    const lib = await live('lib');
    const subIssues = (await read(`${BREWERY}/issues/${LADDER_ORDER.number}/sub_issues`)) as {
      number: number;
      title?: string;
      labels: { name: string }[];
    }[];
    for (const issue of subIssues) {
      const blockedBy = (await read(
        `${BREWERY}/issues/${issue.number}/dependencies/blocked_by`,
      )) as {
        number: number;
      }[];
      say(`demo: sub-issue #${issue.number} of #${LADDER_ORDER.number}: "${issue.title ?? ''}"`);
      indented([
        `labels: ${issue.labels.map(({ name }) => name).join(', ')}`,
        `blocked by: ${blockedBy.map(({ number }) => `#${number}`).join(', ') || 'none'}`,
      ]);
    }

    await next();
    indented(outputLines(lib));
    const first = await pullOn(LIB);
    if (first !== undefined) {
      say(
        `demo: pull request #${first.number} on ${first.repo}: "${first.title}", ${first.head} into ${first.base}`,
      );
    }

    await next();
    const mergedAt = await merge(LIB);
    // The library's CI: the version in package.json, the tag on that commit, and a release.
    const libClone = clones[LIB];
    const manifest = JSON.parse(await git(libClone, ['show', 'HEAD:package.json'])) as Record<
      string,
      unknown
    >;
    write(join(libClone, 'package.json'), json({ ...manifest, version: RELEASED }));
    await git(libClone, ['commit', '-q', '-am', `Release ${RELEASED}`]);
    await git(libClone, ['tag', RELEASE_TAG]);
    await git(libClone, ['push', '-q', 'origin', 'main', RELEASE_TAG]);
    const commit = (await git(libClone, ['rev-parse', 'HEAD'])).trim();
    const notes = 'greet takes a language: fr greets in French.';
    (await host()).release(LIB, {
      tag: RELEASE_TAG,
      commit,
      at: new Date(mergedAt.getTime() + 1000).toISOString(),
      notes,
    });
    say(
      `demo: ${LIB}'s CI commits package.json at ${RELEASED}, tags it ${RELEASE_TAG} on ${commit.slice(0, 7)}, and releases it: "${notes}"`,
    );

    await next();
    say('demo: the Cellar starts again, and brews until the second pull request is on tap');
    const web = outputLines(await live('web'));
    const told = web.findIndex((line) => line.startsWith(TOLD_LINE));
    const cut = told === -1 ? web.length : told;
    indented(web.slice(0, cut));

    await next();
    indented(web.slice(cut));

    await next();
    const second = await pullOn(WEB);
    const webClone = clones[WEB];
    if (second !== undefined) {
      await git(webClone, ['fetch', '-q', 'origin', second.head]);
      say(`$ git diff main ${second.head} -- package.json`);
      indented(
        (await git(webClone, ['diff', 'main', 'FETCH_HEAD', '--', 'package.json']))
          .trimEnd()
          .split('\n'),
      );
    }

    await next();
    if (second !== undefined) {
      say(
        `demo: pull request #${second.number} on ${second.repo}: "${second.title}", ${second.head} into ${second.base}`,
      );
    }

    await next();
    for (const pull of (await host()).pulls()) {
      say(`demo: the body of ${pull.repo}#${pull.number} starts:`);
      indented(siblingSection(pull.body));
    }

    await next();
    await merge(WEB);

    await next();
    say("demo: the Cellar starts again, and brews until the order's issue is closed");
    indented(outputLines(await live('close')));
    const status = (await comments(LADDER_ORDER.number)).find(
      ({ body }) => !body.includes(PLAN_HEADING) && !body.includes('Foedrum closes this order'),
    );
    if (status !== undefined) {
      say(
        `demo: status comment on ${BREWERY}#${LADDER_ORDER.number}, its Markdown without the hidden revision marker:`,
      );
      indented(commentMarkdown(status.body).split('\n'));
    }

    await next();
    say(`demo: ${BREWERY}#${LADDER_ORDER.number} is ${(await orderState()) ?? 'not found'}`);
    for (const comment of await comments(LADDER_ORDER.number)) {
      if (!comment.body.includes('Foedrum closes this order')) continue;
      say(`demo: comment by ${comment.author} on ${BREWERY}#${LADDER_ORDER.number}:`);
      indented(commentMarkdown(comment.body).split('\n'));
    }

    await next();
    await foedrum(['status', String(LADDER_ORDER.number)]);
  };

  /** Why the walk ended early, beyond the failed lives and commands, or nothing. */
  let ended: string | undefined;
  try {
    await walk();
  } catch (error) {
    if (!(error instanceof Stopped)) ended = `the ladder stopped: ${messageOf(error)}`;
  }

  say('');
  const problems = [
    ...ladderProblems({
      lives,
      pulls: (await host()).pulls(),
      orderState: await orderState(),
      failedCommands,
    }),
    ...(ended === undefined ? [] : [ended]),
  ];
  for (const problem of problems) say(`demo: ${problem}`);
  if (problems.length === 0) {
    say(
      `demo: one order across ${LIB} and ${WEB}, two linked pull requests, the release and the bump between them, and the order closed`,
    );
  }
  return problems.length === 0 ? 0 : 1;
};
