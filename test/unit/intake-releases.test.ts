// The intake records the releases a `release` blocker waits on (ADR 0223): each pass reads the
// latest release of every repository with a merged blocker not yet released, and records it once it
// holds a merge of every blocker waiting on it, so the sub-order it blocks starts in that pass.
// Recorded `order.decomposed` and `pull_request.ended` events and a fake reader, no network
// (ADR 0021): nothing produces sub-orders until mash (#388).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import {
  createIntake,
  type IntakeNotice,
  type IntakeOptions,
  type TargetTracker,
} from '../../src/engine/intake.ts';
import type { TargetIssue } from '../../src/engine/issue-claims.ts';
import type { LatestRelease, ReleaseReader } from '../../src/engine/releases.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import type { Event } from '../../src/schemas/events.ts';
import { fakeGitHub } from '../helpers/fake-github.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const brewery = 'alice/brewery';
const lib = 'acme/lib-core';
const web = 'acme/web';
const now = new Date('2026-10-26T12:00:00.000Z');
const routeBy = '2026-10-26T13:00:00.000Z';
const recipes = fakeRecipes({ half: fakeRecipe({ steps: ['plan'] }) });
const pr = (n: number): string => `https://github.com/acme/lib-core/pull/${n}`;
const v1: LatestRelease = { version: 'v1.0.0', published: '2026-10-26T11:00:00.000Z' };
const v2: LatestRelease = { version: 'v2.0.0', published: '2026-10-26T11:30:00.000Z' };

const ordered = (batchId: string, issue: number, parentBatchId?: string): Event => ({
  type: 'batch.ordered',
  batchId,
  order: { issue },
  ...(parentBatchId === undefined ? {} : { parentBatchId }),
  routeBy,
});
const onTap = (batchId: string, ...pullRequests: string[]): Event => ({
  type: 'batch.on_tap',
  batchId,
  pullRequests,
});
const ended = (batchId: string, pullRequest: string, state: 'merged' | 'closed'): Event => ({
  type: 'pull_request.ended',
  batchId,
  pullRequest,
  state,
});
/**
 * Order #1, decomposed into `subOrders` ([issue, repository]) with `blocks` ([sub-order, blocked
 * by, kind]), its batch On tap so it holds no slot.
 */
const decomposed = (
  subOrders: readonly (readonly [number, string])[],
  blocks: readonly [number, number, 'code' | 'release'][],
): Event[] => [
  ordered('1-1', 1),
  {
    type: 'order.decomposed',
    batchId: '1-1',
    subOrders: subOrders.map(([issue, repo]) => ({ issue, repo })),
    dependencies: blocks.map(([subOrder, blockedBy, kind]) => ({ subOrder, blockedBy, kind })),
  },
  onTap('1-1'),
];
/** #3 waits for a release of #2's repository, `acme/lib-core`; #2's pull request merged. */
const waiting: Event[] = [
  ...decomposed(
    [
      [2, lib],
      [3, web],
    ],
    [[3, 2, 'release']],
  ),
  ordered('2-1', 2, '1-1'),
  onTap('2-1', pr(5)),
  ended('2-1', pr(5), 'merged'),
];

const issue = (number: number): TargetIssue => ({
  number,
  state: 'open',
  pullRequest: false,
  labels: ['recipe:half'],
  milestone: undefined,
  assignees: [],
  author: 'alice',
  created: new Date(Date.UTC(2026, 9, 26, 10, number)).toISOString(),
});
const tracker: TargetTracker = {
  issues: async (repo) => (repo === brewery ? [1, 2, 3, 4, 5].map(issue) : []),
  pullRequest: async () => 'open',
};

/**
 * A reader with the latest release of each repository (an Error fails the read) and the pull
 * requests each version holds, recording what it was asked.
 */
const fakeReader = (
  latest: Record<string, LatestRelease | Error | undefined>,
  holds: Record<string, readonly string[]> = {},
) => {
  const asked: string[] = [];
  const reader: ReleaseReader = {
    latest: async (repo) => {
      asked.push(`latest ${repo}`);
      const found = latest[repo];
      if (found instanceof Error) throw found;
      return found;
    },
    holds: async (repo, release, pullRequest) => {
      asked.push(`holds ${repo} ${release.version} ${pullRequest}`);
      return (holds[release.version] ?? []).includes(pullRequest);
    },
  };
  return { reader, asked, latest, holds };
};

describe('the intake records the releases a release blocker waits on (ADR 0223)', () => {
  let store: EventStore;
  let log: CommandLog;
  let notices: IntakeNotice[];

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    notices = [];
  });
  afterEach(() => store.close());

  const recorded = (...events: Event[]): void => {
    store.withTransaction((tx) => {
      for (const event of events) tx.append(event);
    });
    log = createCommandLog({ store, recipes });
  };
  const poll = (releases: ReleaseReader, options: Partial<IntakeOptions> = {}) =>
    createIntake({
      log,
      brewery,
      tracker,
      claims: fakeGitHub().host,
      claimant: { brewery, login: 'alice' },
      authors: ['alice'],
      repositories: [],
      capacity: 5,
      clock: () => now,
      report: (notice) => notices.push(notice),
      releases,
      ...options,
    }).poll();
  const releases = () =>
    log.state().releases.map(({ repo, package: name, version }) => `${repo} ${name} ${version}`);
  const started = () => (log.state().subOrders.get(3)?.batchIds.length ?? 0) > 0;

  it('records a release that holds the merge once, and orders the sub-order in that pass', async () => {
    recorded(...waiting);
    const { reader, asked } = fakeReader({ [lib]: v1 }, { [v1.version]: [pr(5)] });
    await poll(reader);
    assert.deepStrictEqual(releases(), [`${lib} lib-core v1.0.0`]);
    assert.ok(started());
    assert.deepStrictEqual(asked, [`latest ${lib}`, `holds ${lib} v1.0.0 ${pr(5)}`]);
    assert.deepStrictEqual(
      notices.filter(({ kind }) => kind === 'released'),
      [{ kind: 'released', repo: lib, version: 'v1.0.0' }],
    );
    // Nothing waits any more: the next pass reads nothing and records nothing.
    asked.length = 0;
    await poll(reader);
    assert.deepStrictEqual(asked, []);
    assert.deepStrictEqual(releases(), [`${lib} lib-core v1.0.0`]);
  });

  it('asks whether a tag holds the merge with the tag as the reader gave it (review of #578)', async () => {
    recorded(...waiting);
    const given: LatestRelease[] = [];
    const tag: LatestRelease = { ...v1, tag: true };
    const reader: ReleaseReader = {
      latest: async () => tag,
      holds: async (_repo, release) => {
        given.push(release);
        return true;
      },
    };
    await poll(reader);
    assert.deepStrictEqual(given, [tag]);
    assert.deepStrictEqual(releases(), [`${lib} lib-core v1.0.0`]);
  });

  it('records the repository as the breakdown spells it', async () => {
    recorded(
      ...decomposed(
        [
          [2, 'Acme/Lib-Core'],
          [3, web],
        ],
        [[3, 2, 'release']],
      ),
      ordered('2-1', 2, '1-1'),
      onTap('2-1', pr(5)),
      ended('2-1', pr(5), 'merged'),
    );
    const { reader, asked } = fakeReader({ 'Acme/Lib-Core': v1 }, { [v1.version]: [pr(5)] });
    await poll(reader);
    assert.deepStrictEqual(releases(), ['Acme/Lib-Core Lib-Core v1.0.0']);
    assert.deepStrictEqual(asked[0], 'latest Acme/Lib-Core');
    assert.ok(started());
  });

  it('records nothing while the latest release does not hold the merge, then a later one that does', async () => {
    recorded(...waiting);
    const { reader, asked, latest } = fakeReader({ [lib]: v1 }, { [v2.version]: [pr(5)] });
    await poll(reader);
    assert.deepStrictEqual(releases(), []);
    assert.ok(!started());
    // Each pass reads it again, and still records nothing.
    await poll(reader);
    assert.deepStrictEqual(asked, [
      `latest ${lib}`,
      `holds ${lib} v1.0.0 ${pr(5)}`,
      `latest ${lib}`,
      `holds ${lib} v1.0.0 ${pr(5)}`,
    ]);
    latest[lib] = v2;
    await poll(reader);
    assert.deepStrictEqual(releases(), [`${lib} lib-core v2.0.0`]);
    assert.ok(started());
  });

  it('records nothing for a repository with no release', async () => {
    recorded(...waiting);
    const { reader, asked } = fakeReader({ [lib]: undefined });
    await poll(reader);
    assert.deepStrictEqual(releases(), []);
    assert.deepStrictEqual(asked, [`latest ${lib}`]);
    assert.ok(!started());
  });

  it('reads no further a version already recorded for the repository, in any case', async () => {
    recorded(
      ...decomposed(
        [
          [2, lib],
          [3, web],
        ],
        [[3, 2, 'release']],
      ),
      ordered('2-1', 2, '1-1'),
      onTap('2-1', pr(5)),
      // Recorded before the merge: it does not count, and the next one is needed.
      { type: 'release.observed', repo: 'Acme/Lib-Core', package: 'lib-core', version: 'v1.0.0' },
      ended('2-1', pr(5), 'merged'),
    );
    const { reader, asked } = fakeReader({ [lib]: v1 }, { [v1.version]: [pr(5)] });
    await poll(reader);
    assert.deepStrictEqual(asked, [`latest ${lib}`]);
    assert.equal(log.state().releases.length, 1);
    assert.ok(!started());
  });

  it('records a release only once it holds a merge of every blocker waiting on its repository', async () => {
    recorded(
      ...decomposed(
        [
          [2, lib],
          [4, lib],
          [3, web],
          [5, web],
        ],
        [
          [3, 2, 'release'],
          [5, 4, 'release'],
        ],
      ),
      ordered('2-1', 2, '1-1'),
      onTap('2-1', pr(5)),
      ended('2-1', pr(5), 'merged'),
      ordered('4-1', 4, '1-1'),
      onTap('4-1', pr(8)),
      ended('4-1', pr(8), 'merged'),
    );
    const { reader, latest } = fakeReader(
      { [lib]: v1 },
      { [v1.version]: [pr(5)], [v2.version]: [pr(5), pr(8)] },
    );
    await poll(reader);
    // v1 holds #2's merge but not #4's: recorded, it would start #5 without #4's change.
    assert.deepStrictEqual(releases(), []);
    latest[lib] = v2;
    await poll(reader);
    assert.deepStrictEqual(releases(), [`${lib} lib-core v2.0.0`]);
    assert.ok(started());
    assert.ok((log.state().subOrders.get(5)?.batchIds.length ?? 0) > 0);
  });

  it("records a release that holds one of a blocker's merged pull requests (review of #578)", async () => {
    recorded(
      ...waiting,
      ordered('2-2', 2, '1-1'),
      onTap('2-2', pr(6)),
      ended('2-2', pr(6), 'merged'),
    );
    // It holds the first merge of #2, not the second.
    const { reader, asked } = fakeReader({ [lib]: v1 }, { [v1.version]: [pr(5)] });
    await poll(reader);
    assert.deepStrictEqual(releases(), [`${lib} lib-core v1.0.0`]);
    assert.deepStrictEqual(asked, [`latest ${lib}`, `holds ${lib} v1.0.0 ${pr(5)}`]);
    assert.ok(started());
  });

  it('reports a record the admission refuses, since another writer recorded it first (review of #578)', async () => {
    recorded(...waiting);
    const reader: ReleaseReader = {
      latest: async () => v1,
      holds: async () => {
        // Another driver records the same release while this pass reads.
        store.withTransaction((tx) => {
          tx.append({
            type: 'release.observed',
            repo: lib,
            package: 'lib-core',
            version: 'v1.0.0',
          });
        });
        return true;
      },
    };
    await poll(reader);
    assert.deepStrictEqual(releases(), [`${lib} lib-core v1.0.0`]);
    assert.deepStrictEqual(
      notices.filter(({ kind }) => kind === 'released'),
      [],
    );
    const failed = notices.find(({ kind }) => kind === 'failed');
    assert.equal(
      failed?.kind === 'failed' ? failed.what : '',
      `recording the release v1.0.0 of ${lib}`,
    );
  });

  it('reads nothing without a release blocker, nor for one not merged, closed, or of a cancelled order', async () => {
    const code = decomposed(
      [
        [2, lib],
        [3, web],
      ],
      [[3, 2, 'code']],
    );
    const blocked = [
      ...decomposed(
        [
          [2, lib],
          [3, web],
        ],
        [[3, 2, 'release']],
      ),
      ordered('2-1', 2, '1-1'),
      onTap('2-1', pr(5)),
    ];
    const cases: Event[][] = [
      [ordered('1-1', 1)],
      [...code, ordered('2-1', 2, '1-1'), onTap('2-1', pr(5)), ended('2-1', pr(5), 'merged')],
      blocked,
      [...blocked, ended('2-1', pr(5), 'closed')],
      [...waiting, { type: 'batch.cancelled', batchId: '1-1', by: 'ada', via: 'terminal' }],
    ];
    for (const events of cases) {
      store.close();
      store = openSqliteEventStore(':memory:');
      recorded(...events);
      const { reader, asked } = fakeReader({ [lib]: v1 }, { [v1.version]: [pr(5)] });
      await poll(reader);
      assert.deepStrictEqual(asked, [], JSON.stringify(events.at(-1)));
    }
  });

  it('records the release of a paused order, and under pause --all, without ordering', async () => {
    const paused: Event = { type: 'order.paused', order: { issue: 1 }, by: 'ada', via: 'terminal' };
    recorded(...waiting, paused);
    const { reader } = fakeReader({ [lib]: v1 }, { [v1.version]: [pr(5)] });
    await poll(reader);
    assert.deepStrictEqual(releases(), [`${lib} lib-core v1.0.0`]);
    assert.ok(!started());

    store.close();
    store = openSqliteEventStore(':memory:');
    recorded(...waiting, { type: 'order.paused', by: 'ada', via: 'terminal' });
    await poll(reader);
    assert.deepStrictEqual(releases(), [`${lib} lib-core v1.0.0`]);
    assert.ok(!started());
  });

  it('reports a read that fails, reads the next repository, and records it on the next pass', async () => {
    recorded(
      ...decomposed(
        [
          [2, lib],
          [4, web],
          [3, web],
          [5, web],
        ],
        [
          [3, 2, 'release'],
          [5, 4, 'release'],
        ],
      ),
      ordered('2-1', 2, '1-1'),
      onTap('2-1', pr(5)),
      ended('2-1', pr(5), 'merged'),
      ordered('4-1', 4, '1-1'),
      onTap('4-1', pr(8)),
      ended('4-1', pr(8), 'merged'),
    );
    const { reader, latest } = fakeReader(
      { [lib]: new Error('GitHub answered 502'), [web]: v1 },
      { [v1.version]: [pr(5), pr(8)] },
    );
    await poll(reader);
    assert.deepStrictEqual(releases(), [`${web} web v1.0.0`]);
    const failed = notices.find(({ kind }) => kind === 'failed');
    assert.equal(
      failed?.kind === 'failed' ? failed.what : '',
      `reading the latest release of ${lib}`,
    );
    latest[lib] = v1;
    await poll(reader);
    assert.deepStrictEqual(releases(), [`${web} web v1.0.0`, `${lib} lib-core v1.0.0`]);
    assert.ok(started());
  });

  it('records nothing once the pass is past its deadline', async () => {
    recorded(...waiting);
    let answer = (): void => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let read = (): void => {};
    const done = new Promise<void>((resolve) => {
      read = resolve;
    });
    let asked = false;
    const reader: ReleaseReader = {
      latest: async () => {
        asked = true;
        await answered;
        read();
        return v1;
      },
      holds: async () => true,
    };
    await poll(reader, { deadlineMs: 1 });
    // The pass was given up while it read: never wait for a read it did not make.
    assert.ok(asked, 'the pass read the latest release');
    answer();
    await done;
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(releases(), []);
  });
});
