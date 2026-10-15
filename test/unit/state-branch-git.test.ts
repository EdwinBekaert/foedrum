import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import { openStateBranch } from '../../src/engine/state-branch-git.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { Git, GitResult } from '../../src/workspace/git.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const ordered = (batchId: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: { issue: 6 },
});
const scheduled = (batchId: string): Event => ({
  type: 'step.scheduled',
  batchId,
  stepId: 'plan',
  attempt: 1,
  deadlineAt: '2026-10-15T12:00:00Z',
});
const released: Event = {
  type: 'release.observed',
  repo: 'acme/lib-core',
  package: 'lib-core',
  version: '2.4.0',
};
const line = (id: number, event: Event): string => `${JSON.stringify({ id, event })}\n`;

const sha = (n: number): string => n.toString(16).padStart(40, '0');
const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const exit = (code: number | null, stderr = '', stdout = ''): GitResult => ({
  code,
  stdout,
  stderr,
});

interface Call {
  cwd: string;
  args: string[];
  timeoutMs: number | undefined;
}

/**
 * A fake git that simulates what the shell relies on: the remote branch, the clone's local
 * branch, the worktree's head and its commits. `files` is written into the worktree when it is
 * created, as if checked out from the remote. `answer` overrides any call.
 */
class FakeGit {
  readonly calls: Call[] = [];
  remote: string | undefined;
  head: string | undefined;
  localBranch = false;
  /** The files of the remote branch, written into a new worktree. */
  files: Record<string, string> = {};
  signing = false;
  private next = 100;
  answer: (args: string[]) => GitResult | undefined = () => undefined;

  private readonly worktree: string;

  constructor(worktree: string) {
    this.worktree = worktree;
  }

  readonly git: Git = async (cwd, args, options) => {
    const list = [...args];
    this.calls.push({ cwd, args: list, timeoutMs: options?.timeoutMs });
    return this.answer(list) ?? this.simulate(list);
  };

  private simulate(args: string[]): GitResult {
    const [command, ...rest] = args;
    switch (command) {
      case 'ls-remote':
        return this.remote === undefined
          ? exit(2)
          : ok(`${this.remote}\trefs/heads/foedrum/state\n`);
      case 'fetch':
      case 'update-ref':
      case 'add':
      case 'status':
        return ok();
      case 'rev-parse':
        if (rest.includes('refs/heads/foedrum/state'))
          return this.localBranch ? ok(sha(1)) : exit(1);
        return this.head === undefined ? exit(1) : ok(`${this.head}\n`);
      case 'worktree': {
        mkdirSync(this.worktree, { recursive: true });
        writeFileSync(join(this.worktree, '.git'), 'gitdir: elsewhere\n');
        if (!rest.includes('--orphan')) {
          this.head = this.remote;
          for (const [path, text] of Object.entries(this.files)) {
            mkdirSync(dirname(join(this.worktree, path)), { recursive: true });
            writeFileSync(join(this.worktree, path), text);
          }
        }
        return ok();
      }
      case 'symbolic-ref':
        return ok('foedrum/state\n');
      case 'config':
        return this.signing ? ok('true\n') : exit(1);
      case 'write-tree':
        return ok(`${sha(9)}\n`);
      case 'commit-tree':
        return ok(`${sha(10)}\n`);
      case 'merge-base':
        return ok();
      case 'merge':
        this.head = rest.at(-1);
        return ok();
      case 'diff':
        return exit(1);
      case 'commit':
        this.head = sha(this.next++);
        return ok();
      case 'push':
        this.remote = this.head;
        return ok('To origin\n \trefs/heads/foedrum/state:refs/heads/foedrum/state\tx..y\nDone\n');
      default:
        throw new Error(`unexpected git ${args.join(' ')}`);
    }
  }

  commands(): string[] {
    return this.calls.map((call) => call.args.slice(0, 2).join(' '));
  }

  find(command: string): Call | undefined {
    return this.calls.find((call) => call.args[0] === command);
  }
}

describe('openStateBranch with a fake git', () => {
  let dir: TempDir;
  let worktree: string;
  let store: EventStore;
  let fake: FakeGit;
  const clone = 'brewery';

  beforeEach(() => {
    dir = makeTempDir('state-branch');
    worktree = join(dir.path, 'state');
    store = openSqliteEventStore(':memory:');
    fake = new FakeGit(worktree);
  });
  afterEach(() => {
    store.close();
    dir.remove();
  });

  const branch = () => openStateBranch({ store, git: fake.git, clone, worktree });
  const append = (...events: Event[]): void =>
    store.withTransaction((tx) => {
      for (const event of events) tx.append(event);
    });
  const read = (path: string): string => readFileSync(join(worktree, path), 'utf8');

  describe('start', () => {
    it('creates an orphan worktree for a new Brewery and is ready', async () => {
      const result = await branch().start();

      assert.deepEqual(result, { decision: 'ready' });
      const add = fake.calls.find((call) => call.args[0] === 'worktree');
      assert.deepEqual(add?.args, ['worktree', 'add', '--orphan', '-b', 'foedrum/state', worktree]);
      assert.equal(add?.cwd, clone);
      assert.equal(fake.find('fetch'), undefined);
    });

    it('rebuilds a missing database from the branch, keeping ids', async () => {
      fake.remote = sha(5);
      fake.files = {
        'events.jsonl': line(3, released),
        'batches/b1/events.jsonl': line(1, ordered('b1')) + line(4, scheduled('b1')),
        'batches/b2/events.jsonl': line(2, ordered('b2')),
        'batches/b1/plan-1.md': '# Plan\n',
      };

      const result = await branch().start();

      assert.deepEqual(result, { decision: 'restore' });
      assert.deepEqual(store.eventsAfter(0), [
        { id: 1, event: ordered('b1') },
        { id: 2, event: ordered('b2') },
        { id: 3, event: released },
        { id: 4, event: scheduled('b1') },
      ]);
      assert.deepEqual(store.pushedThrough(), { eventId: 4, commit: sha(5) });
      const fetch = fake.find('fetch');
      assert.deepEqual(fetch?.args, [
        'fetch',
        '--no-tags',
        'origin',
        '+refs/heads/foedrum/state:refs/remotes/origin/foedrum/state',
      ]);
      const add = fake.find('worktree');
      assert.deepEqual(add?.args, [
        'worktree',
        'add',
        '--no-track',
        '-b',
        'foedrum/state',
        worktree,
        sha(5),
      ]);
    });

    it('uses the local branch when the clone has one', async () => {
      fake.remote = sha(5);
      fake.localBranch = true;
      await branch().start();
      assert.deepEqual(fake.find('worktree')?.args, ['worktree', 'add', worktree, 'foedrum/state']);
    });

    it('fast-forwards a worktree that is behind, then appends the new events', async () => {
      append(ordered('b1'));
      store.withTransaction((tx) => tx.markPushed({ eventId: 1, commit: sha(4) }));
      mkdirSync(join(worktree, 'batches', 'b1'), { recursive: true });
      writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere\n');
      fake.head = sha(4);
      fake.remote = sha(6);
      // The merge brings the other engine's event 2 into the worktree.
      fake.answer = (args) => {
        if (args[0] !== 'merge') return undefined;
        writeFileSync(
          join(worktree, 'batches', 'b1', 'events.jsonl'),
          line(1, ordered('b1')) + line(2, scheduled('b1')),
        );
        fake.head = sha(6);
        return ok();
      };

      const result = await branch().start();

      assert.deepEqual(result, { decision: 'restore' });
      assert.deepEqual(fake.find('merge')?.args, ['merge', '--ff-only', '-q', sha(6)]);
      assert.deepEqual(
        store.eventsAfter(0).map((stored) => stored.id),
        [1, 2],
      );
      assert.deepEqual(store.pushedThrough(), { eventId: 2, commit: sha(6) });
    });

    it('refuses to rebuild over changed log files in the worktree', async () => {
      fake.remote = sha(5);
      fake.answer = (args) =>
        args[0] === 'status' ? ok(' M batches/b1/events.jsonl\0') : undefined;
      await assert.rejects(branch().start(), StateBranchStopError);
      assert.equal(store.lastEventId(), 0);
    });

    it('flushes events that were never pushed', async () => {
      append(ordered('b1'), released);
      const result = await branch().start();
      assert.equal(result.decision, 'flush');
      assert.deepEqual(result.flush, { kind: 'pushed', through: 2, commit: sha(100) });
      assert.equal(read('batches/b1/events.jsonl'), line(1, ordered('b1')));
      assert.equal(read('events.jsonl'), line(2, released));
    });

    it('stops when local events were not pushed and the branch moved, naming both heads', async () => {
      append(ordered('b1'), ordered('b2'));
      store.withTransaction((tx) => tx.markPushed({ eventId: 1, commit: sha(4) }));
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere\n');
      fake.head = sha(7);
      fake.remote = sha(8);

      await assert.rejects(
        branch().start(),
        (error) =>
          error instanceof StateBranchStopError &&
          error.message.includes(sha(7)) &&
          error.message.includes(`origin/foedrum/state is at ${sha(8)}`),
      );
      assert.equal(fake.find('push'), undefined);
    });

    it('checks that the remote branch still contains the last pushed commit', async () => {
      append(ordered('b1'));
      store.withTransaction((tx) => tx.markPushed({ eventId: 1, commit: sha(4) }));
      fake.remote = sha(8);
      fake.answer = (args) => (args[0] === 'merge-base' ? exit(1) : undefined);
      await assert.rejects(branch().start(), /rewritten/);
      assert.deepEqual(fake.find('merge-base')?.args, [
        'merge-base',
        '--is-ancestor',
        sha(4),
        sha(8),
      ]);
    });

    it('fails when the remote cannot be reached', async () => {
      fake.answer = (args) =>
        args[0] === 'ls-remote' ? exit(128, 'fatal: unable to access origin\n') : undefined;
      await assert.rejects(branch().start(), /unable to access origin/);
      assert.equal(fake.find('worktree'), undefined);
    });

    it('refuses a worktree that is on another branch', async () => {
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere\n');
      fake.answer = (args) => (args[0] === 'symbolic-ref' ? ok('main\n') : undefined);
      await assert.rejects(branch().start(), /main/);
    });
  });

  describe('the signing check at start', () => {
    it('makes a test commit on a throw-away ref and deletes the ref', async () => {
      await branch().start();
      const probe = fake.calls.filter((call) =>
        ['write-tree', 'commit-tree', 'update-ref'].includes(call.args[0] ?? ''),
      );
      assert.deepEqual(
        probe.map((call) => call.args),
        [
          ['write-tree'],
          ['commit-tree', sha(9), '-m', 'Foedrum signing check'],
          ['update-ref', 'refs/foedrum/signing-check', sha(10)],
          ['update-ref', '-d', 'refs/foedrum/signing-check', sha(10)],
        ],
      );
      for (const call of probe) assert.equal(call.cwd, worktree);
      const commit = probe[1];
      assert.ok(commit?.timeoutMs !== undefined && commit.timeoutMs <= 15_000, 'a short timeout');
    });

    it('refuses to start when signing is on and the test commit fails, naming the setting', async () => {
      fake.signing = true;
      fake.answer = (args) =>
        args[0] === 'commit-tree' ? exit(128, 'error: gpg failed to sign the data\n') : undefined;
      await assert.rejects(
        branch().start(),
        (error) =>
          error instanceof StateBranchStopError &&
          /commit\.gpgSign/.test(error.message) &&
          /gpg failed to sign the data/.test(error.message),
      );
      assert.deepEqual(
        fake.calls.filter((call) => call.args[0] === 'update-ref'),
        [],
      );
    });

    it('refuses to start when the test commit times out', async () => {
      fake.signing = true;
      fake.answer = (args) => (args[0] === 'commit-tree' ? exit(null, 'killed') : undefined);
      await assert.rejects(branch().start(), /commit\.gpgSign/);
    });

    it("refuses to start when a commit fails without signing, with git's reason", async () => {
      fake.answer = (args) =>
        args[0] === 'commit-tree'
          ? exit(128, 'fatal: unable to auto-detect email address\n')
          : undefined;
      await assert.rejects(
        branch().start(),
        (error) =>
          error instanceof StateBranchStopError &&
          /unable to auto-detect email address/.test(error.message) &&
          !/gpgSign/.test(error.message),
      );
    });
  });

  describe('flush', () => {
    const started = async () => {
      const state = branch();
      await state.start();
      fake.calls.length = 0;
      return state;
    };

    it('writes, commits and pushes the events after the marker, then moves the marker', async () => {
      const state = await started();
      append(ordered('b1'), released, scheduled('b1'));

      const result = await state.flush();

      assert.deepEqual(result, { kind: 'pushed', through: 3, commit: sha(100) });
      assert.equal(
        read('batches/b1/events.jsonl'),
        line(1, ordered('b1')) + line(3, scheduled('b1')),
      );
      assert.equal(read('events.jsonl'), line(2, released));
      assert.deepEqual(store.pushedThrough(), { eventId: 3, commit: sha(100) });
      const args = (command: string) => fake.find(command)?.args;
      assert.deepEqual(args('commit'), ['commit', '--no-verify', '-q', '-m', 'Record events 1–3']);
      assert.deepEqual(args('push'), [
        'push',
        '--porcelain',
        '--no-verify',
        'origin',
        'refs/heads/foedrum/state:refs/heads/foedrum/state',
      ]);
      assert.ok((fake.find('push')?.timeoutMs ?? 0) > 0, 'the push has a timeout');
      for (const call of fake.calls) assert.equal(call.cwd, worktree);
    });

    it('adds a .gitattributes that keeps git from converting line ends', async () => {
      const state = await started();
      append(ordered('b1'));
      await state.flush();
      assert.equal(read('.gitattributes'), '* -text\n');
    });

    it('appends to the files of earlier flushes', async () => {
      const state = await started();
      append(ordered('b1'));
      await state.flush();
      append(scheduled('b1'));
      await state.flush();
      assert.equal(
        read('batches/b1/events.jsonl'),
        line(1, ordered('b1')) + line(2, scheduled('b1')),
      );
      assert.deepEqual(store.pushedThrough(), { eventId: 2, commit: sha(101) });
    });

    it('does nothing without new events', async () => {
      const state = await started();
      assert.deepEqual(await state.flush(), { kind: 'unchanged' });
      assert.deepEqual(fake.calls, []);
    });

    it('stops when the push is rejected, naming both heads, and keeps the marker', async () => {
      const state = await started();
      append(ordered('b1'));
      fake.answer = (args) => {
        if (args[0] === 'push') {
          return exit(
            1,
            'error: failed to push some refs\n',
            'To origin\n!\trefs/heads/foedrum/state:refs/heads/foedrum/state\t[rejected] (fetch first)\nDone\n',
          );
        }
        if (args[0] === 'ls-remote') return ok(`${sha(77)}\trefs/heads/foedrum/state\n`);
        return undefined;
      };

      await assert.rejects(
        state.flush(),
        (error) =>
          error instanceof StateBranchStopError &&
          error.message.includes(sha(100)) &&
          error.message.includes(sha(77)),
      );
      assert.equal(store.pushedThrough(), undefined);
    });

    it('reports a failed push, keeps the marker, and retries at the next flush', async () => {
      const state = await started();
      append(ordered('b1'));
      fake.answer = (args) =>
        args[0] === 'push' ? exit(128, 'fatal: unable to access origin\n') : undefined;

      assert.deepEqual(await state.flush(), {
        kind: 'failed',
        reason: 'fatal: unable to access origin',
      });
      assert.equal(store.pushedThrough(), undefined);

      fake.answer = () => undefined;
      append(released);
      assert.deepEqual(await state.flush(), { kind: 'pushed', through: 2, commit: sha(101) });
      assert.equal(read('batches/b1/events.jsonl'), line(1, ordered('b1')));
    });

    it('pushes without committing when nothing changed on disk', async () => {
      const state = await started();
      append(ordered('b1'));
      fake.answer = (args) => (args[0] === 'diff' ? ok() : undefined);
      fake.head = sha(50);
      const result = await state.flush();
      assert.deepEqual(result, { kind: 'pushed', through: 1, commit: sha(50) });
      assert.equal(fake.find('commit'), undefined);
    });

    it('runs one flush at a time', async () => {
      const state = await started();
      append(ordered('b1'));
      const [first, second] = await Promise.all([state.flush(), state.flush()]);
      assert.equal(first.kind, 'pushed');
      assert.deepEqual(second, { kind: 'unchanged' });
      assert.equal(fake.calls.filter((call) => call.args[0] === 'push').length, 1);
    });
  });

  describe('writeOutDoc', () => {
    it('writes the out doc next to the batch log, and the next flush commits it', async () => {
      const state = branch();
      await state.start();
      await state.writeOutDoc({ batchId: 'b1', stepId: 'plan', attempt: 2 }, '# Plan\n');
      assert.equal(read('batches/b1/plan-2.md'), '# Plan\n');
      append(ordered('b1'));
      await state.flush();
      assert.ok(fake.calls.some((call) => call.args[0] === 'add' && call.args.includes('-A')));
    });

    it('refuses an id that is not a path segment', async () => {
      const state = branch();
      await state.start();
      await assert.rejects(
        state.writeOutDoc({ batchId: '..', stepId: 'plan', attempt: 1 }, 'x'),
        /batch id/,
      );
      assert.equal(existsSync(join(dir.path, 'plan-1.md')), false);
    });
  });
});
