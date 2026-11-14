// node scripts/tasting-compare.ts [--runs <n>] [--dry-run] (#567, ADR 0224): tastes the seeded
// change of test/fixtures/tasting-compare 3 times in each of three setups, the seven default diff
// lenses apart, the seven together and the three lenses Nip had when this was measured together
// (Nip has a fourth since ADR 0343), and prints one table of the planted
// defects found, the other findings, the tokens and the time. Each run brews one order with
// foedrum brew's own runBrew in a scratch Brewery and target repository under
// .foedrum/tmp/tasting-compare/<setup>-<run>, on npm run demo's seams (ADR 0097): the fake code
// host for gh, and a git configuration of its own whose insteadOf sends the target's GitHub URL
// to a scratch remote. A scripted Cellarman commits the change (no model), and the Tasters' steps
// run on the real claude through serve's own runner, so each Taster is given what a batch gives
// it. By hand only: it needs claude's login, which no test layer reaches (ADR 0057). Each run's
// record is appended to results.jsonl and a run already there is not brewed again, so a stopped
// comparison goes on where it stopped; a failed run is brewed once more. --dry-run plays the
// Tasters too, each reporting the key's defects of its lenses, in .foedrum/tmp/tasting-compare/
// dry-run, to show the table before any token is spent. The decisions are
// scripts/tasting-compare/core.ts.
//
// With --plan (#804, ADR 0323) it tastes the seeded plan of test/fixtures/tasting-compare/plan
// instead, on the same base: the seven default plan lenses apart and together and mash's three
// together, each run a scripted plan (no model), then its Tasters on the real claude, or scripted
// with --dry-run, until the batch waits for the plan's review. Its records, runs and table are kept
// apart under .foedrum/tmp/tasting-compare/plan. Its decisions are scripts/tasting-compare/plan.ts.
//
// With --real (#879, ADR 0332) it tastes three brewed heads of this repository instead, each in twelve
// setups, and #867 in a thirteenth with its maintainer's comment (ADR 0333): the target is the order's
// base fetched from this checkout, a scripted Cellarman commits the head's changed files, and the
// three Tasters nip had then, with design conformance, as nip now has it (ADR 0343), as a fourth in
// the lens setup (ADR 0337), on Opus in the opus setup and at high effort in the high setup
// (ADR 0344), on Opus and at high effort with a Taster told nothing of the rules in the opus-bare
// and high-bare setups, and with real-nip's three lenses in one such Taster on Opus in the
// opus-together setup (ADR 0347) and on Sonnet at high effort in the high-together setup
// (ADR 0348), and as nip and deep-brew ship their tasting in the nip and deep setups, and as nip ships
// it with the other three diff lenses apart in the apart7 setup (ADR 0366),
// run on the real claude, or scripted with --dry-run. --setups <names> runs only those, such as
// opus,high, and --orders <numbers> only those of these orders, such as 867. It prints each Taster's model and effort as it is
// planned, reads each Taster's transcript for what it read and the model it ran on, and stops at
// once on a transcript that cannot say or another model. It writes one blinded list per order and
// one file of its bodies under .foedrum/tmp/tasting-compare/real, the setups named only in
// codes.md, or under real/comparisons/<name> with --comparison <name>, whose records, runs and
// lists are its own. It scores nothing. Its decisions are scripts/tasting-compare/real.ts.
//
// With --real --brewer cellarman --model <id> --effort <effort> (#995, ADR 0394) it builds the three
// heads again instead: a scripted Gauger commits each head's test files as brewed, Cellarman runs
// on the real claude on the given model and effort, or scripted with --dry-run, and the
// repository's checks run on its code after `npm ci`. Each run records whether the checks passed,
// each step's attempts, tokens, turns and time, and the commit it ended on; --orders runs only
// those orders. One blinded list per order shows each run's code diff under
// .foedrum/tmp/tasting-compare/real/brewers, the setups named only in codes.md.
//
// With --real --sub-orders (#1052, ADR 0396) it plans each order once through the real Brewmaster
// as it ships, or scripted with --dry-run, and keeps a plan of one sub-order as that sub-order's
// text in real/sub-orders/<order>.md; --real --brewer cellarman --order-text plan then builds
// from that text instead of the order's own, and refuses before anything brews when it is missing.

import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ClaudeAttemptPlan } from '../src/brewers/claude-runner.ts';
import { runBrew } from '../src/cli/brew.ts';
import { claudeConfigDir } from '../src/cli/resume.ts';
import type { ServeShell } from '../src/cli/serve.ts';
import { serveSetup } from '../src/cli/serve-config.ts';
import { listenWhileServing, serveShell } from '../src/cli/serve-shell.ts';
import type { AttemptStart, BrewerRunner } from '../src/engine/brewer-runner.ts';
import { readBreweryFiles } from '../src/engine/brewery-files.ts';
import type { EventStore } from '../src/engine/event-store.ts';
import { resolveExecutable } from '../src/platform/executables.ts';
import { removeTree } from '../src/platform/remove.ts';
import type { Event } from '../src/schemas/events.ts';
import { runGit } from '../src/workspace/git.ts';
import { ghOver } from '../test/helpers/fake-gh.ts';
import { type FakeApiComment, fakeGitHubApi } from '../test/helpers/fake-github-api.ts';
import { nipBreweryFiles, type Scripted, scriptedNip } from '../test/helpers/nip-fixture.ts';
import { DEMO_GIT_CONFIG } from './demo/brewer.ts';
import { BREWERY, gitConfig, gitEnvOf, LOGIN, localConfig, TARGET, USER } from './demo/core.ts';
import {
  AFTER_ROUND_ONE,
  IMPLEMENT,
  nextRun,
  nextRunOf,
  type RunRecord,
  readKey,
  readRecordsIn,
  recipeText,
  recordOf,
  SETUPS,
  type SetupName,
  scriptedTastings,
  summarize,
  tableMarkdown,
} from './tasting-compare/core.ts';
import {
  nextPlanRun,
  PLAN_SETUPS,
  PLAN_STEP,
  type PlanSetupName,
  planRecipes,
  planRecordOf,
  planTableMarkdown,
  readPlanKey,
  readSeededPlan,
  scriptedPlanTastings,
  summarizePlan,
} from './tasting-compare/plan.ts';
import {
  type BrewerRecord,
  type BrewerSettings,
  type BrewerSetup,
  blinded,
  brewerBlinded,
  brewerBreweryFiles,
  brewerRecordOf,
  brewerScript,
  brewerSettingsOf,
  brewerSetups,
  brewerStop,
  brewerTable,
  changedFiles,
  codeDiffArgs,
  comparisonStop,
  keptFiles,
  nextBrewerRun,
  nextRealRun,
  orderFileOf,
  orderOf,
  PLANNER_RECIPE,
  type PlannerRecord,
  type PlannerSetup,
  plannerBreweryFiles,
  plannerFailure,
  plannerRecordOf,
  plannerSetups,
  plannerStop,
  plannerTable,
  READS_TASTER,
  REAL_BREWER_RECIPE,
  REAL_ORDERS,
  REAL_SETUPS,
  type RealSetup,
  realBreweryFiles,
  realCommentsOf,
  realFolders,
  realRecipeOf,
  realRecordOf,
  realTable,
  refuseMissingTexts,
  refuseSameTaster,
  scratchNameOf,
  scriptedPlan,
  scriptedRealTastings,
  scriptedTranscript,
  selectRealSetups,
  splitHead,
  subOrdersRunOf,
  TODAY_COMMIT,
} from './tasting-compare/real.ts';

const root = resolve(import.meta.dirname, '..');
const fixture = join(root, 'test', 'fixtures', 'tasting-compare');
const BASE = join(fixture, '0001-Start-pantry.patch');
const CHANGE = join(fixture, '0002-Remind-of-the-items-best-before-soon.patch');
const planFixture = join(fixture, 'plan');

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const { values } = parseArgs({
  options: {
    runs: { type: 'string' },
    'dry-run': { type: 'boolean' },
    plan: { type: 'boolean' },
    real: { type: 'boolean' },
    setups: { type: 'string' },
    orders: { type: 'string' },
    comparison: { type: 'string' },
    brewer: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    'sub-orders': { type: 'boolean' },
    'order-text': { type: 'string' },
  },
});
if (values.plan === true && values.real === true) {
  process.stderr.write('--plan and --real are two comparisons: give one of them\n');
  process.exit(2);
}
if (values.setups !== undefined && values.real !== true) {
  process.stderr.write('--setups chooses among the setups of --real: give --real too\n');
  process.exit(2);
}
/** A real brewer's settings, when --brewer gives them (ADR 0394). */
const brewerSettings = (() => {
  try {
    return brewerSettingsOf({ ...values, orderText: values['order-text'] });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(2);
  }
})();
/** Whether --sub-orders plans the orders (ADR 0396). */
const subOrders = (() => {
  try {
    return subOrdersRunOf({ ...values, subOrders: values['sub-orders'] });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(2);
  }
})();
if (
  values.orders !== undefined &&
  values.setups === undefined &&
  brewerSettings === undefined &&
  !subOrders
) {
  process.stderr.write(
    '--orders chooses the orders of the setups --setups, the runs --brewer or the plans --sub-orders names: give one of them too\n',
  );
  process.exit(2);
}
/** The real mode's setups to run: those --setups names, of the orders --orders names, or all. */
const chosenSetups = (): readonly RealSetup[] => {
  if (values.setups === undefined) return REAL_SETUPS;
  try {
    return selectRealSetups(values.setups, values.orders);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(2);
  }
};
const realSetups = chosenSetups();
if (values.comparison !== undefined && values.real !== true) {
  process.stderr.write('--comparison names a comparison of --real: give --real too\n');
  process.exit(2);
}
/** The real mode's folders: a comparison's own when --comparison names one (ADR 0347). */
const realFolderNames = (): string[] => {
  try {
    return realFolders(values.comparison);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(2);
  }
};
const realFolderOf = realFolderNames();
/** The planning runs' folder, where a brewer's run from a kept sub-order reads it (ADR 0396). */
const SUB_ORDERS = 'sub-orders';
const runs = Number(values.runs ?? '3');
if (!Number.isSafeInteger(runs) || runs < 1) {
  process.stderr.write(`--runs must be a whole number of at least 1, not ${values.runs}\n`);
  process.exit(2);
}
const dryRun = values['dry-run'] === true;
const claude = dryRun ? 'the scripted Taster, never started' : resolveExecutable('claude');
if (claude === undefined) {
  process.stderr.write('claude is not on the PATH: the comparison tastes with the real claude\n');
  process.exit(1);
}

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A git of a run: its output, or a throw that says what failed. */
type RunGit = (cwd: string, args: string[]) => Promise<string>;

/** The target on main, as the diff and plan modes make it: the base patch, on its scratch remote. */
const patchedTarget = async (scratch: string, git: RunGit): Promise<void> => {
  await git(scratch, ['init', '-q', '--bare', '--initial-branch=main', 'web.git']);
  await git(scratch, ['clone', '-q', 'web.git', 'web']);
  const web = join(scratch, 'web');
  await git(web, ['am', '-q', BASE]);
  await git(web, ['push', '-q', 'origin', 'main']);
};

/** What a run's record reads beyond the store: the scratch folder of its run, and its git. */
interface RunPlace {
  scratch: string;
  git: RunGit;
}

/**
 * What a comparison brews and how it reads the runs: the diff, plan or real mode's, or a real
 * brewer's, whose records hold what it measured (ADR 0394).
 */
interface Mode<Setup extends string, Run extends RunRecord<Setup> = RunRecord<Setup>> {
  /** Its folders under .foedrum/tmp/tasting-compare: its records and runs stay its own. */
  folders: readonly string[];
  setups: readonly Setup[];
  /** The file of a run's order: its title on the first line. */
  order: (setup: Setup) => string;
  /** The recipe a run's order is labelled for. */
  recipeOf: (setup: Setup) => string;
  /** The Brewery's files of a run beyond Nip's, by path: its recipes, any brewer it replaces, and any models.jsonc. */
  breweryFiles: (setup: Setup) => Record<string, string>;
  /** Makes the bare remote `web.git` with the target's base on main, and its clone `web`. */
  target: (setup: Setup, scratch: string, git: RunGit) => Promise<void>;
  /** What the scripted brewers play in a run, with the target's base on its remote. */
  script: (
    setup: Setup,
    scratch: string,
    git: RunGit,
  ) => Promise<Record<string, readonly Scripted[]>>;
  /** The step that is always scripted, with no model. */
  scriptedStep: string;
  next: (
    records: readonly Run[],
    runs: number,
  ) => { setup: Setup; run: number; retry: boolean } | undefined;
  recordOf: (
    events: readonly { event: Event }[],
    setup: Setup,
    /** The model each attempt was planned with, by its session's id. */
    planned: ReadonlyMap<string, string>,
    place: RunPlace,
  ) => Promise<Omit<Run, 'setup' | 'run' | 'retry' | 'wallMs'>>;
  table: (records: readonly Run[]) => string;
  /** Why a run shows the comparison itself cannot go on: the harness's fault, never a brewer's. */
  stop?: (record: Run) => string | undefined;
  /** More files of its report, by path in its folder. */
  files?: (records: readonly Run[], folder: string) => Record<string, string>;
  /** The comments on a run's order, by the login that writes as a maintainer (ADR 0333). */
  comments?: (setup: Setup, author: string) => FakeApiComment[];
}

const diffMode = (): Mode<SetupName> => {
  const key = readKey(readFileSync(join(fixture, 'key.json'), 'utf8'));
  return {
    folders: [],
    setups: Object.keys(SETUPS) as SetupName[],
    order: () => join(fixture, 'order.md'),
    recipeOf: (setup) => setup,
    breweryFiles: (setup) => ({ [`recipes/${setup}.jsonc`]: recipeText(setup) }),
    target: (_setup, scratch, git) => patchedTarget(scratch, git),
    script: async (setup, scratch, git) => {
      // The change's files as the scripted Cellarman writes them: the change patch applied elsewhere.
      await git(scratch, ['clone', '-q', 'web.git', 'source']);
      const source = join(scratch, 'source');
      await git(source, ['am', '-q', CHANGE]);
      const changed = (await git(source, ['diff', '--name-only', 'HEAD~1', 'HEAD']))
        .split(/\r?\n/)
        .filter((path) => path !== '');
      const files = Object.fromEntries(
        changed.map((path) => [path, readFileSync(join(source, path), 'utf8')]),
      );
      const subject = (await git(source, ['log', '-1', '--format=%s'])).trim();
      const implement: Scripted = {
        files,
        message: subject,
        summary: 'The seeded change of #567, committed as it is.',
      };
      // A round of findings goes back to it, and its next turn ends the run (ADR 0354).
      return {
        [IMPLEMENT]: [implement, AFTER_ROUND_ONE],
        ...(dryRun ? scriptedTastings(setup, key) : {}),
      };
    },
    scriptedStep: IMPLEMENT,
    next: nextRun,
    recordOf: async (events, setup) => recordOf(events, setup),
    table: (records) => tableMarkdown(summarize(records, key), key),
  };
};

const planMode = (): Mode<PlanSetupName> => {
  const key = readPlanKey(readFileSync(join(planFixture, 'key.json'), 'utf8'));
  const seeded = readSeededPlan(readFileSync(join(planFixture, 'plan.json'), 'utf8'));
  return {
    folders: ['plan'],
    setups: Object.keys(PLAN_SETUPS) as PlanSetupName[],
    order: () => join(planFixture, 'order.md'),
    recipeOf: (setup) => setup,
    breweryFiles: (setup) =>
      planRecipes(setup, readFileSync(join(planFixture, 'prose.jsonc'), 'utf8')),
    target: (_setup, scratch, git) => patchedTarget(scratch, git),
    script: async (setup) => ({
      [PLAN_STEP]: [seeded, AFTER_ROUND_ONE],
      ...(dryRun ? scriptedPlanTastings(setup, key) : {}),
    }),
    scriptedStep: PLAN_STEP,
    next: nextPlanRun,
    recordOf: async (events, setup) => planRecordOf(events, setup),
    table: (records) => planTableMarkdown(summarizePlan(records, key), key, { dryRun }),
  };
};

/** A session's transcript, in the project folder claude made for its worktree; undefined when none is. */
const transcriptOf = (sessionId: string): string | undefined => {
  const projects = join(claudeConfigDir(process.env, process.platform, homedir()), 'projects');
  if (!existsSync(projects)) return undefined;
  for (const folder of readdirSync(projects)) {
    const path = join(projects, folder, `${sessionId}.jsonl`);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return undefined;
};

/** A commit's whole id in this checkout, where the heads and the old Taster are read. */
const commitIn = async (commit: string): Promise<string> => {
  const { code, stdout } = await runGit(root, ['rev-parse', '--verify', `${commit}^{commit}`]);
  if (code !== 0) {
    throw new Error(`the commit ${commit} is not in this checkout: run git fetch origin first`);
  }
  return stdout.trim();
};

/** Throws unless every order's base and head is in this checkout. */
const realCommits = async (): Promise<void> => {
  for (const { base, head } of REAL_ORDERS) {
    await commitIn(base);
    await commitIn(head);
  }
};

/** The real modes' folder of the orders' texts. */
const realFixture = join(fixture, 'real');

/** The target of a real mode's run: its order's base alone on main, fetched from this checkout. */
const realTarget = async (
  setup: RealSetup | BrewerSetup,
  scratch: string,
  git: RunGit,
): Promise<void> => {
  // Only the base: later history stays out of the scratch remote, whatever a brewer may run.
  await git(scratch, ['init', '-q', '--bare', '--initial-branch=main', 'web.git']);
  const base = await commitIn(orderOf(setup).base);
  await git(join(scratch, 'web.git'), [
    'fetch',
    '-q',
    '--no-tags',
    '--depth',
    '1',
    root,
    `${base}:refs/heads/main`,
  ]);
  await git(scratch, ['clone', '-q', 'web.git', 'web']);
};

/** The folder of a mode whose `folders` are these, where its records and files stay. */
const modeFolder = (folders: readonly string[]): string =>
  join(root, '.foedrum', 'tmp', 'tasting-compare', ...folders, ...(dryRun ? ['dry-run'] : []));

/** The seed of a report folder's codes: one for the folder, so a code stays the same as more runs come in. */
const seedIn = (reportFolder: string): string => {
  const seedFile = join(reportFolder, 'seed.txt');
  if (!existsSync(seedFile)) writeFileSync(seedFile, randomBytes(16).toString('hex'));
  return readFileSync(seedFile, 'utf8');
};

/** A head as brewed, read from this checkout: its commit, the files it changed, its subject, and a reader of their texts. */
const brewedHeadOf = async (setup: RealSetup | BrewerSetup, git: RunGit) => {
  const { base, head } = orderOf(setup);
  const changed = changedFiles(
    await git(root, ['diff', '--name-status', '-z', '--no-renames', base, head]),
  );
  const subject = (await git(root, ['log', '-1', '--format=%s', head])).trim();
  const textsOf = async (paths: readonly string[]): Promise<Record<string, string>> => {
    const texts: Record<string, string> = {};
    for (const path of paths) texts[path] = await git(root, ['show', `${head}:${path}`]);
    return texts;
  };
  return { head, changed, subject, textsOf };
};

const realMode = async (): Promise<Mode<RealSetup>> => {
  await realCommits();
  const today = await runGit(root, [
    'show',
    `${await commitIn(TODAY_COMMIT)}:defaults/brewers/taster.md`,
  ]);
  if (today.code !== 0) {
    throw new Error(`the Taster of ${TODAY_COMMIT} cannot be read: ${today.stderr.trim()}`);
  }
  const reads = readFileSync(join(realFixture, READS_TASTER), 'utf8');
  refuseSameTaster(today.stdout, reads);
  return {
    folders: realFolderOf,
    setups: realSetups,
    order: (setup) => join(realFixture, `${orderOf(setup).order}.md`),
    recipeOf: realRecipeOf,
    breweryFiles: (setup) => realBreweryFiles(setup, { today: today.stdout, reads }),
    target: realTarget,
    script: async (setup, _scratch, git) => {
      const { head, changed, subject, textsOf } = await brewedHeadOf(setup, git);
      const implement: Scripted = {
        files: await textsOf(changed),
        message: subject,
        summary: `The head ${head}, committed as it was brewed.`,
      };
      return {
        [IMPLEMENT]: [implement, AFTER_ROUND_ONE],
        ...(dryRun ? scriptedRealTastings(changed[0] ?? '') : {}),
      };
    },
    scriptedStep: IMPLEMENT,
    next: (records, runCount) => nextRealRun(records, runCount, realSetups),
    recordOf: async (events, _setup, planned) =>
      realRecordOf(events, (id, worktree) =>
        dryRun ? scriptedTranscript(worktree, planned.get(id) ?? 'no plan') : transcriptOf(id),
      ),
    table: realTable,
    stop: comparisonStop,
    comments: (setup, author) =>
      realCommentsOf(setup, author, (file) => readFileSync(join(realFixture, file), 'utf8')),
    files: (records, reportFolder) => {
      const { lists, bodies, codes } = blinded(records, seedIn(reportFolder));
      return {
        'codes.md': codes,
        ...Object.fromEntries(
          Object.entries(lists).map(([order, list]) => [join('lists', `${order}.md`), list]),
        ),
        ...Object.fromEntries(
          Object.entries(bodies).map(([order, body]) => [join('bodies', `${order}.md`), body]),
        ),
      };
    },
  };
};

/**
 * A real brewer's mode (ADR 0394): each order's base, the head's test files committed by the
 * scripted Gauger, then Cellarman on the given model and effort, real or scripted with --dry-run,
 * and the repository's checks on its code. Its records stay in a folder of their own beside the
 * Tasters' setups'.
 */
const brewerMode = async (settings: BrewerSettings): Promise<Mode<BrewerSetup, BrewerRecord>> => {
  await realCommits();
  const setups = brewerSetups(settings, values.orders);
  const names = { brewery: BREWERY, target: TARGET, user: USER };
  const folders = { fixture: realFixture, kept: modeFolder([...realFolderOf, SUB_ORDERS]) };
  try {
    refuseMissingTexts(setups, folders.kept, existsSync);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(2);
  }
  return {
    folders: [...realFolderOf, 'brewers'],
    setups,
    order: (setup) => orderFileOf(setup, folders),
    recipeOf: () => REAL_BREWER_RECIPE,
    breweryFiles: () => brewerBreweryFiles(settings, names),
    target: realTarget,
    script: async (setup, _scratch, git) => {
      const { head, changed, subject, textsOf } = await brewedHeadOf(setup, git);
      const { tests, code } = splitHead(changed);
      return brewerScript(
        { head, subject, tests: await textsOf(tests), code: await textsOf(code) },
        dryRun,
      );
    },
    scriptedStep: 'gauge',
    next: (records, runCount) => nextBrewerRun(records, runCount, setups),
    recordOf: async (events, setup, planned, { scratch, git }) => {
      const record = brewerRecordOf(events, settings, (id, worktree) =>
        dryRun ? scriptedTranscript(worktree, planned.get(id) ?? 'no plan') : transcriptOf(id),
      );
      const { commit } = record.brewer;
      if (commit === undefined) return record;
      // The code it wrote: the change from the base, past the Gauger's test files.
      const base = await commitIn(orderOf(setup).base);
      const diff = await git(join(scratch, 'web'), codeDiffArgs(base, commit));
      return { ...record, brewer: { ...record.brewer, diff } };
    },
    table: brewerTable,
    stop: brewerStop,
    files: (records, reportFolder) => {
      const { lists, codes } = brewerBlinded(records, seedIn(reportFolder));
      return {
        'codes.md': codes,
        ...Object.fromEntries(
          Object.entries(lists).map(([order, list]) => [join('lists', `${order}.md`), list]),
        ),
      };
    },
  };
};

/**
 * The planning runs (ADR 0396): each order's base, planned once by the Brewmaster as it ships, real
 * or scripted with --dry-run, until its plan waits for its review; a plan of one sub-order is kept
 * as that sub-order's text, and a run with no out doc is planned once more.
 */
const plannerMode = async (): Promise<Mode<PlannerSetup, PlannerRecord>> => {
  await realCommits();
  const setups = plannerSetups(values.orders);
  const order = (setup: PlannerSetup) => join(realFixture, `${orderOf(setup).order}.md`);
  return {
    folders: [...realFolderOf, SUB_ORDERS],
    setups,
    order,
    recipeOf: () => PLANNER_RECIPE,
    breweryFiles: plannerBreweryFiles,
    target: realTarget,
    script: async (setup) =>
      dryRun ? scriptedPlan(readFileSync(order(setup), 'utf8').split(/\r?\n/)[0] ?? '') : {},
    // No step is scripted on a real run.
    scriptedStep: '',
    next: (records) => nextRunOf(setups, records, 1, plannerFailure),
    recordOf: async (events, _setup, planned) =>
      plannerRecordOf(events, (id, worktree) =>
        dryRun ? scriptedTranscript(worktree, planned.get(id) ?? 'no plan') : transcriptOf(id),
      ),
    table: plannerTable,
    stop: plannerStop,
    files: keptFiles,
  };
};

/** Brews every run of `mode` that has no record yet, and prints its one table. */
const compare = async <Setup extends string, Run extends RunRecord<Setup>>(
  mode: Mode<Setup, Run>,
): Promise<void> => {
  const folder = modeFolder(mode.folders);
  const resultsFile = join(folder, 'results.jsonl');
  const readRecords = (): Run[] => readRecordsIn<Setup, Run>(folder);

  /** Brews one run of `setup` in `scratch`, and reads what it measured from the store. */
  const brewRun = async (setup: Setup, scratch: string): Promise<Omit<Run, 'run' | 'retry'>> => {
    const ownGit = gitEnvOf(scratch);
    Object.assign(process.env, ownGit);
    const git = async (cwd: string, args: string[]): Promise<string> => {
      const result = await runGit(cwd, args, { config: DEMO_GIT_CONFIG, env: ownGit });
      if (result.code !== 0) {
        throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr.trim()}`);
      }
      return result.stdout;
    };
    await removeTree(scratch);
    mkdirSync(scratch, { recursive: true });
    write(ownGit.GIT_CONFIG_GLOBAL, gitConfig(join(scratch, 'web.git')));

    await mode.target(setup, scratch, git);
    const web = join(scratch, 'web');
    const [title = '', ...bodyLines] = readFileSync(mode.order(setup), 'utf8').split(/\r?\n/);
    const script = await mode.script(setup, scratch, git);

    // The Brewery: Nip's fixture files with the default models (no models.jsonc of theirs), and the
    // mode's own files: its recipes, any brewer it replaces, and any models.jsonc.
    const { 'models.jsonc': _, ...nipFiles } = nipBreweryFiles({
      brewery: BREWERY,
      target: TARGET,
      user: USER,
    });
    await git(scratch, ['init', '-q', '--bare', '--initial-branch=main', 'brewery.git']);
    await git(scratch, ['clone', '-q', 'brewery.git', 'brewery']);
    const brewery = join(scratch, 'brewery');
    for (const [path, text] of Object.entries({
      ...nipFiles,
      ...mode.breweryFiles(setup),
    })) {
      write(join(brewery, path), text);
    }
    await git(brewery, ['add', '--all']);
    await git(brewery, ['commit', '-q', '-m', 'Start the Brewery']);
    await git(brewery, ['push', '-q', 'origin', 'main']);
    write(join(brewery, '.foedrum', 'local.jsonc'), localConfig(join(scratch, 'work'), web));

    const readIfThere = (path: string): string | undefined =>
      existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    const ready = serveSetup({
      root: brewery,
      home: join(scratch, 'home'),
      platform: process.platform,
      env: process.env,
      files: {
        config: readIfThere(join(brewery, 'foedrum.jsonc')),
        local: readIfThere(join(brewery, '.foedrum', 'local.jsonc')),
        models: readIfThere(join(brewery, 'models.jsonc')),
        brewery: readBreweryFiles(brewery),
      },
      diagnosis: {
        tools: [{ name: 'claude', version: undefined, path: claude }],
        isolation: { level: 'permissions only', why: 'the Tasters only read the change' },
        problems: [],
      },
    });
    if (ready.kind === 'refused') throw new Error(`serve refused: ${ready.problems.join('; ')}`);
    const { setup: serve } = ready;

    const api = fakeGitHubApi({
      login: LOGIN,
      issues: {
        [BREWERY]: [
          {
            number: 1,
            title,
            body: bodyLines.join('\n'),
            labels: [`recipe:${mode.recipeOf(setup)}`],
            author: USER,
          },
        ],
      },
    });
    api.comments.set(`${BREWERY.toLowerCase()}#1`, mode.comments?.(setup, USER) ?? []);
    const planned = new Map<string, string>();
    const listening = listenWhileServing(process);
    const machine = serveShell(serve, {
      root: brewery,
      git: runGit,
      out: (line) => say(`  ${line}`),
      listen: listening.listen,
      command: 'brew',
    });
    const shell: ServeShell = {
      ...machine,
      gh: ghOver(api.fetch).exec,
      runner: (claudePath, plan): BrewerRunner => {
        // What the runner's command line is made of, so a run shows the effort no transcript records.
        const shownPlan = async (start: AttemptStart): Promise<ClaudeAttemptPlan> => {
          const made = await plan(start);
          const { model, effort, session } = made.call;
          if (start.ref.stepId !== mode.scriptedStep) {
            say(`  ${start.ref.stepId}: --model ${model} --effort ${effort}`);
          }
          planned.set(session.id, model);
          return made;
        };
        const real = machine.runner(claudePath, shownPlan);
        const scripted = scriptedNip({
          plan: shownPlan,
          git: runGit,
          config: DEMO_GIT_CONFIG,
          write,
          script,
        });
        const runnerOf = (stepId: string): BrewerRunner =>
          stepId === mode.scriptedStep || dryRun ? scripted : real;
        return {
          progress: (ref) => runnerOf(ref.stepId).progress(ref),
          start: (start) => runnerOf(start.ref.stepId).start(start),
        };
      },
    };
    const started = Date.now();
    try {
      await runBrew(serve, shell, {
        target: { issue: 1 },
        owner: USER,
        by: USER,
        via: 'terminal',
        noSessions: 'no-terminal',
      });
    } finally {
      listening.stop();
    }
    const wallMs = Date.now() - started;
    // runBrew closes its store when it ends: the run's events are read from it again.
    const store = machine.openStore(serve.store);
    let events: ReturnType<EventStore['eventsAfter']>;
    try {
      events = store.eventsAfter(0);
    } finally {
      store.close();
    }
    const measured = await mode.recordOf(events, setup, planned, { scratch, git });
    return { ...measured, setup, wallMs } as Omit<Run, 'run' | 'retry'>;
  };

  mkdirSync(folder, { recursive: true });
  say(
    `tasting-compare: ${runs} runs of ${mode.setups.join(', ')} in ${folder}${dryRun ? ', the brewers scripted' : ', on the real claude'}`,
  );
  for (
    let next = mode.next(readRecords(), runs);
    next !== undefined;
    next = mode.next(readRecords(), runs)
  ) {
    const name = `${next.setup}-${next.run}${next.retry ? '-retry' : ''}`;
    say(`tasting-compare: ${name}`);
    let record: Run;
    try {
      record = {
        ...(await brewRun(next.setup, join(folder, scratchNameOf(name)))),
        run: next.run,
        ...(next.retry ? { retry: true as const } : {}),
      } as Run;
      const stop = mode.stop?.(record);
      if (stop !== undefined) throw new Error(stop);
    } catch (error) {
      // A run the harness could not brew is no measurement: stop, and say why.
      process.stderr.write(`tasting-compare: ${name} could not run: ${(error as Error).message}\n`);
      process.exit(1);
    }
    appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
    say(`tasting-compare: ${name} ended ${record.ended} in ${Math.round(record.wallMs / 1000)} s`);
  }
  const records = readRecords();
  const table = mode.table(records);
  writeFileSync(join(folder, 'table.md'), table);
  for (const [path, text] of Object.entries(mode.files?.(records, folder) ?? {})) {
    write(join(folder, path), text);
  }
  say('');
  process.stdout.write(table);
};

await (subOrders
  ? compare(await plannerMode())
  : brewerSettings !== undefined
    ? compare(await brewerMode(brewerSettings))
    : values.real === true
      ? compare(await realMode())
      : values.plan === true
        ? compare(planMode())
        : compare(diffMode()));
