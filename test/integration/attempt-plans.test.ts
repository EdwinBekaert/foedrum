// One real step, end to end (#148): a driver brews an order's one-step recipe from the Brewery's
// files, with the real claude runner, the attempt plans and real attempt worktrees. A fake
// Messages API stands in for the model (no login, no tokens): its "model" makes and commits a
// change, as a brewer that produces commits must (ADR 0074), writes the out doc, then answers.
// Opt-in: it runs only with FOEDRUM_REAL_CLAUDE=1 (ADR 0057). It tests Foedrum's wiring, not
// whether claude works.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { claudeBrewerRunner } from '../../src/brewers/claude-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { type Driver, openDriver } from '../../src/engine/driver.ts';
import { lockDriver } from '../../src/engine/driver-lock.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { removeTree } from '../../src/platform/remove.ts';
import type { Answer } from '../../src/schemas/events.ts';
import { repoFolder } from '../../src/workspace/attempt-worktrees.ts';
import { openAttemptWorktrees } from '../../src/workspace/attempt-worktrees-git.ts';
import { runGit } from '../../src/workspace/git.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';
import { waitUntil } from '../helpers/load.ts';
import { realClaude } from '../helpers/real-claude.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { type FakeMessagesApi, startFakeMessagesApi, type ToolCall } from './fake-messages-api.ts';

const real = realClaude();

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// The Brewery's files: a one-step recipe whose brewer commits without a red proof, so it says
// testFirst: false (ADR 0064), then opens its pull request (ADR 0084). This driver has no code
// host, so the batch goes Stuck at that step.
const recipe = `// One brewer step that writes code.
{
  "name": "stout",
  "description": "Brews an order in one step.",
  "steps": [{ "id": "brew", "brewer": "cellarman" }, { "action": "openPullRequest" }],
  // It commits with no red proof before it, which only a recipe without test-first may (ADR 0064).
  "testFirst": false
}
`;
const brewer = `---
{
  "name": "cellarman",
  "description": "Brews the order.",
  "version": 1,
  "inputs": [{ "name": "order", "from": "order" }],
  "output": { "doc": "brew.md", "schema": "outDoc" },
  "produces": "commits",
  "model": "quick",
  "effort": "low",
  "tools": { "allow": ["Read", "Write"] },
  "access": "write",
  "tree": "task",
  "git": { "commit": true },
  "deadline": "10m",
  "maxTurns": 10,
  "maxAttempts": 1
}
---
Brew the order in {order}.
`;

describe('one real step through the driver', { skip: real.kind === 'skip' && real.reason }, () => {
  let dir: TempDir;
  let api: FakeMessagesApi | undefined;
  let store: EventStore;
  let driver: Driver | undefined;
  let workRoot: string;
  let clone: string;
  beforeEach(() => {
    dir = makeTempDir('attempt-plans');
    const seed = join(dir.path, 'seed');
    git(dir.path, ['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, 'readme.txt'), 'hello\n');
    git(seed, ['add', 'readme.txt']);
    git(seed, ['commit', '-q', '-m', 'Initial commit']);
    git(dir.path, ['clone', '-q', '--bare', seed, join(dir.path, 'origin')]);
    clone = join(dir.path, 'clone');
    git(dir.path, ['clone', '-q', join(dir.path, 'origin'), clone]);
    // The brewer's commits take the identity of the clone, which its worktrees share.
    git(clone, ['config', 'user.name', 'Brewer']);
    git(clone, ['config', 'user.email', 'brewer@example.com']);
    workRoot = join(dir.path, 'work');
    mkdirSync(workRoot);
    mkdirSync(join(dir.path, 'user'));
    store = openSqliteEventStore(':memory:');
  });
  afterEach(async () => {
    driver?.close();
    driver = undefined;
    await api?.close();
    store.close();
    removeTree(dir.path);
  });

  const batchId = 'api-12';
  // The attempt's worktree, where the fake model works.
  const worktreeOf = () =>
    join(realpathSync(workRoot), repoFolder('acme/api'), 'attempts', batchId, 'brew', '1');

  /**
   * Brews the order's one-step recipe while the fake model calls `tools`, until it leaves brewing;
   * when it asks and `answers` are given, answers it once and brews on.
   */
  const brewWith = async (
    tools: (worktree: string) => readonly ToolCall[] | ((body: string) => readonly ToolCall[]),
    { text = brewer, answers }: { text?: string; answers?: readonly Answer[] } = {},
  ) => {
    const worktree = worktreeOf();
    api = await startFakeMessagesApi(tools(worktree));
    const loaded = loadRecipes({
      recipes: [{ path: 'recipes/stout.jsonc', text: recipe }],
      brewers: [{ path: 'brewers/cellarman.md', text }],
    });
    assert.ok(loaded.valid, loaded.valid ? '' : loaded.problems.join('\n'));
    // A minimal base: only what a process needs to start on each platform, so no token of the
    // developer's (GH_TOKEN, their Claude Code's settings) reaches claude, and nothing leaves the
    // machine.
    const needed =
      /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i;
    const inherited = Object.fromEntries(
      Object.entries(process.env).flatMap(([name, value]) =>
        value === undefined || !needed.test(name) ? [] : [[name, value]],
      ),
    );
    const plans = createAttemptPlans({
      state: () => {
        assert.ok(driver !== undefined);
        return driver.state();
      },
      brewers: loaded.brewers,
      models: { models: { quick: 'claude-haiku-5-5' }, brewers: {} },
      repoTools: () => [],
      clone: () => clone,
      sandbox: false,
      workRoot,
      env: {
        base: {
          ...inherited,
          CLAUDE_CONFIG_DIR: join(dir.path, 'user'),
          ANTHROPIC_BASE_URL: api.url,
          ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
        },
        forced: {},
      },
      orderText: async () => 'Add a --json flag.',
    });
    const log = createCommandLog({ store, recipes: loaded.recipes });
    const now = new Date();
    assert.equal(log.issue({ kind: 'order', batchId, order: { issue: 12 } }, now).kind, 'accepted');
    const route = {
      kind: 'route',
      batchId,
      recipe: 'stout',
      reason: 'label',
      source: 'label',
    } as const;
    assert.equal(log.issue(route, now).kind, 'accepted');

    driver = await openDriver({
      store,
      runner: claudeBrewerRunner({
        claude: real.kind === 'run' ? real.claude : 'claude',
        plan: plans.plan,
      }),
      recipes: loaded.recipes,
      clock: () => new Date(),
      lock: () => lockDriver(workRoot, { brewery: 'acme/brewery', owner: 'cellar' }),
      takes: () => true,
      stateBranch: { flush: async () => ({ kind: 'unchanged' }) },
      limits: plans.limits,
      // As serve and brew wire it: a brewer with retryMode resume continues its session (ADR 0118).
      resumes: ({ stepId }) => loaded.brewers.find('stout', stepId)?.brewer.retryMode === 'resume',
      worktrees: [
        {
          repo: 'acme/api',
          base: 'origin/main',
          manager: openAttemptWorktrees({
            git: runGit,
            workRoot,
            repo: 'acme/api',
            clone,
            own: { url: join(dir.path, 'origin'), root: join(workRoot, 'git-dirs') },
          }),
        },
      ],
    });
    const lane = () => driver?.state().batches.get(batchId)?.lane;
    const brewing = () =>
      waitUntil(`${batchId} to stop brewing`, async () => {
        if (lane()?.kind !== 'brewing') return true;
        await driver?.tick();
        return false;
      });
    await brewing();
    const asked = lane();
    if (answers !== undefined && asked?.kind === 'stuck' && asked.reason.kind === 'needs_input') {
      const answer = { kind: 'answer', batchId, by: 'octocat', via: 'terminal', answers } as const;
      assert.equal(log.issue({ ...answer, answers: [...answers] }, new Date()).kind, 'accepted');
      await brewing();
    }
    const events = store
      .eventsAfter(0)
      .map(({ event }) => event)
      .filter((event) => 'batchId' in event && event.batchId === batchId);
    return { worktree, events, lane: lane(), bodies: api.bodies };
  };

  // As the docs' example brewer does (ADR 0074): the change, its commit, then the out doc.
  const committing = (worktree: string): ToolCall[] => [
    { name: 'Write', input: { file_path: join(worktree, 'flag.txt'), content: '--json\n' } },
    { name: 'Bash', input: { command: 'git add flag.txt', description: 'Stage the flag' } },
    {
      name: 'Bash',
      input: { command: 'git commit -q -m "Add a --json flag"', description: 'Commit it' },
    },
    {
      name: 'Write',
      input: {
        file_path: join(worktree, 'brew.md'),
        content: outDoc({ status: 'done', summary: 'Brewed' }),
      },
    },
  ];

  it('brews the step from scheduled through started and finished to on tap, its change committed', async () => {
    const { worktree, events, bodies } = await brewWith(committing);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'batch.ordered',
        'batch.recipe_chosen',
        'step.scheduled',
        'step.started',
        'step.finished',
        // The openPullRequest action, blocked: the driver has no code host (ADR 0084).
        'step.scheduled',
        'step.started',
        'step.finished',
        'batch.stuck',
      ],
    );
    const [, , , started, finished] = events;
    assert.equal(started?.type === 'step.started' && started.worktree?.path, worktree);
    // The session the driver chose, which claude ran under, and what claude's init reported
    // (ADR 0116).
    const session = started?.type === 'step.started' ? started.session : undefined;
    assert.match(
      session?.id ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(session?.worktree, worktree);
    const claude = finished?.type === 'step.finished' ? finished.claude : undefined;
    assert.equal(claude?.model, 'claude-haiku-5-5');
    assert.match(claude?.version ?? '', /^\d+\.\d+\.\d+/);
    assert.deepEqual(finished?.type === 'step.finished' && finished.outcome, {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Brewed', assumptions: [] },
    });
    // The change is a commit on the attempt's branch, after the start; the out doc is not in it.
    const branch = started?.type === 'step.started' ? started.worktree?.branch : undefined;
    const start = started?.type === 'step.started' ? started.worktree?.commit : undefined;
    assert.ok(branch !== undefined && start !== undefined);
    assert.equal(git(clone, ['log', '--format=%s', `${start}..${branch}`]), 'Add a --json flag\n');
    assert.equal(git(clone, ['show', '--name-only', '--format=', branch]), 'flag.txt\n');
    // The prompt reached the model: the order's text in nonce tags, with the out doc contract that
    // tells it to commit.
    const [first = ''] = bodies;
    assert.match(
      first,
      /untrusted-input-[0-9a-f]{32} source=\\"issue #12 body\\" name=\\"order\\">\\nAdd a --json flag\./,
    );
    assert.match(first, /When you finish, write brew\.md\./);
    assert.match(
      first,
      /Commit your changes with git add and git commit before you write brew\.md/,
    );
  });

  it('gives a brewer that resumes the answer to its question in the same session, in the same worktree (#327, ADR 0118)', async () => {
    const resuming = brewer.replace(
      '"maxAttempts": 1',
      '"maxAttempts": 1,\n  "retryMode": "resume"',
    );
    const question = {
      q: 'Which flag?',
      options: ['--json', '--format=json'],
      recommended: '--json',
      whyBlocking: 'Scripts will depend on it',
    };
    const asking = (worktree: string): ToolCall => ({
      name: 'Write',
      input: {
        file_path: join(worktree, 'brew.md'),
        content: outDoc({ status: 'needs_input', summary: 'Asked', questions: [question] }),
      },
    });
    // Before the answer it asks; after it, the resumed session reads its out doc, which the Write
    // tool needs before it writes the file again, then commits and is done.
    const script = (worktree: string) => (body: string) =>
      body.includes('A: --format=json')
        ? [
            asking(worktree),
            { name: 'Read', input: { file_path: join(worktree, 'brew.md') } },
            ...committing(worktree),
          ]
        : [asking(worktree)];
    const answers = [{ q: question.q, answer: '--format=json' }];
    const { worktree, events, bodies } = await brewWith(script, { text: resuming, answers });
    const starts = events.flatMap((event) =>
      event.type === 'step.started' && event.stepId === 'brew' ? [event] : [],
    );
    const [first, second] = starts;
    assert.equal(starts.length, 2);
    // The second attempt continues the first's session where it made its worktree (ADR 0117).
    assert.ok(first?.session !== undefined);
    assert.deepEqual(second?.session, {
      id: first.session.id,
      resumes: first.session.id,
      worktree,
    });
    assert.equal(second?.worktree, undefined);
    const finished = events.filter((event) => event.type === 'step.finished');
    assert.deepEqual(
      finished.slice(0, 2).map((event) => event.type === 'step.finished' && event.outcome.kind),
      ['needs_input', 'succeeded'],
    );
    // claude sent the model the first run's conversation and then the answer, in nonce tags.
    const resumed = bodies.find((body) => body.includes('A: --format=json')) ?? '';
    assert.match(resumed, /A human answered the questions the run before this one asked\./);
    assert.match(resumed, /Brew the order in \{order\}\./);
    assert.match(
      resumed,
      /source=\\"answers to the questions of step brew\\" name=\\"answers\\">\\nQ: Which flag\?\\nA: --format=json/,
    );
    // Its commit is on the branch of the worktree it ran in.
    const { branch, commit } = first.worktree ?? assert.fail('brew#1 has no worktree');
    assert.equal(git(clone, ['log', '--format=%s', `${commit}..${branch}`]), 'Add a --json flag\n');
  });

  it('goes Stuck on a divergence when the brewer says done but committed nothing (#196)', async () => {
    const { events, lane } = await brewWith((worktree) => [
      { name: 'Write', input: { file_path: join(worktree, 'flag.txt'), content: '--json\n' } },
      ...committing(worktree).slice(-1),
    ]);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'batch.ordered',
        'batch.recipe_chosen',
        'step.scheduled',
        'step.started',
        'step.finished',
        'batch.stuck',
      ],
    );
    assert.equal(lane?.kind === 'stuck' && lane.reason.kind, 'blocked');
    assert.match(
      lane?.kind === 'stuck' && lane.reason.kind === 'blocked' ? lane.reason.summary : '',
      /^the out doc says done, but the brewer made no commit since [0-9a-f]{7}: Brewed$/,
    );
  });
});
