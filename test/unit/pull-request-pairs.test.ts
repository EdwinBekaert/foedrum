// The check of the Brewery's open pull requests of one repository against each other (ADR 0230): a
// fake repository answers the merge-tree of two heads and the bottle branches' tips, the command
// log is the real one on a store in memory, and the status comment and the merge brief go to fake
// code hosts (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { BaseCheckRepository, MergeTreeResult } from '../../src/engine/base-check.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { readyOf } from '../../src/engine/merge-brief.ts';
import { type MergeBriefHost, mergeBriefEffects } from '../../src/engine/merge-brief-post.ts';
import { pullRequestKey, pushKey } from '../../src/engine/pull-request.ts';
import { checkPairs } from '../../src/engine/pull-request-pairs.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { type StatusComments, statusEffects } from '../../src/engine/status-comment.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { PushResult } from '../../src/schemas/store.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const now = new Date('2026-10-30T09:00:00.000Z');
const pr = (n: number, repo = 'web'): string => `https://github.com/acme/${repo}/pull/${n}`;
const [a, b, c] = [pr(12), pr(13), pr(14)];
const api = pr(15, 'api');
const [ha, hb, hc, hb2] = ['a', 'b', 'c', 'd'].map((x) => x.repeat(40)) as [
  string,
  string,
  string,
  string,
];
const branchOf = (batchId: string): string => `foedrum/${batchId}/acme.web`;
const recipes = fakeRecipes(
  Object.fromEntries(
    [a, b, c, api].map((url) => [url, fakeRecipe({ steps: ['implement'], pullRequests: [url] })]),
  ),
);
const conflicts = (...files: string[]): MergeTreeResult => ({ kind: 'conflicts', files });
const clean: MergeTreeResult = { kind: 'clean' };

/**
 * A repository whose merge-tree answers by the pair of heads, in either order, and whose bottle
 * branches are at the heads pushed to them until a test moves one.
 */
const fakeRepository = (answers: Record<string, MergeTreeResult | Error>, repo = 'acme/web') => {
  const merges: string[] = [];
  const branches = new Map<string, string | undefined>();
  const repository: BaseCheckRepository = {
    repo,
    base: 'main',
    tip: async () => {
      throw new Error('the pair check reads no tip');
    },
    mergeTree: async (one, two) => {
      const pair = [one, two].map((sha) => sha.slice(0, 1)).join('');
      merges.push(pair);
      const answer = answers[pair] ?? answers[[...pair].reverse().join('')];
      if (answer === undefined) throw new Error(`no answer for ${pair}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    branchTip: async (branch) => (branches.has(branch) ? branches.get(branch) : 'pushed'),
  };
  return { repository, merges, branches };
};

describe('the check of open pull requests against each other (ADR 0230)', () => {
  let store: EventStore;
  let log: CommandLog;
  let failures: string[];
  // The head each batch's latest push recorded, which its bottle branch is at unless moved.
  let heads: Map<string, string>;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
    failures = [];
    heads = new Map();
  });
  afterEach(() => store.close());

  const accept = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = log.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  const record = (event: Event & { batchId: string }) =>
    log.issue({ kind: 'record', event } as Parameters<CommandLog['issue']>[0], now);
  const ledger = (key: Parameters<typeof effectKey.encode>[0], result: unknown): void =>
    accept({
      kind: 'record',
      event: { type: 'effect.applied', key: effectKey.encode(key), result },
    });
  /** Batch `batchId` On tap with the pull request `url`, its push at `head`. */
  const onTap = (batchId: string, url: string, head: string, repo?: string): void => {
    const issue = Number(url.split('/').at(-1));
    accept({ kind: 'order', batchId, order: { issue, ...(repo === undefined ? {} : { repo }) } });
    accept({ kind: 'route', batchId, recipe: url, reason: 'label', source: 'label' });
    const ref = { batchId, stepId: 'implement', attempt: 1 };
    accept({ kind: 'record', event: { type: 'step.started', ...ref } });
    accept({ kind: 'finish', ...ref, ending: { kind: 'succeeded', output: null } });
    push(batchId, head);
    ledger(pullRequestKey(batchId), url);
  };
  /** The push of `round` of `batchId` at `head`. */
  const push = (batchId: string, head: string, round = 1): void => {
    const pushed: PushResult = { branch: branchOf(batchId), commit: head, from: 'start' };
    ledger(pushKey(batchId, round), pushed);
    heads.set(batchId, head);
  };
  const pass = (repositories: BaseCheckRepository[], signal = new AbortController().signal) =>
    checkPairs(
      {
        log,
        repositories: repositories.map((repository) => ({
          ...repository,
          // A branch is at its batch's head unless the test moved it.
          branchTip: async (branch, signal) => {
            const answer = await repository.branchTip(branch, signal);
            if (answer !== 'pushed') return answer;
            const batchId = branch.split('/')[1] ?? '';
            return heads.get(batchId);
          },
        })),
        clock: () => now,
        failed: (what) => failures.push(what),
      },
      signal,
    );
  const pairs = (batchId: string) => log.state().batches.get(batchId)?.pairChecks;
  const pairEvents = () =>
    store
      .eventsAfter(0)
      .flatMap(({ event }) => (event.type === 'pull_request.pair_checked' ? [event] : []));

  describe('the pass', () => {
    it('records a conflicting pair once per pair of heads, on both batches', async () => {
      onTap('web-12', a, ha);
      onTap('web-13', b, hb);
      const { repository, merges } = fakeRepository({ ab: conflicts('src/app.ts', 'README.md') });
      await pass([repository]);
      await pass([repository]);
      assert.deepStrictEqual(merges, ['ab']);
      assert.deepStrictEqual(failures, []);
      assert.deepStrictEqual(pairs('web-12'), {
        [b]: { pullRequest: a, head: ha, otherHead: hb, conflicts: ['src/app.ts', 'README.md'] },
      });
      assert.deepStrictEqual(pairs('web-13'), {
        [a]: { pullRequest: b, head: hb, otherHead: ha, conflicts: ['src/app.ts', 'README.md'] },
      });
    });

    it('records a clean pair clean, and keeps at most MAX_CONFLICTS files', async () => {
      onTap('web-12', a, ha);
      onTap('web-13', b, hb);
      onTap('web-14', c, hc);
      const many = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
      const { repository, merges } = fakeRepository({
        ab: clean,
        ac: conflicts(...many),
        bc: clean,
      });
      await pass([repository]);
      assert.deepStrictEqual([...merges].sort(), ['ab', 'ac', 'bc']);
      assert.deepStrictEqual(pairs('web-13'), {
        [a]: { pullRequest: b, head: hb, otherHead: ha },
        [c]: { pullRequest: b, head: hb, otherHead: hc },
      });
      assert.equal(pairs('web-14')?.[a]?.conflicts?.length, 50);
      assert.equal(pairEvents().length, 6);
    });

    it('checks a pair again once either head changes, and keeps the latest record', async () => {
      onTap('web-12', a, ha);
      onTap('web-13', b, hb);
      onTap('web-14', c, hc);
      const { repository, merges } = fakeRepository({
        ab: conflicts('x.ts'),
        ac: clean,
        bc: clean,
        ad: clean,
        dc: conflicts('y.ts'),
      });
      await pass([repository]);
      push('web-13', hb2, 2);
      merges.length = 0;
      await pass([repository]);
      assert.deepStrictEqual([...merges].sort(), ['ad', 'dc']);
      assert.deepStrictEqual(pairs('web-12')?.[b], { pullRequest: a, head: ha, otherHead: hb2 });
      assert.deepStrictEqual(pairs('web-14')?.[b], {
        pullRequest: c,
        head: hc,
        otherHead: hb2,
        conflicts: ['y.ts'],
      });
    });

    it('pairs no pull request whose branch moved, that ended, or of another repository', async () => {
      onTap('web-12', a, ha, 'acme/web');
      onTap('web-13', b, hb, 'acme/web');
      onTap('web-14', c, hc, 'acme/web');
      onTap('api-15', api, hb2, 'acme/api');
      const web = fakeRepository({});
      const other = fakeRepository({}, 'acme/api');
      // Someone else pushed to 13's branch, and 14's pull request was merged.
      web.branches.set(branchOf('web-13'), 'e'.repeat(40));
      accept({
        kind: 'record',
        event: { type: 'pull_request.ended', batchId: 'web-14', pullRequest: c, state: 'merged' },
      });
      await pass([web.repository, other.repository]);
      assert.deepStrictEqual([...web.merges, ...other.merges], []);
      // A branch gone, as a closing pull request's is, pairs nothing either.
      web.branches.set(branchOf('web-13'), undefined);
      await pass([web.repository, other.repository]);
      assert.deepStrictEqual(pairEvents(), []);
      assert.deepStrictEqual(failures, []);
    });

    it('pairs no pull request whose base check found its branch moved (ADR 0198)', async () => {
      onTap('web-12', a, ha);
      onTap('web-13', b, hb);
      accept({
        kind: 'record',
        event: {
          type: 'pull_request.base_checked',
          batchId: 'web-13',
          pullRequest: b,
          branch: 'main',
          tip: 'f'.repeat(40),
          head: hb,
          branchMoved: 'e'.repeat(40),
        },
      });
      const { repository, merges } = fakeRepository({ ab: clean });
      await pass([repository]);
      assert.deepStrictEqual(merges, []);
    });

    it('records nothing for a merge-tree that fails, reports it, and tries again', async () => {
      onTap('web-12', a, ha);
      onTap('web-13', b, hb);
      const answers: Record<string, MergeTreeResult | Error> = { ab: new Error('git died') };
      const { repository, merges } = fakeRepository(answers);
      await pass([repository]);
      assert.deepStrictEqual(pairEvents(), []);
      assert.equal(failures.length, 1);
      assert.match(failures[0] ?? '', new RegExp(`${a}.*${b}`));
      answers.ab = clean;
      await pass([repository]);
      assert.deepStrictEqual(merges, ['ab', 'ab']);
      assert.equal(pairEvents().length, 2);
    });

    it('records only the side a killed pass left out, and refuses a pair of heads twice', async () => {
      onTap('web-12', a, ha);
      onTap('web-13', b, hb);
      const side = {
        type: 'pull_request.pair_checked',
        batchId: 'web-12',
        pullRequest: a,
        head: ha,
        other: b,
        otherHead: hb,
      } as const;
      assert.equal(record(side).kind, 'accepted');
      assert.equal(record(side).kind, 'refused');
      const { repository, merges } = fakeRepository({ ab: clean });
      await pass([repository]);
      assert.deepStrictEqual(merges, ['ab']);
      assert.deepStrictEqual(
        pairEvents().map(({ batchId }) => batchId),
        ['web-12', 'web-13'],
      );
      // Only the side left out was issued: a side issued again would be refused and reported.
      assert.deepStrictEqual(failures, []);
      // A record of a pull request that is not the batch's open one is refused.
      assert.equal(record({ ...side, batchId: 'web-13', pullRequest: a }).kind, 'refused');
    });

    it('regression test: records nothing for a head pushed while its pair was merged (ADR 0044)', async () => {
      onTap('web-12', a, ha);
      onTap('web-13', b, hb);
      const { repository, merges } = fakeRepository({ ab: clean });
      const pushing: BaseCheckRepository = {
        ...repository,
        mergeTree: async (one, two, signal) => {
          push('web-13', hb2, 2);
          return repository.mergeTree(one, two, signal);
        },
      };
      await pass([pushing]);
      assert.deepStrictEqual(merges, ['ab']);
      assert.deepStrictEqual(pairEvents(), []);
    });

    it('regression test: records nothing once the pass is given up during a merge-tree', async () => {
      onTap('web-12', a, ha);
      onTap('web-13', b, hb);
      onTap('web-14', c, hc);
      const { repository, merges } = fakeRepository({ ab: clean, ac: clean, bc: clean });
      const stop = new AbortController();
      const stopping: BaseCheckRepository = {
        ...repository,
        mergeTree: async (one, two, signal) => {
          stop.abort();
          return repository.mergeTree(one, two, signal);
        },
      };
      await pass([stopping], stop.signal);
      assert.deepStrictEqual(merges, ['ab']);
      assert.deepStrictEqual(pairEvents(), []);
    });
  });

  describe('where it shows', () => {
    const conflicted = {
      type: 'pull_request.pair_checked',
      batchId: 'web-12',
      pullRequest: a,
      head: ha,
      other: b,
      otherHead: hb,
      conflicts: ['src/app.ts', 'README.md'],
    } as const;
    /** The pass's two records of 12 and 13: conflicting by default. */
    const paired = (files?: string[]): void => {
      const found = files === undefined ? {} : { conflicts: files };
      const { conflicts: _, ...side } = conflicted;
      assert.equal(record({ ...side, ...found }).kind, 'accepted');
      const flipped = {
        ...side,
        batchId: 'web-13',
        pullRequest: b,
        head: hb,
        other: a,
        otherHead: ha,
      };
      assert.equal(record({ ...flipped, ...found }).kind, 'accepted');
    };
    const finished = (batchId: string, url: string, head: string): void =>
      accept({
        kind: 'record',
        event: {
          type: 'pull_request.checks_finished',
          batchId,
          pullRequest: url,
          head,
          checks: [{ name: 'ci/build', kind: 'check_run', conclusion: 'success' }],
        },
      });
    const statusText = async (batchId: string): Promise<string> => {
      const bodies: string[] = [];
      const comments: StatusComments = {
        find: async () => undefined,
        read: async () => undefined,
        create: async (_repo, _issue, body) => {
          bodies.push(body);
          return 1;
        },
        edit: async () => 'gone',
      };
      const effects = statusEffects({
        brewery: 'acme/brewery',
        comments,
        recipes,
        clock: () => now,
      });
      const [key] = effects.due(log.state(), batchId);
      assert.ok(key);
      await effects.target.apply(effectKey.encode(key));
      return bodies[0] ?? '';
    };
    const brief = async (batchId: string): Promise<string> => {
      const bodies: string[] = [];
      const host: MergeBriefHost = {
        find: async () => undefined,
        create: async (_repo, _number, body) => {
          bodies.push(body);
          return 101;
        },
        title: async () => 'A change',
        hidden: async () => 'shown',
        hide: async () => 'hidden',
      };
      const effects = mergeBriefEffects({ host, recipes, redProof: () => undefined });
      const [key] = effects.due(log.state(), batchId);
      assert.ok(key);
      await effects.target.apply(effectKey.encode(key));
      return bodies[0] ?? '';
    };

    it('names the other pull request and the files on both status comments', async () => {
      onTap('web-12', a, ha);
      onTap('web-13', b, hb);
      paired(['src/app.ts', 'README.md']);
      assert.ok(
        (await statusText('web-12')).includes(
          `- <${a}> conflicts with the open pull request <${b}> in src/app.ts, README.md`,
        ),
      );
      assert.ok(
        (await statusText('web-13')).includes(
          `- <${b}> conflicts with the open pull request <${a}> in src/app.ts, README.md`,
        ),
      );
    });

    it('says nothing more of a pair once the other ended or pushed another head', async () => {
      onTap('web-12', a, ha);
      onTap('web-13', b, hb);
      onTap('web-14', c, hc);
      paired(['src/app.ts']);
      assert.equal(
        record({ ...conflicted, other: c, otherHead: hc, conflicts: ['lib.ts'] }).kind,
        'accepted',
      );
      const before = await statusText('web-12');
      assert.ok(before.includes(`conflicts with the open pull request <${b}> in src/app.ts`));
      assert.ok(before.includes(`conflicts with the open pull request <${c}> in lib.ts`));
      push('web-13', hb2, 2);
      accept({
        kind: 'record',
        event: { type: 'pull_request.ended', batchId: 'web-14', pullRequest: c, state: 'closed' },
      });
      assert.doesNotMatch(await statusText('web-12'), /conflicts with the open pull request/);
    });

    it("names each conflicting pull request in the brief's evidence, and holds no Ready", async () => {
      onTap('web-12', a, ha);
      onTap('web-13', b, hb);
      paired(['src/app.ts', 'README.md']);
      finished('web-12', a, ha);
      const state = log.state();
      const batch = state.batches.get('web-12');
      assert.ok(batch);
      assert.equal(readyOf(state, batch)?.head, ha);
      const body = await brief('web-12');
      assert.match(body, /\*\*Ready to merge\.\*\*/);
      assert.ok(
        body.includes(`- Conflicts with the open pull request <${b}> in src/app.ts, README.md.`),
        body,
      );
      assert.doesNotMatch(body, /Merges cleanly with the other open pull requests/);
    });

    it('says the brief merges cleanly with the others only once every pair was checked clean', async () => {
      onTap('web-12', a, ha);
      onTap('web-13', b, hb);
      onTap('web-14', c, hc);
      paired();
      finished('web-12', a, ha);
      // 12 and 14 are not checked yet: the brief claims nothing.
      assert.doesNotMatch(await brief('web-12'), /other open pull requests|open pull request </);
      const { conflicts: _, ...side } = conflicted;
      assert.equal(record({ ...side, other: c, otherHead: hc }).kind, 'accepted');
      assert.ok(
        (await brief('web-12')).includes('- Merges cleanly with the other open pull requests.'),
      );
    });

    it("names a claimed issue's pull request beside a Brewery issue's in a one-repository Brewery", async () => {
      // A Brewery issue's batch names no repository: it writes in the Brewery's only one, as the
      // pass grouped it with the claimed batch of that repository.
      onTap('web-12', a, ha);
      onTap('web-13', b, hb, 'acme/web');
      paired(['src/app.ts']);
      finished('web-12', a, ha);
      assert.ok(
        (await brief('web-12')).includes(
          `- Conflicts with the open pull request <${b}> in src/app.ts.`,
        ),
      );
      assert.ok(
        (await statusText('web-12')).includes(
          `- <${a}> conflicts with the open pull request <${b}> in src/app.ts`,
        ),
      );
    });

    it('regression test: says the brief merges cleanly when only another repository has an open pull request left', async () => {
      onTap('web-12', a, ha, 'acme/web');
      onTap('web-13', b, hb, 'acme/web');
      onTap('api-15', api, hc, 'acme/api');
      paired();
      finished('web-12', a, ha);
      assert.ok(
        (await brief('web-12')).includes('- Merges cleanly with the other open pull requests.'),
      );
    });
  });
});
