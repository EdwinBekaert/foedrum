// node scripts/tasting-compare.ts [--runs <n>] [--dry-run] (#567, ADR 0224): tastes the seeded
// change of test/fixtures/tasting-compare 3 times in each of three setups, the seven default diff
// lenses apart, the seven together and Nip's two together, and prints one table of the planted
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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runBrew } from '../src/cli/brew.ts';
import type { ServeShell } from '../src/cli/serve.ts';
import { serveSetup } from '../src/cli/serve-config.ts';
import { listenWhileServing, serveShell } from '../src/cli/serve-shell.ts';
import type { BrewerRunner } from '../src/engine/brewer-runner.ts';
import { readBreweryFiles } from '../src/engine/brewery-files.ts';
import type { EventStore } from '../src/engine/event-store.ts';
import { resolveExecutable } from '../src/platform/executables.ts';
import { removeTree } from '../src/platform/remove.ts';
import { runGit } from '../src/workspace/git.ts';
import { ghOver } from '../test/helpers/fake-gh.ts';
import { fakeGitHubApi } from '../test/helpers/fake-github-api.ts';
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

const root = resolve(import.meta.dirname, '..');
const fixture = join(root, 'test', 'fixtures', 'tasting-compare');
const BASE = join(fixture, '0001-Start-pantry.patch');
const CHANGE = join(fixture, '0002-Remind-of-the-items-best-before-soon.patch');

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const { values } = parseArgs({
  options: { runs: { type: 'string' }, 'dry-run': { type: 'boolean' } },
});
const runs = Number(values.runs ?? '3');
if (!Number.isSafeInteger(runs) || runs < 1) {
  process.stderr.write(`--runs must be a whole number of at least 1, not ${values.runs}\n`);
  process.exit(2);
}
const dryRun = values['dry-run'] === true;
const folder = join(root, '.foedrum', 'tmp', 'tasting-compare', ...(dryRun ? ['dry-run'] : []));
const resultsFile = join(folder, 'results.jsonl');
const key = readKey(readFileSync(join(fixture, 'key.json'), 'utf8'));
const [title = '', ...bodyLines] = readFileSync(join(fixture, 'order.md'), 'utf8').split(/\r?\n/);
const claude = dryRun ? 'the scripted Taster, never started' : resolveExecutable('claude');
if (claude === undefined) {
  process.stderr.write('claude is not on the PATH: the comparison tastes with the real claude\n');
  process.exit(1);
}

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const readRecords = (): RunRecord[] =>
  existsSync(resultsFile)
    ? readFileSync(resultsFile, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as RunRecord)
    : [];

/** Brews one run of `setup` in `scratch`, and reads its Tasters' attempts from the store. */
const brewRun = async (setup: SetupName, scratch: string): Promise<Omit<RunRecord, 'run'>> => {
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

  // The target on main: the base patch, pushed to its scratch remote.
  await git(scratch, ['init', '-q', '--bare', '--initial-branch=main', 'web.git']);
  await git(scratch, ['clone', '-q', 'web.git', 'web']);
  const web = join(scratch, 'web');
  await git(web, ['am', '-q', BASE]);
  await git(web, ['push', '-q', 'origin', 'main']);
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

  // The Brewery: Nip's fixture files with the default models (no models.jsonc), and the recipe.
  const { 'models.jsonc': _, ...breweryFiles } = nipBreweryFiles({
    brewery: BREWERY,
    target: TARGET,
    user: USER,
  });
  await git(scratch, ['init', '-q', '--bare', '--initial-branch=main', 'brewery.git']);
  await git(scratch, ['clone', '-q', 'brewery.git', 'brewery']);
  const brewery = join(scratch, 'brewery');
  for (const [path, text] of Object.entries({
    ...breweryFiles,
    [`recipes/${setup}.jsonc`]: recipeText(setup),
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
          labels: [`recipe:${setup}`],
          author: USER,
        },
      ],
    },
  });
  const listening = listenWhileServing(process);
  const machine = serveShell(serve, {
    root: brewery,
    git: runGit,
    out: (line) => say(`  ${line}`),
    listen: listening.listen,
    command: 'brew',
  });
  const implement: Scripted = {
    files,
    message: subject,
    summary: 'The seeded change of #567, committed as it is.',
  };
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
        script: { [IMPLEMENT]: [implement], ...(dryRun ? scriptedTastings(setup, key) : {}) },
      });
      const runnerOf = (stepId: string): BrewerRunner =>
        stepId === IMPLEMENT || dryRun ? scripted : real;
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
  return { setup, wallMs, ...recordOf(events, setup) };
};

mkdirSync(folder, { recursive: true });
say(
  `tasting-compare: ${runs} runs of ${Object.keys(SETUPS).join(', ')} in ${folder}${dryRun ? ', the Tasters scripted' : ', the Tasters on the real claude'}`,
);
for (
  let next = nextRun(readRecords(), runs);
  next !== undefined;
  next = nextRun(readRecords(), runs)
) {
  const name = `${next.setup}-${next.run}${next.retry ? '-retry' : ''}`;
  say(`tasting-compare: ${name}`);
  let record: RunRecord;
  try {
    record = {
      ...(await brewRun(next.setup, join(folder, name))),
      run: next.run,
      ...(next.retry ? { retry: true as const } : {}),
    };
  } catch (error) {
    // A run the harness could not brew is no measurement: stop, and say why.
    process.stderr.write(`tasting-compare: ${name} could not run: ${(error as Error).message}\n`);
    process.exit(1);
  }
  appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
  say(`tasting-compare: ${name} ended ${record.ended} in ${Math.round(record.wallMs / 1000)} s`);
}
const table = tableMarkdown(summarize(readRecords(), key), key);
writeFileSync(join(folder, 'table.md'), table);
say('');
process.stdout.write(table);
