// `foedrum recipe`'s effects (ADR 0355): runApplyEffects on serve's shell with an in-memory store,
// fake worktrees and a fake GitHub. A person chose the recipe of an ordered batch; the batch's
// due effects go out at once, its recipe label and its status comment among them, and no attempt
// starts. No process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runApplyEffects } from '../../src/cli/apply-effects.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { FAKE_COMMIT, fakeWorktreeMerge, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { local, serveInputs } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const t0 = new Date('2026-11-08T13:57:00.000Z');

describe('runApplyEffects (ADR 0355)', () => {
  let dir: TempDir;
  let store: EventStore;
  let api: FakeGitHubApi;
  let started: string[];
  const request = { batchId: '12-1', owner: 'recipe-4242' };

  const setupOf = (): ServeSetup => {
    const files = serveInputs().files;
    const ready = serveSetup(
      serveInputs({ files: { ...files, local: local({ workRoot: dir.path }) } }),
    );
    return ready.kind === 'ready' ? ready.setup : assert.fail(JSON.stringify(ready));
  };

  beforeEach(() => {
    dir = makeTempDir('apply-effects');
    const inner = openSqliteEventStore(':memory:');
    store = { ...inner, close: () => {} };
    started = [];
    api = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [{ number: 12, labels: [], author: 'ann', title: 'Add', body: 'Add it.' }],
      },
    });
  });
  afterEach(() => dir.remove());

  /** Batch 12-1 is ordered, and ann chose porter for it from the terminal. */
  const chosen = (setup: ServeSetup): void => {
    const log = createCommandLog({ store, recipes: setup.recipes });
    const issue = (command: Parameters<typeof log.issue>[0]) =>
      assert.equal(log.issue(command, t0).kind, 'accepted', JSON.stringify(command));
    issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } });
    issue({
      kind: 'recipe',
      batchId: '12-1',
      recipe: 'porter',
      reason: 'it needs its tests read',
      by: 'ann',
      via: 'terminal',
    });
  };

  const shell = (overrides: Partial<ServeShell> = {}): ServeShell => ({
    out: () => assert.fail('the lines are returned'),
    signal: new AbortController().signal,
    clock: () => t0,
    wait: async () => assert.fail('nothing waits for a tick'),
    lock: () => fakeLock(request.owner),
    openStore: () => store,
    stateBranch: () => ({
      start: async () => ({ decision: 'ready' }),
      flush: async () => ({ kind: 'unchanged' }),
    }),
    worktrees: async () => fakeWorktrees({ root: join(dir.path, 'acme.web', 'attempts') }),
    merge: () => fakeWorktreeMerge(),
    push: () => ({
      commit: async () => FAKE_COMMIT,
      baseTip: async () => 'b'.repeat(40),
      isAncestor: async (commit, of) => commit === of,
      remoteTip: async () => undefined,
      push: async () => {},
      secretScan: async () => [],
      touchedFiles: async () => [],
    }),
    runner: () => ({
      start: (attempt) => {
        started.push(`${attempt.ref.stepId}#${attempt.ref.attempt}`);
        return assert.fail('no attempt starts');
      },
      progress: () => undefined,
    }),
    exec: () => Promise.reject(new Error('no check step runs here')),
    setup: () => Promise.reject(new Error('no repository setup runs here')),
    gh: ghOver(api.fetch).exec,
    git: () => Promise.reject(new Error('no red proof or guarded step runs here')),
    ...overrides,
  });

  it("puts the recipe label and a status comment with the person's reason on the Brewery issue, and starts nothing", async () => {
    const setup = setupOf();
    chosen(setup);
    const lines = await runApplyEffects(setup, shell(), request);
    assert.deepStrictEqual(lines, []);
    const labels = api.issue('acme/brewery', 12)?.labels ?? [];
    assert.ok(labels.includes('recipe:porter'), labels.join(', '));
    assert.ok(labels.includes('foedrum:brewing'), labels.join(', '));
    const bodies = (api.comments.get('acme/brewery#12') ?? []).map(({ body }) => body);
    assert.equal(bodies.length, 1, bodies.join('\n---\n'));
    assert.match(
      bodies[0] ?? '',
      /^Recipe \*\*porter\*\*, chosen by ann \(terminal\): it needs its tests read$/m,
    );
    assert.deepStrictEqual(started, []);
    assert.deepStrictEqual(store.batchLeases(t0), [], 'it lets the batch go');
  });

  it('says the effects wait for the next brew or serve when GitHub cannot be reached', async () => {
    const setup = setupOf();
    chosen(setup);
    const offline = () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com'));
    const lines = await runApplyEffects(setup, shell({ gh: offline }), request);
    assert.deepStrictEqual(lines, [
      'the recipe label and status comment go up at the next foedrum brew or foedrum serve: getaddrinfo ENOTFOUND api.github.com',
    ]);
    assert.deepStrictEqual(api.issue('acme/brewery', 12)?.labels, []);
  });

  it('says an effect that failed, and that the rest go up at the next brew or serve', async () => {
    const setup = setupOf();
    chosen(setup);
    const { exec } = ghOver(api.fetch);
    // GitHub answers all but the issue's labels.
    const gh: ServeShell['gh'] = (file, args, options) =>
      args.some((arg) => /issues\/12\/labels/.test(arg))
        ? Promise.reject(new Error('the labels cannot be read'))
        : exec(file, args, options);
    const lines = await runApplyEffects(setup, shell({ gh }), request);
    assert.equal(
      lines.at(-1),
      'the recipe label and status comment go up at the next foedrum brew or foedrum serve: an effect failed',
    );
    assert.ok(
      lines.slice(0, -1).some((line) => line.includes('the labels cannot be read')),
      lines.join('\n'),
    );
    assert.deepStrictEqual(store.batchLeases(t0), [], 'it lets the batch go');
  });

  it('leaves the effects to the driver that holds the batch', async () => {
    const setup = setupOf();
    chosen(setup);
    const expiresAt = new Date(t0.getTime() + 60_000);
    store.withTransaction((tx) =>
      tx.putBatchLease({ batchId: '12-1', owner: 'cellar', expiresAt }),
    );
    const lines = await runApplyEffects(setup, shell(), request);
    assert.deepStrictEqual(lines, [
      'the recipe label and status comment go up at the next tick of cellar, which holds the batch',
    ]);
    assert.deepStrictEqual(api.issue('acme/brewery', 12)?.labels, []);
    assert.deepStrictEqual(
      store.batchLeases(t0).map(({ owner }) => owner),
      ['cellar'],
    );
  });
});
