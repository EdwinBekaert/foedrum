// node scripts/tasting-compare.ts [--runs <n>] [--dry-run] (#567, ADR 0224): tastes the seeded
// change of tasting-room/seeded 3 times in each of three setups, the seven default diff
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
// scripts/tasting-compare/core.ts, which mode the options run is scripts/tasting-compare/options.ts,
// and the brewing of each run is scripts/tasting-compare/harness.ts.
//
// With --model <level or id> --effort <effort> (#602, ADR 0405) every Taster step of the three
// setups runs on that level, or on a model id through models.jsonc's strong as --brewer taster maps
// it, at that effort; no other step moves. Its records, runs and table are kept apart under
// .foedrum/tmp/tasting-compare/seeded/<model>-<effort>, and the table's first line names the model
// and effort asked and the models the Tasters' receipts named.
//
// With --plan (#804, ADR 0323) it tastes the seeded plan of tasting-room/seeded/plan
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
// With --real --brewer taster --model <level or id> --effort <effort> --lenses apart|together
// --rules reads|bare (#937, ADR 0402) it tastes the three heads with a Taster setup built from
// those settings instead of a fixed one: real-nip's three lenses, a Taster each or one for all,
// with the Taster that reads the rules or its bare cut, on a level as the defaults map it or on a
// model id through models.jsonc's strong. Its setup's name says all four, its records go beside the
// fixed setups', and the same lists score its runs, the settings named only in codes.md.
//
// With --real --sub-orders (#1052, ADR 0396) it plans each order once through the real Brewmaster
// as it ships, or scripted with --dry-run, and keeps a plan of one sub-order as that sub-order's
// text in real/sub-orders/<order>.md; --real --brewer cellarman --order-text plan then builds
// from that text instead of the order's own, and refuses before anything brews when it is missing.
//
// With --real --brewer cellarman --map (#1055, ADR 0398) a real Maltster's map step, on its own
// model and effort as it ships, comes before the scripted Gauger, and Cellarman reads its map, as in
// nip; scripted with --dry-run. Every brewer's run records each step's Grep, Glob and Read calls by
// its transcripts, and codes.md shows them, whether the run had a map and the map step's tokens.

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { claudeConfigDir } from '../src/cli/resume.ts';
import { resolveExecutable } from '../src/platform/executables.ts';
import { runGit } from '../src/workspace/git.ts';
import type { Scripted } from '../test/helpers/nip-fixture.ts';
import { BREWERY, TARGET, USER } from './demo/core.ts';
import {
  AFTER_ROUND_ONE,
  IMPLEMENT,
  nextRun,
  nextRunOf,
  type RunRecord,
  readKey,
  recordOf,
  runFailure,
  SETUPS,
  type SetupName,
  scriptedTastings,
  seededBreweryFiles,
  seededFolders,
  summarize,
  tableMarkdown,
  tasterLine,
} from './tasting-compare/core.ts';
import { compare, type Mode, patchedTarget, type RunGit } from './tasting-compare/harness.ts';
import { TASTING_OPTIONS, type TastingMode, tastingModeOf } from './tasting-compare/options.ts';
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
  type BrewerSetup,
  blinded,
  brewerBlinded,
  brewerBreweryFiles,
  brewerRecordOf,
  brewerScript,
  brewerStop,
  brewerTable,
  changedFiles,
  codeDiffArgs,
  comparisonStop,
  keptFiles,
  nextBrewerRun,
  orderFileOf,
  orderOf,
  PLANNER_RECIPE,
  type PlannerRecord,
  type PlannerSetup,
  plannerBreweryFiles,
  plannerFailure,
  plannerRecordOf,
  plannerStop,
  plannerTable,
  READS_TASTER,
  REAL_BREWER_RECIPE,
  REAL_ORDERS,
  type RealSetup,
  realBreweryFiles,
  realCommentsOf,
  realRecipeOf,
  realRecordOf,
  realTable,
  refuseMissingTexts,
  refuseSameTaster,
  scriptedPlan,
  scriptedRealTastings,
  scriptedTranscript,
  splitHead,
  TASTER_RECIPE,
  type TastedRecord,
  type TasterSetup,
  TODAY_COMMIT,
  tasterBreweryFiles,
} from './tasting-compare/real.ts';

const root = resolve(import.meta.dirname, '..');
const fixture = join(root, 'tasting-room', 'seeded');
const BASE = join(fixture, '0001-Start-pantry.patch');
const CHANGE = join(fixture, '0002-Remind-of-the-items-best-before-soon.patch');
const planFixture = join(fixture, 'plan');

const { values } = parseArgs({ options: TASTING_OPTIONS });
const chosen = tastingModeOf(values);
if (chosen.kind === 'refused') {
  process.stderr.write(`${chosen.message}\n`);
  process.exit(2);
}
/** The planning runs' folder, where a brewer's run from a kept sub-order reads it (ADR 0396). */
const SUB_ORDERS = 'sub-orders';
const { runs, dryRun } = chosen;
/** The mode of one kind, with the settings `tastingModeOf` chose for it. */
type ModeOf<Kind extends TastingMode['kind']> = Extract<TastingMode, { kind: Kind }>;
const claude = dryRun ? 'the scripted Taster, never started' : resolveExecutable('claude');
if (claude === undefined) {
  process.stderr.write('claude is not on the PATH: the comparison tastes with the real claude\n');
  process.exit(1);
}

const diffMode = ({ taster }: ModeOf<'seeded'>): Mode<SetupName> => {
  const key = readKey(readFileSync(join(fixture, 'key.json'), 'utf8'));
  return {
    folders: seededFolders(taster),
    setups: Object.keys(SETUPS) as SetupName[],
    order: () => join(fixture, 'order.md'),
    recipeOf: (setup) => setup,
    breweryFiles: (setup) => seededBreweryFiles(setup, taster),
    target: (_setup, scratch, git) => patchedTarget(BASE, scratch, git),
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
    table: (records) => {
      const table = tableMarkdown(summarize(records, key), key);
      return taster === undefined ? table : `${tasterLine(taster, records)}\n\n${table}`;
    },
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
    target: (_setup, scratch, git) => patchedTarget(BASE, scratch, git),
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
const realFixture = join(root, 'tasting-room', 'real');

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

/**
 * The real mode: the fixed setups --setups chooses, or with `settings` the Taster setup they build
 * (ADR 0402), whose records go beside the fixed setups' and whose runs the same lists score.
 */
const realMode = async (
  mode: ModeOf<'real' | 'taster'>,
): Promise<Mode<RealSetup | TasterSetup, TastedRecord>> => {
  const { setups, folders: realFolderOf } = mode;
  const settings = mode.kind === 'taster' ? mode.settings : undefined;
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
  const tasters = { today: today.stdout, reads };
  return {
    folders: realFolderOf,
    setups,
    order: (setup) => join(realFixture, `${orderOf(setup).order}.md`),
    recipeOf: (setup) =>
      settings === undefined ? realRecipeOf(setup as RealSetup) : TASTER_RECIPE,
    breweryFiles: (setup) =>
      settings === undefined
        ? realBreweryFiles(setup as RealSetup, tasters)
        : tasterBreweryFiles(settings, tasters),
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
    next: (records, runCount) => nextRunOf(setups, records, runCount, runFailure),
    recordOf: async (events, _setup, planned) =>
      realRecordOf(
        events,
        (id, worktree) =>
          dryRun ? scriptedTranscript(worktree, planned.get(id) ?? 'no plan') : transcriptOf(id),
        settings,
      ),
    table: realTable,
    stop: comparisonStop,
    comments: (setup, author) =>
      settings === undefined
        ? realCommentsOf(setup as RealSetup, author, (file) =>
            readFileSync(join(realFixture, file), 'utf8'),
          )
        : [],
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
 * A real brewer's mode (ADR 0394): each order's base, with --map the Maltster's map step first
 * (ADR 0398), the head's test files committed by the scripted Gauger, then Cellarman on the given model and effort, real or scripted with --dry-run,
 * and the repository's checks on its code. Its records stay in a folder of their own beside the
 * Tasters' setups'.
 */
const brewerMode = async ({
  settings,
  setups,
  folders: realFolderOf,
}: ModeOf<'brewer'>): Promise<Mode<BrewerSetup, BrewerRecord>> => {
  await realCommits();
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
        settings.map === true,
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
const plannerMode = async ({
  setups,
  folders: realFolderOf,
}: ModeOf<'planner'>): Promise<Mode<PlannerSetup, PlannerRecord>> => {
  await realCommits();
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

/** Brews `mode` in its folder with the options' runs. */
const brew = <Setup extends string, Run extends RunRecord<Setup>>(
  mode: Mode<Setup, Run>,
): Promise<void> => compare(mode, { folder: modeFolder(mode.folders), runs, dryRun, claude });

switch (chosen.kind) {
  case 'planner':
    await brew(await plannerMode(chosen));
    break;
  case 'taster':
  case 'real':
    await brew(await realMode(chosen));
    break;
  case 'brewer':
    await brew(await brewerMode(chosen));
    break;
  case 'plan':
    await brew(planMode());
    break;
  case 'seeded':
    await brew(diffMode(chosen));
    break;
  default: {
    const unknown: never = chosen;
    throw new Error(`no mode ${JSON.stringify(unknown)}`);
  }
}
