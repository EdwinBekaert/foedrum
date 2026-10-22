// M1's exit (#180, ADR 0121): a labelled issue in a throwaway Brewery becomes a pull request end to
// end through `foedrum serve`'s own runServe and serveShell, with Nip from `defaults/`. Real: git,
// the attempt worktrees, the target's own `node --test` in the check steps, the red proof, the
// testsUnchanged guard, the recipe loader and serve's shell. Faked: GitHub, the tests' fake code
// host behind the fake gh (ADR 0073), and the brewers, the scripted Gauger and Cellarman of the
// Nip fixture, so no model runs. The Gauger's test is proved red, the Cellarman's first fix fails
// the check, its second attempt gets that reading (ADR 0128) and passes, and openPullRequest pushes
// the bottle branch and opens the pull request. Opt-in with FOEDRUM_REAL_CLAUDE=1 (ADR 0057), the
// same run has the real claude runner against the fake Messages API, which plays both brewers.

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEMO_GIT_CONFIG } from '../../scripts/demo/brewer.ts';
import {
  BREWERY,
  DIAGNOSIS,
  gitConfig,
  gitEnvOf,
  LOGIN,
  lifeEndOf,
  TARGET,
  USER,
} from '../../scripts/demo/core.ts';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import { diagnose } from '../../src/cli/doctor.ts';
import { gatherDoctorFacts } from '../../src/cli/doctor-facts.ts';
import { runServe, type ServeShell } from '../../src/cli/serve.ts';
import { type ServeInputs, serveSetup } from '../../src/cli/serve-config.ts';
import { serveShell } from '../../src/cli/serve-shell.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import type { AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { fold } from '../../src/engine/fold.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { removeTree } from '../../src/platform/remove.ts';
import type { Event } from '../../src/schemas/events.ts';
import { type Git, runGit } from '../../src/workspace/git.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { hangGuardMs } from '../helpers/load.ts';
import {
  NIP_ORDER,
  NIP_SCRIPT,
  NIP_TARGET_FILES,
  nipBreweryFiles,
  scriptedNip,
} from '../helpers/nip-fixture.ts';
import { realClaude } from '../helpers/real-claude.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { cannedGhLogin, resolveWithMadeUpGh } from './canned-gh-login.ts';
import { type FakeMessagesApi, startFakeMessagesApi, type ToolCall } from './fake-messages-api.ts';

/** serve ticks every 100 ms instead of every 5 s. */
const INTERVAL_MS = 100;
/**
 * Only a guard against a hang (ADR 0070): seven attempts, each with its worktree, its fetches and
 * for a check its test run, took over two minutes on a loaded Windows laptop.
 */
const RUN_GUARD_MS = 5 * hangGuardMs;
const BATCH = `${NIP_ORDER.number}-1`;

/** The brewers of a run, in serve's runner seam; serve's own claude runner when not given. */
type Brewers = (
  plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>,
  git: Git,
  write: (path: string, text: string) => void,
) => BrewerRunner;

interface Brewed {
  output: string;
  events: Event[];
  api: ReturnType<typeof fakeGitHubApi>;
  /** git with the run's own configuration, and the run's folder. */
  run: (cwd: string, args: string[]) => Promise<string>;
}

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/**
 * The target repository and the Brewery, each a clone of a bare remote in `scratch`, and serve's
 * runServe on them until the batch is on tap with its status comment, or Stuck.
 */
const brewNip = async (
  scratch: string,
  options: { env: Record<string, string | undefined>; diagnosis: ServeInputs['diagnosis'] },
  brewers?: Brewers,
): Promise<Brewed> => {
  // Every git of the run reads only the fixture's configuration: an identity, no signing, and
  // the target's GitHub URL sent to its bare remote here (ADR 0096); no other GitHub URL works.
  const ownEnv = gitEnvOf(scratch);
  writeFileSync(ownEnv.GIT_CONFIG_GLOBAL, gitConfig(join(scratch, 'web.git')));
  const git: Git = (cwd, args, gitOptions = {}) =>
    runGit(cwd, args, { ...gitOptions, env: { ...ownEnv, ...gitOptions.env } });
  const run = async (cwd: string, args: string[]): Promise<string> => {
    const result = await git(cwd, args, { config: DEMO_GIT_CONFIG });
    assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  /** A bare remote `<name>.git` and a clone of it at `<name>` with `files` on main. */
  const repository = async (name: string, files: Record<string, string>): Promise<string> => {
    const clone = join(scratch, name);
    await run(scratch, ['init', '-q', '--bare', '--initial-branch=main', `${name}.git`]);
    await run(scratch, ['clone', '-q', `${name}.git`, name]);
    for (const [path, text] of Object.entries(files)) write(join(clone, path), text);
    await run(clone, ['add', '--all']);
    await run(clone, ['commit', '-q', '-m', `Start ${name}`]);
    await run(clone, ['push', '-q', 'origin', 'main']);
    return clone;
  };
  const files = nipBreweryFiles({ brewery: BREWERY, target: TARGET, user: USER });
  const web = await repository('web', NIP_TARGET_FILES);
  const brewery = await repository('brewery', files);
  const local = JSON.stringify({ workRoot: join(scratch, 'work'), clones: { [TARGET]: web } });
  write(join(brewery, '.foedrum', 'local.jsonc'), local);

  const ready = serveSetup({
    root: brewery,
    home: join(scratch, 'home'),
    platform: process.platform,
    env: { ...options.env, ...ownEnv },
    files: {
      config: files['foedrum.jsonc'],
      local,
      models: files['models.jsonc'],
      brewery: readBreweryFiles(brewery),
    },
    diagnosis: options.diagnosis,
  });
  assert.equal(ready.kind, 'ready', ready.kind === 'refused' ? ready.problems.join('\n') : '');
  if (ready.kind !== 'ready') throw new Error('serve refused the Brewery');
  const { setup } = ready;

  // The code host: the Brewery's one labelled issue, by the user who may order work.
  const api = fakeGitHubApi({
    login: LOGIN,
    issues: { [BREWERY]: [{ ...NIP_ORDER, labels: [...NIP_ORDER.labels], author: USER }] },
  });
  const lines: string[] = [];
  const ended = new AbortController();
  const guard = setTimeout(() => ended.abort(), RUN_GUARD_MS);
  let store: EventStore | undefined;
  const machine = serveShell(setup, { root: brewery, git, out: (line) => lines.push(line) });
  const shell: ServeShell = {
    ...machine,
    signal: AbortSignal.any([machine.signal, ended.signal]),
    intervalMs: INTERVAL_MS,
    openStore: (path) => {
      store = machine.openStore(path);
      return store;
    },
    // Between ticks: serve stops once the batch is on tap with its status comment, or Stuck.
    wait: async (ms, signal) => {
      if (lifeEndOf(store?.eventsAfter(0) ?? []) === undefined) return machine.wait(ms, signal);
      ended.abort();
    },
    runner: (claude, plan) =>
      brewers === undefined ? machine.runner(claude, plan) : brewers(plan, git, write),
    gh: ghOver(api.fetch).exec,
  };
  let code: number;
  try {
    code = await runServe(setup, shell);
  } finally {
    clearTimeout(guard);
  }
  const output = lines.join('\n');
  assert.equal(code, 0, output);
  const reopened = openSqliteEventStore(join(brewery, '.foedrum', 'index.db'));
  try {
    return { output, events: reopened.eventsAfter(0).map(({ event }) => event), api, run };
  } finally {
    reopened.close();
  }
};

/**
 * The batch on tap with exactly one pull request and one status comment, every step's outcome in
 * order, the route from green back to implement, the effects, and the Gauger's test and the
 * Cellarman's fixes on the bottle branch of the target's remote.
 */
const assertBrewed = async ({ output, events, api, run }: Brewed, scratch: string) => {
  const dump = `${output}\n${JSON.stringify(events, null, 1)}`;
  const lane = fold(events).batches.get(BATCH)?.lane;
  assert.equal(lane?.kind, 'on_tap', dump);
  const pulls = api.pulls;
  assert.equal(pulls.length, 1, JSON.stringify(pulls));
  const [pull] = pulls;
  assert.deepEqual(lane, {
    kind: 'on_tap',
    pullRequests: [`https://github.com/${TARGET}/pull/${pull?.number}`],
  });

  // The red proof read the Gauger's test red, the first green check failed and sent the batch
  // back to the Cellarman, and the second one passed.
  const outcomes = events.flatMap((event) =>
    event.type === 'step.finished'
      ? [`${event.stepId}#${event.attempt} ${event.outcome.kind}`]
      : [],
  );
  assert.deepEqual(
    outcomes,
    [
      'gauge#1 succeeded',
      'red#1 succeeded',
      'implement#1 succeeded',
      'green#1 failed',
      'implement#2 succeeded',
      'green#2 succeeded',
      'open-pull-request#1 succeeded',
    ],
    dump,
  );
  const routes = events.flatMap((event) =>
    event.type === 'step.scheduled' && event.route !== undefined
      ? [[event.stepId, event.route.from]]
      : [],
  );
  assert.deepEqual(routes, [['implement', 'green']], dump);

  // The effects, each applied once: the pull request, and the status comment's revisions.
  const effects = events.flatMap((event) =>
    event.type === 'effect.applied' ? [effectKey.decode(event.key)] : [],
  );
  assert.deepEqual(
    effects.filter(({ effect }) => effect === 'pull_request'),
    [{ batchId: BATCH, effect: 'pull_request' }],
  );
  assert.ok(
    effects.some(({ effect }) => effect.startsWith('status.')),
    JSON.stringify(effects),
  );
  const comments = api.comments.get(`${BREWERY}#${NIP_ORDER.number}`) ?? [];
  assert.equal(comments.length, 1, JSON.stringify(comments));
  assert.match(comments[0]?.body ?? '', /On tap/);

  // The bottle branch: the Gauger's test, then the Cellarman's two fixes.
  assert.equal(pull?.base, 'main');
  assert.equal(pull?.title, NIP_ORDER.title);
  const gitDir = join(scratch, 'web.git');
  const log = await run(scratch, [
    '--git-dir',
    gitDir,
    'log',
    '--format=%s',
    pull?.head ?? '',
    '--not',
    'main',
  ]);
  assert.deepEqual(log.trim().split('\n'), [
    NIP_SCRIPT.implement?.[1]?.message,
    NIP_SCRIPT.implement?.[0]?.message,
    NIP_SCRIPT.gauge?.[0]?.message,
  ]);
};

/** The route input of the Cellarman's second attempt, with the failing assertion (ADR 0128). */
const ROUTE = /why step implement runs again: the failed checks of step green/;
const FAILED_READING = /Hello, stranger/;

describe('the Nip recipe end to end', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('nip');
  });
  afterEach(() => removeTree(dir.path));

  it('brews a labelled issue into one pull request through a red proof and a failed check', async () => {
    let brewers: ReturnType<typeof scriptedNip> | undefined;
    const brewed = await brewNip(
      dir.path,
      { env: process.env, diagnosis: DIAGNOSIS },
      (plan, git) => {
        brewers = scriptedNip({ plan, git, config: DEMO_GIT_CONFIG, write });
        return brewers;
      },
    );
    await assertBrewed(brewed, dir.path);

    // The Cellarman's second attempt was told why it runs again; its first attempt was not.
    const prompts = brewers?.prompts ?? new Map<string, string>();
    const promptOf = (attempt: number) =>
      prompts.get(attemptKey.encode({ batchId: BATCH, stepId: 'implement', attempt })) ?? '';
    assert.ok(promptOf(1) !== '' && promptOf(2) !== '', [...prompts.keys()].join(', '));
    assert.doesNotMatch(promptOf(1), ROUTE);
    assert.match(promptOf(2), ROUTE);
    assert.match(promptOf(2), FAILED_READING);
  });
});

const real = realClaude();

describe('the Nip recipe end to end with the real claude', {
  skip: real.kind === 'skip' && real.reason,
}, () => {
  let dir: TempDir;
  let api: FakeMessagesApi | undefined;
  beforeEach(() => {
    dir = makeTempDir('nip-real');
  });
  afterEach(async () => {
    await api?.close();
    await removeTree(dir.path);
  });

  it('brews the same order with claude playing the Gauger and the Cellarman from a fake model', async () => {
    const scratch = dir.path;
    // The attempt's worktree, where serve makes it.
    const worktree = (step: string, attempt: number) =>
      join(
        realpathSync(join(scratch, 'work')),
        TARGET.replace('/', '.'),
        'attempts',
        BATCH,
        step,
        String(attempt),
      );
    /** The attempt's files written over what it read, its commit, then its out doc. */
    const brew = (step: string, attempt: number, doc: string): ToolCall[] => {
      const scripted = NIP_SCRIPT[step]?.[attempt - 1];
      assert.ok(scripted !== undefined);
      const cwd = worktree(step, attempt);
      const paths = Object.keys(scripted.files);
      return [
        ...paths.flatMap((path) => [
          { name: 'Read', input: { file_path: join(cwd, path) } },
          { name: 'Write', input: { file_path: join(cwd, path), content: scripted.files[path] } },
        ]),
        { name: 'Bash', input: { command: `git add ${paths.join(' ')}`, description: 'Stage' } },
        {
          name: 'Bash',
          input: { command: `git commit -q -m "${scripted.message}"`, description: 'Commit' },
        },
        {
          name: 'Write',
          input: {
            file_path: join(cwd, doc),
            content: outDoc({ status: 'done', summary: scripted.summary }),
          },
        },
      ];
    };
    // A push no allow rule matches: denied on every isolation level (ADR 0062, ADR 0087).
    const probe: ToolCall = {
      name: 'Bash',
      input: { command: 'git push origin HEAD:refs/heads/probe', description: 'Push' },
    };
    api = await startFakeMessagesApi((body) => {
      if (body.includes('# Gauger')) return [probe, ...brew('gauge', 1, 'gauge.md')];
      return brew('implement', ROUTE.test(body) ? 2 : 1, 'brew.md');
    });
    const user = join(scratch, 'user');
    mkdirSync(user);
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: user,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
    };
    // The machine's own diagnosis, as serve's start asks doctor: the real claude, and the
    // isolation level this platform reaches. gh answers from captured output and is never
    // started (ADR 0073); the fake code host is GitHub here, so gh's login is no problem.
    const { tools, isolation, problems } = diagnose(
      await gatherDoctorFacts({
        exec: cannedGhLogin(),
        resolve: resolveWithMadeUpGh,
        platform: process.platform,
        kernelRelease: release(),
        node: process.versions.node,
        execPath: process.execPath,
        cwd: scratch,
      }),
    );
    const diagnosis = {
      tools,
      isolation,
      problems: problems.filter(({ what }) => !what.startsWith('gh is not logged in')),
    };
    const brewed = await brewNip(scratch, { env, diagnosis });
    await assertBrewed(brewed, scratch);

    // The model saw the route input only in the Cellarman's second session.
    const cellarman = api.bodies.filter((body) => body.includes('# Cellarman'));
    assert.ok(cellarman.some((body) => !ROUTE.test(body)));
    assert.ok(cellarman.some((body) => ROUTE.test(body) && FAILED_READING.test(body)));
    // The push was denied and never reached the remote.
    assert.ok(
      api.bodies.some((body) => /"is_error":true/.test(body)),
      'no tool result was an error',
    );
    const refs = await brewed.run(scratch, ['--git-dir', join(scratch, 'web.git'), 'show-ref']);
    assert.doesNotMatch(refs, /refs\/heads\/probe/);
  });
});
