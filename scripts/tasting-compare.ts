// node scripts/tasting-compare.ts [--runs <n>] [--dry-run] (#567, ADR 0224): tastes the seeded
// change of test/fixtures/tasting-compare 3 times in each of three setups, the seven default diff
// lenses apart, the seven together and Nip's three together, and prints one table of the planted
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
// With --real (#879, ADR 0332) it tastes three brewed heads of this repository instead, each in three
// setups, and #867 in a fourth with its maintainer's comment (ADR 0333): the target is the order's
// base fetched from this checkout, a scripted Cellarman commits the head's changed files, and nip's
// three Tasters, with design conformance as a fourth in the lens setup (ADR 0337), run on the real
// claude, or scripted with --dry-run. It reads each Taster's transcript for what it read, and stops
// at once on a transcript that cannot say. It writes one blinded list per order and one file of its
// bodies under
// .foedrum/tmp/tasting-compare/real, the setups named only in codes.md. It scores nothing. Its
// decisions are scripts/tasting-compare/real.ts.

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
import { runBrew } from '../src/cli/brew.ts';
import { claudeConfigDir } from '../src/cli/resume.ts';
import type { ServeShell } from '../src/cli/serve.ts';
import { serveSetup } from '../src/cli/serve-config.ts';
import { listenWhileServing, serveShell } from '../src/cli/serve-shell.ts';
import type { BrewerRunner } from '../src/engine/brewer-runner.ts';
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
  IMPLEMENT,
  nextRun,
  type RunRecord,
  readKey,
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
  blinded,
  changedFiles,
  comparisonStop,
  nextRealRun,
  orderOf,
  REAL_ORDERS,
  REAL_SETUPS,
  type RealSetup,
  realBreweryFiles,
  realCommentsOf,
  realRecipeOf,
  realRecordOf,
  realTable,
  refuseSameTaster,
  scriptedRealTastings,
  scriptedTranscript,
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
  },
});
if (values.plan === true && values.real === true) {
  process.stderr.write('--plan and --real are two comparisons: give one of them\n');
  process.exit(2);
}
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

/** What a comparison brews and how it reads the runs: the diff, plan or real mode's. */
interface Mode<Setup extends string> {
  /** Its folders under .foedrum/tmp/tasting-compare: its records and runs stay its own. */
  folders: readonly string[];
  setups: readonly Setup[];
  /** The file of a run's order: its title on the first line. */
  order: (setup: Setup) => string;
  /** The recipe a run's order is labelled for. */
  recipeOf: (setup: Setup) => string;
  /** The Brewery's files of a run beyond Nip's, by path: its recipes, and any brewer it replaces. */
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
    records: readonly RunRecord<Setup>[],
    runs: number,
  ) => { setup: Setup; run: number; retry: boolean } | undefined;
  recordOf: (
    events: readonly { event: Event }[],
    setup: Setup,
  ) => Pick<RunRecord, 'ended' | 'attempts'>;
  table: (records: readonly RunRecord<Setup>[]) => string;
  /** Why a run shows the comparison itself cannot go on: the harness's fault, never a Taster's. */
  stop?: (record: Pick<RunRecord<Setup>, 'attempts'>) => string | undefined;
  /** More files of its report, by path in its folder. */
  files?: (records: readonly RunRecord<Setup>[], folder: string) => Record<string, string>;
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
      return { [IMPLEMENT]: [implement], ...(dryRun ? scriptedTastings(setup, key) : {}) };
    },
    scriptedStep: IMPLEMENT,
    next: nextRun,
    recordOf,
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
      [PLAN_STEP]: [seeded],
      ...(dryRun ? scriptedPlanTastings(setup, key) : {}),
    }),
    scriptedStep: PLAN_STEP,
    next: nextPlanRun,
    recordOf: planRecordOf,
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

const realMode = async (): Promise<Mode<RealSetup>> => {
  /** A commit's whole id in this checkout, where the heads and the old Taster are read. */
  const commitIn = async (commit: string): Promise<string> => {
    const { code, stdout } = await runGit(root, ['rev-parse', '--verify', `${commit}^{commit}`]);
    if (code !== 0) {
      throw new Error(`the commit ${commit} is not in this checkout: run git fetch origin first`);
    }
    return stdout.trim();
  };
  for (const { base, head } of REAL_ORDERS) {
    await commitIn(base);
    await commitIn(head);
  }
  const today = await runGit(root, [
    'show',
    `${await commitIn(TODAY_COMMIT)}:defaults/brewers/taster.md`,
  ]);
  if (today.code !== 0) {
    throw new Error(`the Taster of ${TODAY_COMMIT} cannot be read: ${today.stderr.trim()}`);
  }
  const current = readFileSync(join(root, 'defaults', 'brewers', 'taster.md'), 'utf8');
  refuseSameTaster(today.stdout, current);
  const folder = join(fixture, 'real');
  return {
    folders: ['real'],
    setups: REAL_SETUPS,
    order: (setup) => join(folder, `${orderOf(setup).order}.md`),
    recipeOf: realRecipeOf,
    breweryFiles: (setup) => realBreweryFiles(setup, { today: today.stdout, current }),
    target: async (setup, scratch, git) => {
      // Only the base: later history stays out of the scratch remote, whatever a Taster may run.
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
    },
    script: async (setup, _scratch, git) => {
      const { base, head } = orderOf(setup);
      const changed = changedFiles(
        await git(root, ['diff', '--name-status', '-z', '--no-renames', base, head]),
      );
      const files: Record<string, string> = {};
      for (const path of changed) files[path] = await git(root, ['show', `${head}:${path}`]);
      const subject = (await git(root, ['log', '-1', '--format=%s', head])).trim();
      const implement: Scripted = {
        files,
        message: subject,
        summary: `The head ${head}, committed as it was brewed.`,
      };
      return {
        [IMPLEMENT]: [implement],
        ...(dryRun ? scriptedRealTastings(changed[0] ?? '') : {}),
      };
    },
    scriptedStep: IMPLEMENT,
    next: nextRealRun,
    recordOf: (events) =>
      realRecordOf(events, (id, worktree) =>
        dryRun ? scriptedTranscript(worktree) : transcriptOf(id),
      ),
    table: realTable,
    stop: comparisonStop,
    comments: (setup, author) =>
      realCommentsOf(setup, author, (file) => readFileSync(join(folder, file), 'utf8')),
    files: (records, reportFolder) => {
      // One seed for the folder, so a code stays the same as more runs come in.
      const seedFile = join(reportFolder, 'seed.txt');
      if (!existsSync(seedFile)) writeFileSync(seedFile, randomBytes(16).toString('hex'));
      const { lists, bodies, codes } = blinded(records, readFileSync(seedFile, 'utf8'));
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

/** Brews every run of `mode` that has no record yet, and prints its one table. */
const compare = async <Setup extends string>(mode: Mode<Setup>): Promise<void> => {
  const folder = join(
    root,
    '.foedrum',
    'tmp',
    'tasting-compare',
    ...mode.folders,
    ...(dryRun ? ['dry-run'] : []),
  );
  const resultsFile = join(folder, 'results.jsonl');
  const readRecords = (): RunRecord<Setup>[] =>
    existsSync(resultsFile)
      ? readFileSync(resultsFile, 'utf8')
          .split(/\r?\n/)
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as RunRecord<Setup>)
      : [];

  /** Brews one run of `setup` in `scratch`, and reads its Tasters' attempts from the store. */
  const brewRun = async (setup: Setup, scratch: string): Promise<Omit<RunRecord<Setup>, 'run'>> => {
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

    // The Brewery: Nip's fixture files with the default models (no models.jsonc), and the mode's own
    // files: its recipes, and any brewer it replaces.
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
        const real = machine.runner(claudePath, plan);
        const scripted = scriptedNip({
          plan,
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
    return { setup, wallMs, ...mode.recordOf(events, setup) };
  };

  mkdirSync(folder, { recursive: true });
  say(
    `tasting-compare: ${runs} runs of ${mode.setups.join(', ')} in ${folder}${dryRun ? ', the Tasters scripted' : ', the Tasters on the real claude'}`,
  );
  for (
    let next = mode.next(readRecords(), runs);
    next !== undefined;
    next = mode.next(readRecords(), runs)
  ) {
    const name = `${next.setup}-${next.run}${next.retry ? '-retry' : ''}`;
    say(`tasting-compare: ${name}`);
    let record: RunRecord<Setup>;
    try {
      record = {
        ...(await brewRun(next.setup, join(folder, name))),
        run: next.run,
        ...(next.retry ? { retry: true as const } : {}),
      };
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

await (values.real === true
  ? compare(await realMode())
  : values.plan === true
    ? compare(planMode())
    : compare(diffMode()));
