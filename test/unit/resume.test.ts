// `foedrum resume` (ADR 0126) with an in-memory event store, fake worktrees and a fake claude that
// records its arguments, the folder it ran in and its environment: which attempt it opens, the
// worktree recreated at its recorded commit, the settings written again, and the lease that claims
// the worktree.

import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { settingsFileOf } from '../../src/brewers/attempt-plan.ts';
import { attemptSettings } from '../../src/brewers/attempt-settings.ts';
import {
  claudeConfigDir,
  type ResumeSetup,
  type ResumeShell,
  runResume,
  sessionFoundIn,
} from '../../src/cli/resume.ts';
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
const S4 = '3e1f2a4b-5c6d-4e7f-8091-a2b3c4d5e6f7';
const S5 = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d';
const commit = (char: string) => char.repeat(40);
const pathOf = (ref: AttemptRef) => join(workRoot, 'attempts', ref.batchId, ref.stepId, '1');

const recipes = fakeRecipes({
  pint: fakeRecipe({ steps: ['plan', 'implement'], maxAttempts: 1 }),
  // talk is a person's session (ADR 0222).
  sip: fakeRecipe({ steps: ['plan', 'talk'], interactive: ['talk'] }),
  flight: fakeRecipe({ steps: ['look'], groups: { look: ['eye', 'talk'] }, interactive: ['talk'] }),
});

const loaded = loadRecipes({
  recipes: [
    {
      path: 'recipes/pint.jsonc',
      text: recipeText('pint', [
        { id: 'plan', brewer: 'planner' },
        { id: 'implement', brewer: 'coder' },
      ]),
    },
    {
      path: 'recipes/sip.jsonc',
      text: recipeText('sip', [
        { id: 'plan', brewer: 'planner' },
        { id: 'talk', brewer: 'planner', interactive: true, prompt: 'Talk it through.' },
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
        env: { FOEDRUM_MODE: 'coder' },
      }),
    },
  ],
});
assert.ok(loaded.valid);

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
  brewerEnv: { base: { PATH: '/bin' }, forced: { GIT_TERMINAL_PROMPT: '0' } },
};

describe('foedrum resume (ADR 0126)', () => {
  let store: EventStore;
  let now: Date;
  let calls: string[];
  let started: {
    program: string;
    args: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
  }[];
  let settings: { file: string; settings: AttemptSettings }[];
  let systemPrompts: { file: string; text: string }[];
  let beats: { everyMs: number; beat: () => void }[];
  let said: string[];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    now = t0;
    calls = [];
    started = [];
    settings = [];
    systemPrompts = [];
    beats = [];
    said = [];
    const log = createCommandLog({
      store,
      recipes,
    });
    const issue = (command: Parameters<typeof log.issue>[0]) =>
      assert.equal(log.issue(command, t0).kind, 'accepted', JSON.stringify(command));
    const start = (batchId: string, stepId: string, id: string | undefined, at: string) => {
      const path = pathOf({ batchId, stepId, attempt: 1 });
      issue({
        kind: 'record',
        event: {
          type: 'step.started',
          batchId,
          stepId,
          attempt: 1,
          ...(id === undefined ? {} : { session: { id, worktree: path } }),
          worktree: {
            repo: 'acme/api',
            path,
            branch: `foedrum/${batchId}/${stepId}/1`,
            commit: at,
          },
        },
      });
    };
    const finish = (batchId: string, stepId: string, succeeded: boolean) =>
      issue({
        kind: 'finish',
        batchId,
        stepId,
        attempt: 1,
        ending: succeeded
          ? { kind: 'succeeded', output: {} }
          : { kind: 'failed', retryable: true, reason: 'tests fail' },
      });
    // 21-1 planned in S1, then got Stuck implementing in S2; 23-1 brews its plan in S3. 24-1
    // planned in S4, then got Stuck on an implement attempt that ran no brewer. 26-1 was cancelled
    // while its plan ran in S5. 27-1 waits to be routed.
    for (const batchId of ['21-1', '23-1', '24-1', '26-1', '27-1', '28-1']) {
      issue({ kind: 'order', batchId, order: { issue: Number(batchId.slice(0, 2)) } });
      if (batchId === '27-1') continue;
      issue({ kind: 'route', batchId, recipe: 'pint', reason: 'label', source: 'label' });
    }
    start('21-1', 'plan', S1, commit('1'));
    finish('21-1', 'plan', true);
    start('21-1', 'implement', S2, commit('2'));
    finish('21-1', 'implement', false);
    start('23-1', 'plan', S3, commit('3'));
    start('24-1', 'plan', S4, commit('4'));
    finish('24-1', 'plan', true);
    start('24-1', 'implement', undefined, commit('5'));
    finish('24-1', 'implement', false);
    start('26-1', 'plan', S5, commit('6'));
    // 28-1's log names a session id that is no UUID (a state branch edited by hand).
    start('28-1', 'plan', '../../x', commit('7'));
    finish('28-1', 'plan', false);
    issue({ kind: 'cancel', batchId: '26-1', by: 'ada', via: 'terminal' });
  });
  afterEach(() => store.close());

  const leaseOwners = () =>
    store.currentLeases(now).map(({ attemptKey: key, owner }) => [key, owner]);
  const shell = (overrides: Partial<ResumeShell> = {}): ResumeShell => ({
    cwd,
    running: () => assert.fail('no running batch is taken over'),
    openStore: (path) => {
      assert.equal(path, join(cwd, '.foedrum', 'index.db'));
      return { ...store, close: () => {} };
    },
    setup: async () => ({ kind: 'ready', setup }),
    worktrees: async (of, root) => {
      assert.deepEqual([of, root], [repository, workRoot]);
      return {
        recreate: async (ref, at) => {
          // The lease is taken before anything changes.
          calls.push(`recreate ${attemptKey.encode(ref)} ${at} ${JSON.stringify(leaseOwners())}`);
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
    writeSystemPrompt: (file, text) => {
      systemPrompts.push({ file, text });
    },
    terminal: { claudeCode: false, tty: true },
    env: { TERM: 'xterm-256color', LANG: 'C.UTF-8', GH_TOKEN: 'a token', HOME: '/home/ada' },
    platform: 'linux',
    claude: async (program, args, folder, env) => {
      started.push({ program, args, cwd: folder, env });
      return 0;
    },
    now: () => now,
    heartbeat: (everyMs, beat) => {
      beats.push({ everyMs, beat });
      return () => {
        calls.push('heartbeat stopped');
      };
    },
    say: (line) => {
      said.push(line);
    },
    pid: 4242,
    ...overrides,
  });
  const resumeOf = (batch: string, step?: string, overrides: Partial<ResumeShell> = {}) =>
    runResume(
      { command: 'resume', batch, ...(step === undefined ? {} : { step }) },
      shell(overrides),
    );
  const resume = (step?: string, overrides: Partial<ResumeShell> = {}) =>
    resumeOf('21-1', step, overrides);
  const refused = (line: string) => ({
    exitCode: 1,
    stdout: '',
    stderr: `foedrum resume: ${line}\n`,
  });
  const implement = { batchId: '21-1', stepId: 'implement', attempt: 1 };
  const key = attemptKey.encode(implement);
  const nothingOpened = () =>
    assert.deepEqual([calls, started, settings, store.currentLeases(now)], [[], [], [], []]);

  // ADR 0160: the settings written again hide the logins where serve's environment moved them.
  it("writes the settings again with the logins serve's environment moved", async () => {
    const configDirs = { CLAUDE_CONFIG_DIR: '/data/claude-work' };
    const moved = { ...setup, configDirs };
    await resume(undefined, { setup: async () => ({ kind: 'ready', setup: moved }) });
    const files = settings[0]?.settings.sandbox?.credentials.files.map(({ path }) => path);
    assert.ok(files?.includes('/data/claude-work/.credentials.json'), JSON.stringify(files));
  });

  // ADR 0162: and re-open the toolchain folders of serve's PATH under its home.
  it("writes the settings again with the toolchain folders of serve's PATH", async () => {
    const base = {
      PATH: '/home/brewer/.nvm/versions/node/v24.15.0/bin:/bin',
      HOME: '/home/brewer',
    };
    const withNvm = { ...setup, brewerEnv: { ...setup.brewerEnv, base } };
    await resume(undefined, { setup: async () => ({ kind: 'ready', setup: withNvm }) });
    const sandbox = settings[0]?.settings.sandbox as { filesystem?: { allowRead?: unknown } };
    assert.deepEqual(sandbox.filesystem?.allowRead, ['/home/brewer/.nvm/versions/node/v24.15.0']);
  });

  it('opens the latest finished attempt in its worktree, with its settings written again and the brewer environment', async () => {
    const result = await resume();
    assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
    assert.deepEqual(calls, [
      `recreate ${key} ${commit('2')} ${JSON.stringify([[key, 'resume-4242']])}`,
      'heartbeat stopped',
    ]);
    const file = settingsFileOf(workRoot, implement);
    const permissions = { allow: ['Read', 'Edit', 'Bash(npm test *)'], deny: ['WebFetch'] };
    assert.deepEqual(settings, [
      { file, settings: attemptSettings({ ...permissions, sandbox: true }) },
    ]);
    // ADR 0183: the engine's rules beside the settings, as the attempt had them.
    const system = join(
      workRoot,
      'attempt-settings',
      implement.batchId,
      'implement',
      '1.system.md',
    );
    assert.deepEqual(
      systemPrompts.map(({ file: written }) => written),
      [system],
    );
    assert.match(systemPrompts[0]?.text ?? '', /- Your shell runs only these commands: npm test\./);
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
          '--append-system-prompt-file',
          system,
        ],
        cwd: pathOf(implement),
        // The brewer's base and forced variables, with the terminal's own: never a token.
        env: {
          PATH: '/bin',
          TERM: 'xterm-256color',
          LANG: 'C.UTF-8',
          FOEDRUM_MODE: 'coder',
          GIT_TERMINAL_PROMPT: '0',
        },
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
    for (const step of ['plan#', 'plan#x', 'plan#0', 'plan#1.5']) {
      assert.deepEqual(
        await resume(step),
        refused(`${step} names no attempt: write <step>#<n> with a whole number n from 1`),
      );
    }
  });

  it('skips an attempt that ran no brewer or has not finished, and refuses one named', async () => {
    await resumeOf('24-1');
    assert.deepEqual(
      started.map(({ args }) => args[1]),
      [S4],
    );
    assert.deepEqual(
      await resumeOf('24-1', 'implement#1'),
      refused('attempt implement#1 of batch 24-1 ran no brewer: it has no session'),
    );
    assert.deepEqual(
      await resumeOf('24-1', 'implement'),
      refused('batch 24-1 has no finished attempt of step implement that ran a brewer'),
    );
    assert.deepEqual(
      await resumeOf('26-1', 'plan#1'),
      refused('attempt plan#1 of batch 26-1 has not finished'),
    );
    assert.deepEqual(
      await resumeOf('26-1'),
      refused('batch 26-1 has no finished attempt that ran a brewer'),
    );
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
    nothingOpened();
  });

  describe('a running batch (ADR 0127)', () => {
    let handed: { batchId: string; stepId: string }[];
    beforeEach(() => {
      handed = [];
    });
    const takes = {
      running: async (request: { batchId: string; stepId: string }) => {
        handed.push(request);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    it('hands the step whose attempt runs to the takeover, which drives it, and opens nothing itself', async () => {
      assert.deepEqual(await resumeOf('23-1', undefined, takes), {
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
      assert.deepEqual(await resumeOf('23-1', 'plan', takes), {
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
      assert.deepEqual(handed, [
        { batchId: '23-1', stepId: 'plan' },
        { batchId: '23-1', stepId: 'plan' },
      ]);
      nothingOpened();
    });

    it('hands over a retry waiting to continue the session of the attempt before it', async () => {
      const log = createCommandLog({ store, recipes });
      const claude = { version: '2.1.301', model: 'claude-sonnet-5-5' };
      const ending = { kind: 'failed', retryable: true, reason: 'claude crashed' } as const;
      const finish = { kind: 'finish', batchId: '23-1', stepId: 'plan', attempt: 1 } as const;
      assert.equal(log.issue({ ...finish, ending, claude }, t0).kind, 'accepted');
      // pint's maxAttempts is 1: Stuck, until a person retries it.
      const retry = { kind: 'retry', batchId: '23-1', by: 'ada', via: 'terminal' } as const;
      assert.equal(log.issue(retry, t0).kind, 'accepted');
      assert.deepEqual((await resumeOf('23-1', undefined, takes)).exitCode, 0);
      assert.deepEqual(handed, [{ batchId: '23-1', stepId: 'plan' }]);
      nothingOpened();
    });

    it('refuses a step with no attempt running or waiting to continue a session, saying why', async () => {
      const log = createCommandLog({ store, recipes });
      assert.equal(
        log.issue({ kind: 'retry', batchId: '21-1', by: 'ada', via: 'terminal' }, t0).kind,
        'accepted',
      );
      assert.deepEqual(
        await resume(undefined, takes),
        refused(
          'implement#2 of batch 21-1 would start a fresh session: implement#1 has no session claude started',
        ),
      );
      assert.deepEqual(
        await resume('plan', takes),
        refused('step plan of batch 21-1 has no attempt running or waiting to continue a session'),
      );
      assert.deepEqual(handed, []);
      nothingOpened();
    });

    it('refuses an attempt named by its number: the takeover continues the latest attempt of the step', async () => {
      assert.deepEqual(
        await resumeOf('23-1', 'plan#1', takes),
        refused(
          'batch 23-1 is brewing: name the step alone, and foedrum resume continues its latest attempt',
        ),
      );
      assert.deepEqual(handed, []);
    });

    it('refuses a step whose running attempt has no session, which a check step or a run before claude started has', async () => {
      const log = createCommandLog({ store, recipes });
      const issue = (command: Parameters<typeof log.issue>[0]) =>
        assert.equal(log.issue(command, t0).kind, 'accepted', JSON.stringify(command));
      issue({ kind: 'order', batchId: '29-1', order: { issue: 29 } });
      issue({ kind: 'route', batchId: '29-1', recipe: 'pint', reason: 'label', source: 'label' });
      issue({
        kind: 'record',
        event: { type: 'step.started', batchId: '29-1', stepId: 'plan', attempt: 1 },
      });
      assert.deepEqual(
        await resumeOf('29-1', undefined, takes),
        refused('batch 29-1 has no attempt running or waiting to continue a session'),
      );
      assert.deepEqual(handed, []);
    });

    describe('an interactive step whose session is open (ADR 0231)', () => {
      const since = '2026-10-22T11:30:00.000Z';
      const expiresAt = new Date(t0.getTime() + 60_000);
      // 30-1 brews sip: plan ran headless in S1, and talk#1's session opened at `since`, in S2.
      beforeEach(() => {
        const log = createCommandLog({ store, recipes });
        const issue = (command: Parameters<typeof log.issue>[0]) =>
          assert.equal(log.issue(command, t0).kind, 'accepted', JSON.stringify(command));
        issue({ kind: 'order', batchId: '30-1', order: { issue: 30 } });
        issue({ kind: 'route', batchId: '30-1', recipe: 'sip', reason: 'label', source: 'label' });
        for (const [stepId, id, at] of [
          ['plan', S1, '8'],
          ['talk', S2, '9'],
        ] as const) {
          const path = pathOf({ batchId: '30-1', stepId, attempt: 1 });
          issue({
            kind: 'record',
            event: {
              type: 'step.started',
              batchId: '30-1',
              stepId,
              attempt: 1,
              session: { id, worktree: path },
              worktree: {
                repo: 'acme/api',
                path,
                branch: `foedrum/30-1/${stepId}/1`,
                commit: commit(at),
              },
              ...(stepId === 'talk' ? { interactiveSince: since } : {}),
            },
          });
          if (stepId === 'plan') {
            issue({
              kind: 'finish',
              batchId: '30-1',
              stepId,
              attempt: 1,
              ending: { kind: 'succeeded', output: {} },
            });
          }
        }
      });
      const takenOver = () =>
        store.eventsAfter(0).filter(({ event }) => event.type === 'batch.taken_over');
      // Decided by the maintainer (2026-10-27): close the session so it reports, then brew again.
      const held = refused(
        `talk#1 of batch 30-1 is an interactive session still open in brew-7 (since ${since}, lease until ${expiresAt.toISOString()}): close it there so it reports; if it closes without its out doc, foedrum brew 30 --take opens it again`,
      );

      // Decided by the consultant (a /brew-review finding): the attempt's lease holds the session.
      const talk = attemptKey.encode({ batchId: '30-1', stepId: 'talk', attempt: 1 });
      const later = new Date(t0.getTime() + 90_000);
      const opened = () => assert.deepEqual([calls, started, settings], [[], [], []]);

      it('refuses it at once with the driver that holds its session, by step and with no step named, and takes nothing over', async () => {
        store.withTransaction((tx) => {
          tx.putLease({ attemptKey: talk, owner: 'brew-7', expiresAt });
          tx.putBatchLease({ batchId: '30-1', owner: 'brew-7', expiresAt: later });
        });
        assert.deepEqual(await resumeOf('30-1', 'talk', takes), held);
        assert.deepEqual(await resumeOf('30-1', undefined, takes), held);
        // Before the Claude Code and terminal checks: a terminal would wait the same.
        const inClaudeCode = { ...takes, terminal: { claudeCode: true, tty: false } };
        assert.deepEqual(await resumeOf('30-1', 'talk', inClaudeCode), held);
        assert.deepEqual([handed, takenOver()], [[], []]);
        opened();
      });

      it('names the driver whose session it is after a takeover moved the batch to another', async () => {
        store.withTransaction((tx) => {
          tx.putLease({ attemptKey: talk, owner: 'brew-7', expiresAt });
          tx.putBatchLease({ batchId: '30-1', owner: 'serve-1', expiresAt: later });
        });
        assert.deepEqual(await resumeOf('30-1', 'talk', takes), held);
        assert.deepEqual([handed, takenOver()], [[], []]);
        opened();
      });

      it('refuses it too when no driver holds its session, which waits for a session again once the attempt lease lapses', async () => {
        // The session's lease lapsed, serve holds the batch, and another attempt's lease is alive.
        store.withTransaction((tx) => {
          tx.putLease({ attemptKey: talk, owner: 'brew-7', expiresAt: new Date(t0.getTime() - 1) });
          tx.putLease({
            attemptKey: attemptKey.encode({ batchId: '23-1', stepId: 'plan', attempt: 1 }),
            owner: 'serve-1',
            expiresAt,
          });
          tx.putBatchLease({ batchId: '30-1', owner: 'serve-1', expiresAt: later });
        });
        assert.deepEqual(
          await resumeOf('30-1', 'talk', takes),
          refused(
            `talk#1 of batch 30-1 is an interactive session open since ${since}, and no driver holds the session: it waits for a session again once the attempt's lease lapses, then foedrum brew 30 --take opens a fresh one`,
          ),
        );
        assert.deepEqual([handed, takenOver()], [[], []]);
        opened();
      });

      it('still hands a running headless step to the takeover', async () => {
        assert.equal((await resumeOf('23-1', 'plan', takes)).exitCode, 0);
        assert.deepEqual(handed, [{ batchId: '23-1', stepId: 'plan' }]);
      });

      it('with no step named, refuses an open session even while a headless step before it runs', async () => {
        const log = createCommandLog({ store, recipes });
        const issue = (command: Parameters<typeof log.issue>[0]) =>
          assert.equal(log.issue(command, t0).kind, 'accepted', JSON.stringify(command));
        // 31-1 tastes in a parallel group: eye runs headless in S3, talk's session is open in S4.
        issue({ kind: 'order', batchId: '31-1', order: { issue: 31 } });
        issue({
          kind: 'route',
          batchId: '31-1',
          recipe: 'flight',
          reason: 'label',
          source: 'label',
        });
        for (const [stepId, id] of [
          ['eye', S3],
          ['talk', S4],
        ] as const) {
          const path = pathOf({ batchId: '31-1', stepId, attempt: 1 });
          issue({
            kind: 'record',
            event: {
              type: 'step.started',
              batchId: '31-1',
              stepId,
              attempt: 1,
              session: { id, worktree: path },
              worktree: {
                repo: 'acme/api',
                path,
                branch: `foedrum/31-1/${stepId}/1`,
                commit: commit('a'),
              },
              ...(stepId === 'talk' ? { interactiveSince: since } : {}),
            },
          });
        }
        assert.deepEqual(
          await resumeOf('31-1', undefined, takes),
          refused(
            `talk#1 of batch 31-1 is an interactive session open since ${since}, and no driver holds the session: it waits for a session again once the attempt's lease lapses, then foedrum brew 31 --take opens a fresh one`,
          ),
        );
        assert.deepEqual([handed, takenOver()], [[], []]);
      });

      it('with a step named, looks at that step alone', async () => {
        assert.deepEqual(
          await resumeOf('30-1', 'plan', takes),
          refused(
            'step plan of batch 30-1 has no attempt running or waiting to continue a session',
          ),
        );
        assert.deepEqual(handed, []);
      });

      it('takes an abandoned interactive attempt for no open session', async () => {
        const log = createCommandLog({ store, recipes });
        const issue = (command: Parameters<typeof log.issue>[0]) =>
          assert.equal(log.issue(command, t0).kind, 'accepted', JSON.stringify(command));
        // Stuck abandons talk#1 while it is started; the rewind brews the batch again from plan.
        issue({
          kind: 'stall',
          batchId: '30-1',
          stepId: 'talk',
          attempt: 1,
          lastProgressAt: t0,
          turnsWithoutProgress: 3,
        });
        issue({
          kind: 'rewind',
          batchId: '30-1',
          toStepId: 'plan',
          by: 'ada',
          via: 'terminal',
          shas: { 'acme/api': commit('8') },
        });
        assert.deepEqual(
          await resumeOf('30-1', 'talk', takes),
          refused(
            'step talk of batch 30-1 has no attempt running or waiting to continue a session',
          ),
        );
        assert.deepEqual(handed, []);
      });

      it('opens a finished interactive attempt for reading once the batch waits for a session (ADR 0126)', async () => {
        const log = createCommandLog({ store, recipes });
        const ending = { kind: 'failed', retryable: true, reason: 'no out doc' } as const;
        const finish = { kind: 'finish', batchId: '30-1', stepId: 'talk', attempt: 1 } as const;
        assert.equal(log.issue({ ...finish, ending }, t0).kind, 'accepted');
        const batch = fold(store.eventsAfter(0).map(({ event }) => event)).batches.get('30-1');
        const reason = batch?.lane.kind === 'stuck' ? batch.lane.reason : undefined;
        assert.deepEqual(reason, { kind: 'waiting_for_session', stepId: 'talk' });
        assert.equal((await resumeOf('30-1', 'talk#1', takes)).exitCode, 0);
        assert.deepEqual(handed, []);
        assert.deepEqual(
          started.map(({ args, cwd: folder }) => [args.includes(S2), folder]),
          [[true, pathOf({ batchId: '30-1', stepId: 'talk', attempt: 1 })]],
        );
      });
    });

    it('refuses an Ordered batch, of which no step has run', async () => {
      assert.deepEqual(
        await resumeOf('27-1', undefined, takes),
        refused('batch 27-1 is ordered: no step of it has run yet'),
      );
    });

    it('inside a Claude Code session, prints the line to run in a terminal and takes nothing over', async () => {
      const result = await resumeOf('23-1', undefined, {
        ...takes,
        terminal: { claudeCode: true, tty: false },
      });
      assert.deepEqual(result, {
        exitCode: 0,
        stdout: `foedrum resume opens claude in a terminal, which a Claude Code session cannot hand over; run this in a terminal in ${cwd}:
  foedrum resume 23-1 plan
`,
        stderr: '',
      });
      assert.deepEqual(handed, []);
    });

    it('says plainly when the session is not on this machine, and takes nothing over', async () => {
      assert.deepEqual(
        await resumeOf('23-1', undefined, { ...takes, sessionFound: () => false }),
        refused(
          `the session ${S3} of 23-1 plan#1 is not on this machine: Claude Code keeps a session where it ran, for 30 days by default`,
        ),
      );
      assert.deepEqual(handed, []);
    });
  });

  it('refuses with one line when there is no store, setup, repository or brewer, and opens nothing', async () => {
    assert.deepEqual(
      await resume(undefined, { openStore: () => undefined }),
      refused(`no event store at ${join(cwd, '.foedrum', 'index.db')}`),
    );
    assert.deepEqual(
      await resume(undefined, {
        setup: async () => ({
          kind: 'refused',
          problems: ['models.jsonc: not found', 'no claude'],
        }),
      }),
      {
        exitCode: 1,
        stdout: '',
        stderr: 'foedrum resume: models.jsonc: not found\nfoedrum resume: no claude\n',
      },
    );
    assert.deepEqual(
      await resume(undefined, {
        setup: async () => ({ kind: 'ready', setup: { ...setup, repositories: [] } }),
      }),
      refused('acme/api is no repository of this Brewery'),
    );
    assert.deepEqual(
      await resume(undefined, {
        setup: async () => ({
          kind: 'ready',
          setup: { ...setup, brewers: { find: () => undefined } },
        }),
      }),
      refused('recipe pint has no step implement'),
    );
    nothingOpened();
  });

  describe('an attempt of a recipe the batch has left (#670)', () => {
    // A mash batch: the Innkeeper's step ran in S1, its answer chose pale, which has no innkeep,
    // and the batch was cancelled.
    const mash = loadRecipes({
      recipes: [
        {
          path: 'recipes/mash.jsonc',
          text: recipeText('mash', [{ id: 'innkeep', brewer: 'innkeeper' }]),
        },
        {
          path: 'recipes/pale.jsonc',
          text: recipeText('pale', [{ id: 'brew', brewer: 'brewmaster' }]),
        },
      ],
      brewers: [
        { path: 'brewers/innkeeper.md', text: brewerText('innkeeper', { effort: 'low' }) },
        { path: 'brewers/brewmaster.md', text: brewerText('brewmaster', { effort: 'max' }) },
      ],
    });
    assert.ok(mash.valid);
    const mashSetup = async () =>
      ({ kind: 'ready', setup: { ...setup, brewers: mash.brewers } }) as const;
    const innkeep = { batchId: '12-1', stepId: 'innkeep', attempt: 1 };
    const path = pathOf(innkeep);
    const deadlineAt = '2026-10-22T13:00:00.000Z';
    beforeEach(() => {
      store.withTransaction((tx) => {
        tx.append({
          type: 'batch.ordered',
          batchId: '12-1',
          order: { issue: 12 },
          routeBy: deadlineAt,
        });
        tx.append({
          type: 'batch.recipe_chosen',
          batchId: '12-1',
          recipe: 'mash',
          reason: 'label',
          source: 'label',
        });
        tx.append({ type: 'step.scheduled', ...innkeep, deadlineAt });
        tx.append({
          type: 'step.started',
          ...innkeep,
          session: { id: S1, worktree: path },
          worktree: {
            repo: 'acme/api',
            path,
            branch: 'foedrum/12-1/innkeep/1',
            commit: commit('c'),
          },
        });
        tx.append({
          type: 'step.finished',
          ...innkeep,
          outcome: { kind: 'succeeded', output: null },
        });
        tx.append({
          type: 'batch.recipe_chosen',
          batchId: '12-1',
          recipe: 'pale',
          reason: 'the mash-in answer',
          source: 'human',
          by: 'ada',
          via: 'terminal',
        });
        // Ended, so resume opens a finished attempt rather than taking the batch over.
        tx.append({ type: 'batch.cancelled', batchId: '12-1', by: 'ada', via: 'terminal' });
      });
    });

    it('opens the attempt with the brewer of the recipe it was scheduled under', async () => {
      const result = await resumeOf('12-1', 'innkeep', { setup: mashSetup });
      assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
      const args = started[0]?.args ?? [];
      assert.deepEqual(
        [started.length, args.slice(0, 2), args[args.indexOf('--effort') + 1], started[0]?.cwd],
        [1, ['--resume', S1], 'low', path],
      );
    });
  });

  it('refuses an attempt another resume has open, but not a batch a driver holds', async () => {
    const expiresAt = new Date(t0.getTime() + 60_000);
    store.withTransaction((tx) => tx.putLease({ attemptKey: key, owner: 'resume-1', expiresAt }));
    assert.deepEqual(
      await resume(),
      refused(
        `attempt implement#1 of batch 21-1 is open in resume-1 until ${expiresAt.toISOString()}`,
      ),
    );
    assert.deepEqual([calls, started], [[], []]);
    store.withTransaction((tx) => {
      tx.releaseLease(key);
      tx.putBatchLease({ batchId: '21-1', owner: 'cellar', expiresAt });
    });
    assert.equal((await resume()).exitCode, 0);
    assert.equal(started.length, 1);
  });

  it("claims the worktree with the attempt's lease alone while claude runs, renews it every third of the lease, and lets it go after", async () => {
    const state = () => fold(store.eventsAfter(0).map(({ event }) => event));
    const during: unknown[] = [];
    const claude = async () => {
      during.push(worktreeClaims(state(), store.currentLeases(now)).leased);
      now = new Date(t0.getTime() + 4 * 60_000);
      for (const { beat } of beats) beat();
      // Past the first lease, so alive only because the beat renewed it.
      now = new Date(t0.getTime() + 8 * 60_000);
      during.push(worktreeClaims(state(), store.currentLeases(now)).leased);
      during.push(store.batchLeases(now).length);
      return 0;
    };
    await resume(undefined, { claude });
    assert.deepEqual(during, [[implement], [implement], 0]);
    assert.deepEqual(
      beats.map(({ everyMs }) => everyMs),
      [100_000],
    );
    assert.deepEqual(said, []);
    assert.deepEqual(store.currentLeases(now), []);
  });

  it('says when a renewal finds the attempt taken or cannot be written, and goes on', async () => {
    const claude = async () => {
      // The lease expired (a machine asleep) and another resume took the attempt.
      now = new Date(t0.getTime() + 6 * 60_000);
      const expiresAt = new Date(now.getTime() + 60_000);
      store.withTransaction((tx) => tx.putLease({ attemptKey: key, owner: 'resume-1', expiresAt }));
      for (const { beat } of beats) beat();
      assert.deepEqual(leaseOwners(), [[key, 'resume-1']]);
      return 0;
    };
    await resume(undefined, { claude });
    // Its lease is not this resume's to let go.
    assert.deepEqual(leaseOwners(), [[key, 'resume-1']]);
    store.withTransaction((tx) => tx.releaseLease(key));
    let failing = false;
    const failingStore = (): EventStore => ({
      ...store,
      withTransaction: (fn) => {
        if (failing) throw new Error('database is locked');
        return store.withTransaction(fn);
      },
      close: () => {},
    });
    const claudeOnLockedStore = async () => {
      failing = true;
      for (const { beat } of beats.slice(1)) beat();
      failing = false;
      return 0;
    };
    await resume(undefined, { openStore: failingStore, claude: claudeOnLockedStore });
    assert.deepEqual(said, [
      'foedrum resume: lost the claim on attempt implement#1 of batch 21-1 to resume-1: the cleanup may remove its worktree once that claim ends',
      'foedrum resume: could not renew the claim on attempt implement#1 of batch 21-1: database is locked',
    ]);
  });

  it('lets the claim go when claude cannot start', async () => {
    const claude = () => Promise.reject(new Error('spawn ENOENT'));
    await assert.rejects(resume(undefined, { claude }), /spawn ENOENT/);
    assert.deepEqual(store.currentLeases(now), []);
  });

  it('inside a Claude Code session, prints the line to run in a terminal and opens nothing', async () => {
    const result = await resume(undefined, { terminal: { claudeCode: true, tty: false } });
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: `foedrum resume opens claude in a terminal, which a Claude Code session cannot hand over; run this in a terminal in ${cwd}:\n  foedrum resume 21-1 implement#1\n`,
      stderr: '',
    });
    nothingOpened();
  });

  it('refuses a batch that started brewing again while the setup was read, and claims nothing', async () => {
    const setupWhileRetried = async () => {
      const log = createCommandLog({ store, recipes });
      const retried = log.issue({ kind: 'retry', batchId: '21-1', by: 'ada', via: 'terminal' }, t0);
      assert.equal(retried.kind, 'accepted');
      return { kind: 'ready' as const, setup };
    };
    assert.deepEqual(
      await resume(undefined, { setup: setupWhileRetried }),
      refused('batch 21-1 is brewing now: run foedrum resume again to take it over'),
    );
    nothingOpened();
  });

  it('refuses a session id that is no UUID before it looks for a transcript', async () => {
    const result = await resumeOf('28-1', undefined, {
      sessionFound: () => assert.fail('no transcript to look for'),
    });
    assert.deepEqual(
      result,
      refused(
        'attempt plan#1 of batch 28-1 records the session id "../../x", which is no session id',
      ),
    );
    nothingOpened();
  });

  it("passes the terminal's own variables on, by any case on Windows", async () => {
    const env = {
      Term: 'xterm',
      WT_SESSION: 'a-tab',
      TERM_PROGRAM_VERSION: '1.95',
      LC_CTYPE: 'UTF-8',
      GITHUB_TOKEN: 'a token',
    };
    await resume(undefined, { env, platform: 'win32' });
    const { PATH, GIT_TERMINAL_PROMPT, FOEDRUM_MODE, ...terminal } = started[0]?.env ?? {};
    assert.deepEqual([PATH, GIT_TERMINAL_PROMPT, FOEDRUM_MODE], ['/bin', '0', 'coder']);
    assert.deepEqual(terminal, {
      Term: 'xterm',
      WT_SESSION: 'a-tab',
      TERM_PROGRAM_VERSION: '1.95',
      LC_CTYPE: 'UTF-8',
    });
  });

  it('refuses when stdin is not a terminal, and opens nothing', async () => {
    const result = await resume(undefined, { terminal: { claudeCode: false, tty: false } });
    assert.deepEqual(
      result,
      refused(
        'stdin is not a terminal, and claude needs one: run foedrum resume in a terminal (on Windows, a console window, or winpty in mintty)',
      ),
    );
    nothingOpened();
  });
});

describe("foedrum resume: where Claude Code keeps a session's transcript (ADR 0116)", () => {
  it('is CLAUDE_CONFIG_DIR, in any case on Windows, else .claude in the home folder', () => {
    const home = join(sep, 'home', 'ada');
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/cfg' }, 'linux', home), '/cfg');
    assert.equal(
      claudeConfigDir({ claude_config_dir: '/cfg' }, 'linux', home),
      join(home, '.claude'),
    );
    assert.equal(claudeConfigDir({ Claude_Config_Dir: 'C:\\cfg' }, 'win32', home), 'C:\\cfg');
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }, 'linux', home), join(home, '.claude'));
    assert.equal(claudeConfigDir({}, 'darwin', home), join(home, '.claude'));
  });

  it('is found as <id>.jsonl in any project folder under projects/', () => {
    const config = join(sep, 'cfg');
    const files = new Set([join(config, 'projects', 'D--work-b', `${S2}.jsonl`)]);
    const fs = {
      folders: (path: string) =>
        path === join(config, 'projects') ? ['D--work-a', 'D--work-b'] : [],
      exists: (path: string) => files.has(path),
    };
    assert.equal(sessionFoundIn(config, S2, fs), true);
    assert.equal(sessionFoundIn(config, S1, fs), false);
    assert.equal(sessionFoundIn(join(sep, 'elsewhere'), S2, fs), false);
  });
});
