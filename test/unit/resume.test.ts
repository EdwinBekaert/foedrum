// `foedrum resume` (ADR 0126) with an in-memory event store, fake worktrees and a fake claude that
// records its arguments and the folder it ran in: which attempt it opens, the worktree recreated at
// its recorded commit, the settings written again, and the leases that claim the worktree.

import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptPermissions, settingsFileOf } from '../../src/brewers/attempt-plan.ts';
import { attemptSettings } from '../../src/brewers/attempt-settings.ts';
import { type ResumeSetup, type ResumeShell, runResume } from '../../src/cli/resume.ts';
import type { ServeRepository } from '../../src/cli/serve-config.ts';
import { attemptKey } from '../../src/engine/attempt-key.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { fold } from '../../src/engine/fold.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { worktreeClaims } from '../../src/engine/worktree-claims.ts';
import type { AttemptSettings } from '../../src/schemas/attempt-settings.ts';
import type { AttemptRef } from '../../src/workspace/attempt-worktrees.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const cwd = join(sep, 'brewery');
const workRoot = join(sep, 'work-root');
const t0 = new Date('2026-10-22T12:00:00.000Z');
const S1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const S2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const S3 = '9b2c1f4e-3a5d-4e6f-8a7b-1c2d3e4f5a6b';
const commit = (char: string) => char.repeat(40);
const pathOf = (ref: AttemptRef) => join(workRoot, 'attempts', ref.batchId, ref.stepId, '1');

const loaded = loadRecipes({
  recipes: [
    {
      path: 'recipes/pint.jsonc',
      text: recipeText('pint', [
        { id: 'plan', brewer: 'planner' },
        { id: 'implement', brewer: 'coder' },
      ]),
    },
  ],
  brewers: [
    { path: 'brewers/planner.md', text: brewerText('planner') },
    {
      path: 'brewers/coder.md',
      text: brewerText('coder', {
        effort: 'high',
        access: 'write',
        tools: { allow: ['Read', 'Edit'], deny: ['WebFetch'] },
      }),
    },
  ],
});
assert.ok(loaded.valid);
const coder = loaded.brewers.find('pint', 'implement');
assert.ok(coder !== undefined);

const repository = {
  repo: 'acme/api',
  source: 'local',
  base: 'origin/main',
  clone: join(sep, 'clones', 'api'),
  tools: ['Bash(npm test *)'],
} as unknown as ServeRepository;
const setup: ResumeSetup = {
  workRoot,
  repositories: [repository],
  models: { models: { builder: 'claude-sonnet-5-5' }, brewers: {} },
  brewers: loaded.brewers,
  claude: join(sep, 'bin', 'claude'),
  sandbox: true,
};

describe('foedrum resume (ADR 0126)', () => {
  let store: EventStore;
  let now: Date;
  let calls: string[];
  let started: { program: string; args: readonly string[]; cwd: string }[];
  let settings: { file: string; settings: AttemptSettings }[];
  let beats: (() => void)[];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    now = t0;
    calls = [];
    started = [];
    settings = [];
    beats = [];
    const log = createCommandLog({
      store,
      recipes: fakeRecipes({ pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 1 }) }),
    });
    const issue = (command: Parameters<typeof log.issue>[0]) =>
      assert.equal(log.issue(command, t0).kind, 'accepted', JSON.stringify(command));
    const start = (batchId: string, stepId: string, id: string, at: string) => {
      const path = pathOf({ batchId, stepId, attempt: 1 });
      issue({
        kind: 'record',
        event: {
          type: 'step.started',
          batchId,
          stepId,
          attempt: 1,
          session: { id, worktree: path },
          worktree: {
            repo: 'acme/api',
            path,
            branch: `foedrum/${batchId}/${stepId}/1`,
            commit: at,
          },
        },
      });
    };
    // 21-1 planned in session S1, then got Stuck implementing in S2; 23-1 brews its plan in S3.
    for (const batchId of ['21-1', '23-1']) {
      issue({ kind: 'order', batchId, order: { issue: Number(batchId.slice(0, 2)) } });
      issue({ kind: 'route', batchId, recipe: 'pint', reason: 'label', source: 'label' });
    }
    start('21-1', 'plan', S1, commit('1'));
    issue({
      kind: 'finish',
      batchId: '21-1',
      stepId: 'plan',
      attempt: 1,
      ending: { kind: 'succeeded', output: {} },
    });
    start('21-1', 'implement', S2, commit('2'));
    issue({
      kind: 'finish',
      batchId: '21-1',
      stepId: 'implement',
      attempt: 1,
      ending: { kind: 'failed', retryable: true, reason: 'tests fail' },
    });
    start('23-1', 'plan', S3, commit('3'));
  });
  afterEach(() => store.close());

  const shell = (overrides: Partial<ResumeShell> = {}): ResumeShell => ({
    cwd,
    openStore: (path) => {
      assert.equal(path, join(cwd, '.foedrum', 'index.db'));
      return { ...store, close: () => {} };
    },
    setup: async () => ({ kind: 'ready', setup }),
    worktrees: async (of) => {
      assert.equal(of, repository);
      return {
        recreate: async (ref, at) => {
          calls.push(`recreate ${attemptKey.encode(ref)} ${at}`);
          return {
            path: pathOf(ref),
            branch: `foedrum/${ref.batchId}/${ref.stepId}/1`,
            commit: at,
          };
        },
      };
    },
    sessionFound: () => true,
    writeSettings: (file, written) => {
      settings.push({ file, settings: written });
    },
    nested: false,
    claude: async (program, args, folder) => {
      started.push({ program, args, cwd: folder });
      return 0;
    },
    now: () => now,
    heartbeat: (_everyMs, beat) => {
      beats.push(beat);
      return () => {
        calls.push('heartbeat stopped');
      };
    },
    pid: 4242,
    ...overrides,
  });
  const resume = (step?: string, overrides: Partial<ResumeShell> = {}) =>
    runResume(
      { command: 'resume', batch: '21-1', ...(step === undefined ? {} : { step }) },
      shell(overrides),
    );
  const refused = (line: string) => ({
    exitCode: 1,
    stdout: '',
    stderr: `foedrum resume: ${line}\n`,
  });
  const implement = { batchId: '21-1', stepId: 'implement', attempt: 1 };

  it('opens the latest finished attempt in its worktree, with its settings written again', async () => {
    const result = await resume();
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.deepEqual(calls, [
      `recreate ${attemptKey.encode(implement)} ${commit('2')}`,
      'heartbeat stopped',
    ]);
    const file = settingsFileOf(workRoot, implement);
    const permissions = attemptPermissions(coder.brewer, repository.tools, true);
    assert.deepEqual(settings, [{ file, settings: attemptSettings(permissions) }]);
    assert.deepEqual(started, [
      {
        program: setup.claude,
        args: [
          '--resume',
          S2,
          '--model',
          'claude-sonnet-5-5',
          '--effort',
          'high',
          '--settings',
          file,
          '--setting-sources',
          '',
          '--tools',
          'Read,Edit,Bash',
          '--disable-slash-commands',
          '--strict-mcp-config',
          '--safe-mode',
        ],
        cwd: pathOf(implement),
      },
    ]);
  });

  it("opens the latest attempt of a named step, or the attempt named, and refuses one it doesn't have", async () => {
    await resume('plan');
    await resume('implement#1');
    assert.deepEqual(
      started.map(({ args, cwd: folder }) => [args[1], folder]),
      [
        [S1, pathOf({ batchId: '21-1', stepId: 'plan', attempt: 1 })],
        [S2, pathOf(implement)],
      ],
    );
    assert.deepEqual(await resume('plan#2'), refused('batch 21-1 has no attempt plan#2'));
    assert.deepEqual(await resume('brew'), refused('batch 21-1 has no attempt of step brew'));
  });

  it('returns the exit code of claude', async () => {
    assert.equal((await resume(undefined, { claude: async () => 130 })).exitCode, 130);
  });

  it('says plainly when the session is not on this machine, and opens nothing', async () => {
    const result = await resume(undefined, { sessionFound: () => false });
    assert.deepEqual(
      result,
      refused(
        `the session ${S2} of 21-1 implement#1 is not on this machine: Claude Code keeps a session where it ran, for 30 days by default`,
      ),
    );
    assert.deepEqual([calls, started, settings, store.currentLeases(now)], [[], [], [], []]);
  });

  it('refuses a running batch, which is #338', async () => {
    const result = await runResume({ command: 'resume', batch: '23-1' }, shell());
    assert.deepEqual(
      result,
      refused('batch 23-1 is brewing; resuming a running batch is not supported yet (#338)'),
    );
    assert.deepEqual([calls, started], [[], []]);
  });

  it('refuses a batch another driver holds', async () => {
    const expiresAt = new Date(t0.getTime() + 60_000);
    store.withTransaction((tx) =>
      tx.putBatchLease({ batchId: '21-1', owner: 'cellar', expiresAt }),
    );
    assert.deepEqual(
      await resume(),
      refused(`batch 21-1 is held by cellar until ${expiresAt.toISOString()}`),
    );
    assert.deepEqual([calls, started], [[], []]);
  });

  it('claims the worktree while claude runs, renews the claim, and lets it go after', async () => {
    const state = () => fold(store.eventsAfter(0).map(({ event }) => event));
    const during: unknown[] = [];
    const claude = async () => {
      during.push(store.batchLeases(now).map(({ batchId, owner }) => [batchId, owner]));
      during.push(worktreeClaims(state(), store.currentLeases(now)).leased);
      now = new Date(t0.getTime() + 4 * 60_000);
      for (const beat of beats) beat();
      // Past the first lease, so alive only because the beat renewed it.
      now = new Date(t0.getTime() + 8 * 60_000);
      during.push(worktreeClaims(state(), store.currentLeases(now)).leased);
      during.push(store.batchLeases(now).length);
      return 0;
    };
    await resume(undefined, { claude });
    assert.deepEqual(during, [[['21-1', 'resume-4242']], [implement], [implement], 1]);
    assert.deepEqual([store.currentLeases(now), store.batchLeases(now)], [[], []]);
  });

  it('lets the claim go when claude cannot start', async () => {
    const claude = () => Promise.reject(new Error('spawn ENOENT'));
    await assert.rejects(resume(undefined, { claude }), /spawn ENOENT/);
    assert.deepEqual([store.currentLeases(now), store.batchLeases(now)], [[], []]);
  });

  it('inside a Claude Code session, prints the line to run in a terminal and opens nothing', async () => {
    const result = await resume(undefined, { nested: true });
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: `foedrum resume opens claude in a terminal, which a Claude Code session cannot hand over; run this in a terminal in ${cwd}:\n  foedrum resume 21-1 implement#1\n`,
      stderr: '',
    });
    assert.deepEqual([calls, started, settings, store.currentLeases(now)], [[], [], [], []]);
  });
});
