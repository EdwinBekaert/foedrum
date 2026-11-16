// The brewing harness of scripts/tasting-compare.ts (#1100): brews each run of a mode with foedrum
// brew's own runBrew in a scratch Brewery and target repository, on npm run demo's seams (ADR 0097):
// the fake code host for gh, and a git configuration of its own whose insteadOf sends the target's
// GitHub URL to a scratch remote. The mode says what each run brews, which step is scripted and
// how its records read; a run already recorded is not brewed again.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import { runBrew } from '../../src/cli/brew.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { listenWhileServing, serveShell } from '../../src/cli/serve-shell.ts';
import type { AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { removeTree } from '../../src/platform/remove.ts';
import type { Event } from '../../src/schemas/events.ts';
import { runGit } from '../../src/workspace/git.ts';
import { ghOver } from '../../test/helpers/fake-gh.ts';
import { type FakeApiComment, fakeGitHubApi } from '../../test/helpers/fake-github-api.ts';
import { nipBreweryFiles, type Scripted, scriptedNip } from '../../test/helpers/nip-fixture.ts';
import { DEMO_GIT_CONFIG } from '../demo/brewer.ts';
import { BREWERY, gitConfig, gitEnvOf, LOGIN, localConfig, TARGET, USER } from '../demo/core.ts';
import { type RunRecord, readRecordsIn, scratchNameOf } from './core.ts';

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A git of a run: its output, or a throw that says what failed. */
export type RunGit = (cwd: string, args: string[]) => Promise<string>;

/** The target on main, as the diff and plan modes make it: the `base` patch, on its scratch remote. */
export const patchedTarget = async (base: string, scratch: string, git: RunGit): Promise<void> => {
  await git(scratch, ['init', '-q', '--bare', '--initial-branch=main', 'web.git']);
  await git(scratch, ['clone', '-q', 'web.git', 'web']);
  const web = join(scratch, 'web');
  await git(web, ['am', '-q', base]);
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
export interface Mode<Setup extends string, Run extends RunRecord<Setup> = RunRecord<Setup>> {
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

/** Where `compare` keeps a mode's records and files, how many runs of each setup it brews, and with what. */
interface CompareSettings {
  folder: string;
  runs: number;
  /** The brewers scripted, never the real claude. */
  dryRun: boolean;
  /** The claude serve's setup is told of. */
  claude: string;
}

/** Brews every run of `mode` that has no record yet, and prints its one table. */
export const compare = async <Setup extends string, Run extends RunRecord<Setup>>(
  mode: Mode<Setup, Run>,
  { folder, runs, dryRun, claude }: CompareSettings,
): Promise<void> => {
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
