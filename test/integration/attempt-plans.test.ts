// One real step, end to end (#148): a driver brews an order's one-step recipe from the Brewery's
// files, with the real claude runner, the attempt plans and real attempt worktrees. A fake
// Messages API stands in for the model (no login, no tokens): its "model" writes the out doc, then
// answers. Opt-in: it runs only with FOEDRUM_REAL_CLAUDE=1 (ADR 0057). It tests Foedrum's wiring,
// not whether claude works.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAttemptPlans } from '../../src/brewers/attempt-plans.ts';
import { claudeBrewerRunner } from '../../src/brewers/claude-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { type Driver, openDriver } from '../../src/engine/driver.ts';
import { lockDriver } from '../../src/engine/driver-lock.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { repoFolder } from '../../src/workspace/attempt-worktrees.ts';
import { openAttemptWorktrees } from '../../src/workspace/attempt-worktrees-git.ts';
import { runGit } from '../../src/workspace/git.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';
import { realClaude } from '../helpers/real-claude.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { type FakeMessagesApi, startFakeMessagesApi } from './fake-messages-api.ts';

const real = realClaude();

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// The Brewery's files: a one-step recipe whose brewer commits without a red proof, so it says
// testFirst: false (ADR 0064).
const recipe = `// One brewer step that writes code.
{
  "name": "stout",
  "description": "Brews an order in one step.",
  "steps": [{ "id": "brew", "brewer": "cellarman" }],
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
  "maxTurns": 5,
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

  it('brews the step from scheduled through started and finished to on tap', async () => {
    const batchId = 'api-12';
    // The attempt's worktree, where the fake model writes the out doc.
    const worktree = join(
      realpathSync(workRoot),
      repoFolder('acme/api'),
      'attempts',
      batchId,
      'brew',
      '1',
    );
    api = await startFakeMessagesApi({
      name: 'Write',
      input: {
        file_path: join(worktree, 'brew.md'),
        content: outDoc({ status: 'done', summary: 'Brewed' }),
      },
    });
    const loaded = loadRecipes({
      recipes: [{ path: 'recipes/stout.jsonc', text: recipe }],
      brewers: [{ path: 'brewers/cellarman.md', text: brewer }],
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
      worktrees: {
        repo: 'acme/api',
        base: 'origin/main',
        manager: openAttemptWorktrees({ git: runGit, workRoot, repo: 'acme/api', clone }),
      },
    });
    const lane = () => driver?.state().batches.get(batchId)?.lane.kind;
    const deadline = Date.now() + 120_000;
    while (lane() === 'brewing' && Date.now() < deadline) {
      await driver.tick();
      await sleep(100);
    }

    const events = store
      .eventsAfter(0)
      .map(({ event }) => event)
      .filter((event) => 'batchId' in event && event.batchId === batchId);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'batch.ordered',
        'batch.recipe_chosen',
        'step.scheduled',
        'step.started',
        'step.finished',
        'batch.on_tap',
      ],
    );
    const [, , , started, finished] = events;
    assert.equal(started?.type === 'step.started' && started.worktree?.path, worktree);
    assert.deepEqual(finished?.type === 'step.finished' && finished.outcome, {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Brewed', assumptions: [] },
    });
    // The prompt reached the model: the order's text in nonce tags, with the out doc contract.
    const [first = ''] = api.bodies;
    assert.match(
      first,
      /untrusted-input-[0-9a-f]{32} source=\\"issue #12 body\\" name=\\"order\\">\\nAdd a --json flag\./,
    );
    assert.match(first, /When you finish, write brew\.md\./);
  });
});
