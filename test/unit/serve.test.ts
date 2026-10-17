// `foedrum serve`'s shell (ADR 0063): it takes the Cellar's lock, opens the store and the state
// branch, each repository's attempt worktrees and the driver, ticks it until Ctrl+C, and closes it
// all again. An in-memory store, fake worktrees, a fake GitHub and a runner that asks for the plan
// and ends each attempt itself; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import { formatNotice, runServe, type ServeShell } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import type { AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { DriverRunningError } from '../../src/engine/driver-lock.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import { fakeFetch } from '../helpers/fake-fetch.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { local, serveInputs } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const issue = JSON.parse(
  readFileSync(new URL('../fixtures/github/issue.json', import.meta.url), 'utf8'),
) as object;
const t0 = new Date('2026-10-17T12:00:00.000Z');

describe('runServe', () => {
  let dir: TempDir;
  let setup: ServeSetup;
  let store: EventStore;
  let closed: number;
  let calls: string[];
  let lines: string[];
  let controller: AbortController;
  let lock: ReturnType<typeof fakeLock>;
  let plans: ClaudeAttemptPlan[];

  beforeEach(() => {
    dir = makeTempDir('serve');
    const result = serveSetup(
      serveInputs({ files: { ...serveInputs().files, local: local({ workRoot: dir.path }) } }),
    );
    assert.equal(result.kind, 'ready');
    setup = result.kind === 'ready' ? result.setup : assert.fail();
    store = openSqliteEventStore(':memory:');
    const inner = store;
    closed = 0;
    store = {
      ...inner,
      close: () => {
        closed++;
      },
    };
    calls = [];
    lines = [];
    controller = new AbortController();
    lock = fakeLock('cellar');
    plans = [];
    // An order routed to the one-step recipe, as the state branch would have it.
    const log = createCommandLog({ store, recipes: setup.recipes });
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log.issue(
      { kind: 'route', batchId: '12-1', recipe: 'stout', reason: 'label', source: 'label' },
      t0,
    );
  });
  afterEach(() => dir.remove());

  /** A runner whose attempts ask for their plan, then succeed, or fail when it cannot be made. */
  const planningRunner = (plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>) => {
    const runner: BrewerRunner = {
      start: (start) => ({
        ended: plan(start).then(
          (made) => {
            plans.push(made);
            const output = { status: 'done', summary: 'Brewed', assumptions: [] };
            return { ending: { kind: 'succeeded', output } } as const;
          },
          (error: Error) => ({
            ending: { kind: 'failed', retryable: false, reason: error.message } as const,
          }),
        ),
        stop: () => {},
      }),
      progress: () => undefined,
    };
    return runner;
  };

  const shell = (overrides: Partial<ServeShell> = {}): ServeShell => ({
    out: (line) => lines.push(line),
    signal: controller.signal,
    clock: () => t0,
    // Stops serve once the batch is on tap, or after 20 ticks.
    wait: async (ms) => {
      calls.push(`wait ${ms}`);
      const lane = createCommandLog({ store, recipes: setup.recipes }).state().batches.get('12-1')
        ?.lane.kind;
      if (lane === 'on_tap' || calls.length > 40) controller.abort();
    },
    lock: (workRoot, options) => {
      calls.push(`lock ${options.owner} ${options.brewery} ${workRoot === dir.path}`);
      return lock;
    },
    openStore: (path) => {
      calls.push(`store ${path === setup.store}`);
      return store;
    },
    stateBranch: () => ({
      start: async () => {
        calls.push('state branch');
        return { decision: 'ready' };
      },
      flush: async () => ({ kind: 'unchanged' }),
    }),
    worktrees: async (repository) => {
      calls.push(`worktrees ${repository.repo} ${repository.base}`);
      return fakeWorktrees({ root: join(dir.path, 'acme.web', 'attempts') });
    },
    runner: (claude, plan) => {
      calls.push(`runner ${claude}`);
      return planningRunner(plan);
    },
    fetch: fakeFetch([{ status: 200, body: { ...issue, number: 12, body: 'Add a --json flag.' } }])
      .fetch,
    ...overrides,
  });

  const types = () =>
    store
      .eventsAfter(0)
      .map(({ event }) => event.type)
      .filter((type) => type !== 'effect.applied');

  it('sets the Cellar up in order, brews the order with its text, and stops on Ctrl+C', async () => {
    assert.equal(await runServe(setup, shell()), 0);
    assert.deepStrictEqual(calls.slice(0, 5), [
      'lock cellar Acme/Brewery true',
      'store true',
      'state branch',
      'worktrees acme/web origin/main',
      'runner /home/brewer/.local/bin/claude',
    ]);
    assert.ok(calls.slice(5).every((call) => call === 'wait 5000'));
    assert.deepStrictEqual(types(), [
      'batch.ordered',
      'batch.recipe_chosen',
      'step.scheduled',
      'step.started',
      'step.finished',
      'batch.on_tap',
    ]);
    const [plan] = plans;
    assert.match(plan?.prompt ?? '', /Add a --json flag\./);
    assert.equal(plan?.call.model, 'claude-haiku-5-5');
    assert.equal(plan?.cwd, join(dir.path, 'acme.web', 'attempts', '12-1', 'brew', '1'));
    assert.equal(plan?.env.npm_config_ignore_scripts, 'true');
    assert.equal(plan?.env.GH_TOKEN, undefined);
    assert.equal(plan?.settingsFile, join(dir.path, 'attempt-settings', '12-1', 'brew', '1.json'));
    assert.deepStrictEqual(
      [lines[0], lines.at(-1)],
      [
        `foedrum serve: brewing for Acme/Brewery in ${dir.path}; Ctrl+C stops it`,
        'foedrum serve: stopped',
      ],
    );
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
  });

  it('refuses a second Cellar, opening nothing', async () => {
    const running = new DriverRunningError('cellar', 'drivers/cellar.lock', undefined);
    const code = await runServe(
      setup,
      shell({
        lock: () => {
          throw running;
        },
      }),
    );
    assert.equal(code, 1);
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(lines, [`foedrum serve: ${running.message}`]);
  });

  it('lets the lock go and closes the store when the state branch refuses to start', async () => {
    const code = await runServe(
      setup,
      shell({
        stateBranch: () => ({
          start: async () => {
            throw new StateBranchStopError('the branch moved and the store has unpushed events');
          },
          flush: async () => ({ kind: 'unchanged' }),
        }),
      }),
    );
    assert.equal(code, 1);
    assert.deepStrictEqual(lines, [
      'foedrum serve: the branch moved and the store has unpushed events',
    ]);
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
  });

  it("stops when a repository's worktrees cannot be opened", async () => {
    const code = await runServe(
      setup,
      shell({
        worktrees: async () => {
          throw new Error('git clone of https://github.com/acme/web.git failed: not found');
        },
      }),
    );
    assert.equal(code, 1);
    assert.deepStrictEqual(lines, [
      'foedrum serve: git clone of https://github.com/acme/web.git failed: not found',
    ]);
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
  });

  it('stops when a tick must stop the engine: another engine pushed the state branch', async () => {
    const code = await runServe(
      setup,
      shell({
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () => {
            throw new StateBranchStopError('the push was rejected: another engine wrote');
          },
        }),
      }),
    );
    assert.equal(code, 1);
    assert.equal(lines.at(-1), 'foedrum serve: the push was rejected: another engine wrote');
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
  });

  it("gives each brewer its repository's toolchain rules", async () => {
    assert.equal(await runServe(setup, shell()), 0);
    assert.ok(plans[0]?.permissions.allow.includes('Bash(npm test*)'));
  });

  it('keeps ticking after a tick failed for another reason than the state branch', async () => {
    const broken: BrewerRunner = {
      start: () => ({ ended: Promise.reject(new Error('the runner broke')), stop: () => {} }),
      progress: () => undefined,
    };
    assert.equal(await runServe(setup, shell({ runner: () => broken })), 0);
    assert.ok(lines.includes('foedrum serve: a tick failed: the runner broke'), lines.join('\n'));
    assert.equal(lines.at(-1), 'foedrum serve: stopped');
  });

  it("prints the driver's notices, one line each, and goes on", async () => {
    let flushes = 0;
    await runServe(
      setup,
      shell({
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () =>
            flushes++ === 0 ? { kind: 'failed', reason: 'no network' } : { kind: 'unchanged' },
        }),
      }),
    );
    assert.ok(
      lines.includes('foedrum serve: the state branch was not pushed: no network'),
      lines.join('\n'),
    );
    assert.equal(lines.at(-1), 'foedrum serve: stopped');
  });

  it('prints a notice with control characters escaped, since a model may have written it', async () => {
    let flushes = 0;
    await runServe(
      setup,
      shell({
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () =>
            flushes++ === 0
              ? { kind: 'failed', reason: 'hook said \u001b[2Jhi' }
              : { kind: 'unchanged' },
        }),
      }),
    );
    assert.ok(
      lines.includes('foedrum serve: the state branch was not pushed: hook said \\u001b[2Jhi'),
      lines.join('\n'),
    );
  });

  it('does not tick once it was stopped before it started', async () => {
    controller.abort();
    assert.equal(await runServe(setup, shell()), 0);
    assert.deepStrictEqual(types().slice(-1), ['step.scheduled']);
    assert.deepStrictEqual([lock.held, closed], [false, 1]);
  });
});

describe('formatNotice', () => {
  const key = { batchId: '12-1', stepId: 'brew', attempt: 1, effect: 'comment' };
  const command = { kind: 'expire', batchId: '12-1', stepId: 'brew', attempt: 1 } as const;
  it('says what happened in one line for each notice', () => {
    assert.deepStrictEqual(
      [
        formatNotice({ kind: 'refused', command, reason: 'the batch is on tap' }),
        formatNotice({ kind: 'command_failed', command, error: new Error('disk full') }),
        formatNotice({ kind: 'flush_failed', reason: 'no network' }),
        formatNotice({ kind: 'flush_overdue', since: t0 }),
        formatNotice({ kind: 'tick_failed', error: 'boom' }),
        formatNotice({
          kind: 'batch_lost',
          batchId: '12-1',
          holder: { batchId: '12-1', owner: 'session-1', expiresAt: t0 },
        }),
        formatNotice({ kind: 'effect_failed', key, error: new Error('GitHub answered 502') }),
        formatNotice({
          kind: 'cleaned',
          batchId: '12-1',
          report: {
            done: ['removed worktree 12-1/brew/1'],
            kept: [],
            failed: ['could not clean x: busy'],
          },
        }),
        formatNotice({
          kind: 'cleaned',
          batchId: '12-1',
          report: { done: [], kept: [], failed: [] },
        }),
      ],
      [
        'expire of batch 12-1 was refused: the batch is on tap',
        'expire of batch 12-1 failed: disk full',
        'the state branch was not pushed: no network',
        'the state branch has not been pushed since 2026-10-17T12:00:00.000Z',
        'a tick failed: boom',
        'batch 12-1 is driven by session-1 now',
        `the effect ${JSON.stringify(['12-1', 'brew', 1, 'comment'])} failed: GitHub answered 502`,
        'cleaned batch 12-1: removed worktree 12-1/brew/1; could not clean x: busy',
        'cleaned batch 12-1: nothing to remove',
      ],
    );
  });
});
