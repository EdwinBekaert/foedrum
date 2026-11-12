// The setup `foedrum brew`'s tests share (ADR 0123): an in-memory store, a fake GitHub with the
// Brewery's issues, and serve's shell over fake worktrees and the scripted runner. `brewFixture`
// registers the hooks in the describe that calls it, and its fields hold the current test's state,
// so a test reads them through the object. No process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'node:test';
import type { BrewRequest } from '../../src/cli/brew.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { AttemptProgress } from '../../src/engine/supervisor.ts';
import { type Behaviour, fakeBrewerRunner } from './fake-brewer-runner.ts';
import { ghOver } from './fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi } from './fake-github-api.ts';
import { fakeLock } from './fake-lock.ts';
import { FAKE_COMMIT, fakeWorktreeMerge, fakeWorktrees } from './fake-worktrees.ts';
import { local, serveInputs } from './serve-brewery.ts';
import { makeTempDir, type TempDir } from './temp-dir.ts';

export const t0 = new Date('2026-10-22T12:00:00.000Z');

export const request: BrewRequest = {
  target: { issue: 12 },
  owner: 'ann',
  by: 'ann',
  via: 'terminal',
};

export const idle: AttemptProgress = { lastProgressAt: t0, turnsWithoutProgress: 0 };

export interface BrewFixture {
  dir: TempDir;
  setup: ServeSetup;
  store: EventStore;
  lines: string[];
  api: FakeGitHubApi;
  lock: ReturnType<typeof fakeLock>;
  locked: string[];
  started: string[];
  /** The runs the last shell's runner was asked to stop, by attempt key. */
  stops: readonly string[];
  log: () => ReturnType<typeof createCommandLog>;
  /** The live lease of batch 12-1. */
  leaseOf: () => ReturnType<EventStore['batchLeases']>[number] | undefined;
  /** serve's shell with fakes, ticking until brew stops, or failing after 20 ticks. */
  shell: (brew: Behaviour, overrides?: Partial<ServeShell>) => ServeShell;
}

export const brewFixture = (): BrewFixture => {
  const f = {} as BrewFixture;

  beforeEach(() => {
    f.dir = makeTempDir('brew');
    const result = serveSetup(
      serveInputs({ files: { ...serveInputs().files, local: local({ workRoot: f.dir.path }) } }),
    );
    f.setup = result.kind === 'ready' ? result.setup : assert.fail();
    // brew closes its store at the end; the test reads it after.
    const inner = openSqliteEventStore(':memory:');
    f.store = { ...inner, close: () => {} };
    f.lines = [];
    f.locked = [];
    f.started = [];
    f.lock = fakeLock('ann');
    f.api = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          {
            number: 12,
            labels: ['recipe:stout'],
            author: 'ann',
            title: 'Add a --json flag',
            body: 'Add a --json flag.',
          },
          { number: 13, labels: [], author: 'ann', title: 'Unlabelled', body: 'No recipe.' },
          {
            number: 14,
            labels: ['recipe:stout', 'recipe:porter'],
            author: 'ann',
            title: 'Two recipes',
            body: 'Both.',
          },
          {
            number: 15,
            labels: ['recipe:stoutt'],
            author: 'ann',
            title: 'A typo',
            body: 'No such recipe.',
          },
        ],
      },
    });
  });
  afterEach(() => f.dir.remove());

  f.log = () => createCommandLog({ store: f.store, recipes: f.setup.recipes });
  f.leaseOf = () => f.store.batchLeases(t0).find(({ batchId }) => batchId === '12-1');

  f.shell = (brew: Behaviour, overrides: Partial<ServeShell> = {}): ServeShell => {
    let ticks = 0;
    const runner = fakeBrewerRunner((attempt) => {
      f.started.push(`${attempt.ref.stepId}#${attempt.ref.attempt}`);
      return brew;
    });
    f.stops = runner.stopped;
    return {
      out: (line) => f.lines.push(line),
      signal: new AbortController().signal,
      clock: () => t0,
      wait: async () => {
        ticks++;
        if (ticks > 20) assert.fail(`brew did not stop:\n${f.lines.join('\n')}`);
      },
      lock: (_workRoot, { owner }) => {
        f.locked.push(owner);
        return f.lock;
      },
      openStore: () => f.store,
      stateBranch: () => ({
        start: async () => ({ decision: 'ready' }),
        flush: async () => ({ kind: 'unchanged' }),
      }),
      worktrees: async () => fakeWorktrees({ root: join(f.dir.path, 'acme.web', 'attempts') }),
      merge: () => fakeWorktreeMerge(),
      push: () => ({
        commit: async () => FAKE_COMMIT,
        baseTip: async () => 'b'.repeat(40),
        isAncestor: async (commit, of) => commit === of,
        remoteTip: async () => undefined,
        push: async () => {},
        secretScan: async () => [],
        touchedFiles: async () => [],
        fileAt: async () => undefined,
      }),
      runner: () => runner,
      exec: () => Promise.reject(new Error('no check step runs here')),
      setup: () => Promise.reject(new Error('no repository setup runs here')),
      gh: ghOver(f.api.fetch).exec,
      // A check step looks for the test map (ADR 0274): the clone has none.
      git: (_cwd, args) =>
        args[0] === 'ls-tree'
          ? Promise.resolve({ code: 0, stdout: '', stderr: '' })
          : Promise.reject(new Error('no red proof or guarded step runs here')),
      ...overrides,
    };
  };

  return f;
};
