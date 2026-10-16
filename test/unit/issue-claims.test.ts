import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import { applyEffect, type Ledger } from '../../src/engine/effects.ts';
import type { Lane } from '../../src/engine/fold.ts';
import {
  type CandidateOptions,
  type Claimant,
  type ClaimedBatch,
  claimCandidates,
  claimEffectsDue,
  claimIssue,
  claimLabel,
  claimRef,
  isCandidate,
  type PullRequestState,
  releaseClaim,
  type TargetIssue,
} from '../../src/engine/issue-claims.ts';
import type { EffectKey } from '../../src/schemas/store.ts';
import { fakeGitHub } from '../helpers/fake-github.ts';

const repo = 'acme/app';
const now = '2026-10-16T09:00:00.000Z';
const alice: Claimant = { brewery: 'alice/brewery', login: 'alice' };
const bob: Claimant = { brewery: 'bob/brewery', login: 'bob' };

const issue = (number: number, fields: Partial<TargetIssue> = {}): TargetIssue => ({
  number,
  state: 'open',
  pullRequest: false,
  labels: ['foedrum'],
  milestone: undefined,
  assignees: [],
  author: 'alice',
  ...fields,
});
const options = (claimant: Claimant, fields: Partial<CandidateOptions> = {}): CandidateOptions => ({
  filter: { labels: ['foedrum'] },
  claimant,
  brewed: new Set(),
  authors: ['alice', 'bob'],
  ...fields,
});
const record = (brewery: string, number = 7): string =>
  JSON.stringify({ brewery, issue: number, claimedAt: now });

describe('claimLabel', () => {
  it('is foedrum:claimed, apart from the lane labels such as foedrum:brewing', () => {
    assert.equal(claimLabel, 'foedrum:claimed');
  });
});

describe('claimRef', () => {
  it('is refs/foedrum/claims/issues/<number>', () => {
    assert.equal(claimRef(7), 'refs/foedrum/claims/issues/7');
  });

  it('refuses a number that is not a positive integer', () => {
    for (const number of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => claimRef(number), /issue/i, String(number));
    }
  });
});

describe('isCandidate', () => {
  it('takes an open, unassigned issue with the filter labels that has no batch here', () => {
    assert.equal(isCandidate(issue(7), options(alice)), true);
  });

  const skipped: [string, TargetIssue, CandidateOptions][] = [
    ['a closed issue', issue(7, { state: 'closed' }), options(alice)],
    ['a pull request', issue(7, { pullRequest: true }), options(alice)],
    ['an issue without a filter label', issue(7, { labels: ['bug'] }), options(alice)],
    [
      'an issue with only some of the filter labels',
      issue(7, { labels: ['foedrum'] }),
      options(alice, { filter: { labels: ['foedrum', 'backend'] } }),
    ],
    [
      'an issue of another milestone',
      issue(7, { milestone: 'M2' }),
      options(alice, { filter: { labels: ['foedrum'], milestone: 'M1' } }),
    ],
    [
      'an issue without the milestone',
      issue(7),
      options(alice, { filter: { labels: ['foedrum'], milestone: 'M1' } }),
    ],
    ['an issue assigned to someone else', issue(7, { assignees: ['bob'] }), options(alice)],
    [
      'an issue assigned to this Brewery and someone else',
      issue(7, { assignees: ['alice', 'bob'] }),
      options(alice),
    ],
    ['an issue this Brewery has a batch of', issue(7), options(alice, { brewed: new Set([7]) })],
    // Before ADR 0043 only the Brewery's owner could order work; a target repository is open to more.
    [
      'an issue opened by someone not allow-listed',
      issue(7, { author: 'mallory' }),
      options(alice),
    ],
    ['an issue of a Brewery with no allow-listed users', issue(7), options(alice, { authors: [] })],
  ];
  for (const [what, target, given] of skipped) {
    it(`skips ${what}`, () => assert.equal(isCandidate(target, given), false));
  }

  it("takes an issue assigned to this Brewery's own user, whatever the case of the login", () => {
    assert.equal(isCandidate(issue(7, { assignees: ['Alice'] }), options(alice)), true);
  });

  it('takes an issue of an allow-listed author, whatever the case of the login', () => {
    const given = options(alice, { authors: ['alice'] });
    assert.equal(isCandidate(issue(7, { author: 'ALICE' }), given), true);
  });

  it('compares labels ignoring case, as GitHub does, and takes an issue of the milestone', () => {
    const given = options(alice, { filter: { labels: ['Foedrum'], milestone: 'M1' } });
    assert.equal(
      isCandidate(issue(7, { labels: ['bug', 'FOEDRUM'], milestone: 'M1' }), given),
      true,
    );
  });
});

describe('claimIssue', () => {
  const claim = (brewery: string) => ({ repo, issue: 7, brewery, now });

  it('wins when it creates the ref, whose record names the Brewery and nothing else', async () => {
    const github = fakeGitHub();
    assert.deepEqual(await claimIssue(github.host, claim(alice.brewery)), { kind: 'won' });
    const message = github.refs.get(`${repo}#7`);
    assert.deepEqual(JSON.parse(message ?? ''), {
      brewery: 'alice/brewery',
      issue: 7,
      claimedAt: now,
    });
  });

  it('finds its own claim, which a run that was killed before ordering left', async () => {
    const github = fakeGitHub();
    github.setRef(repo, 7, record(alice.brewery));
    assert.deepEqual(await claimIssue(github.host, claim(alice.brewery)), { kind: 'ours' });
  });

  it('finds its own claim in a record that spells the Brewery in another case', async () => {
    const github = fakeGitHub();
    github.setRef(repo, 7, record('Alice/Brewery'));
    assert.deepEqual(await claimIssue(github.host, claim(alice.brewery)), { kind: 'ours' });
  });

  it('is taken by the Brewery the record names', async () => {
    const github = fakeGitHub();
    github.setRef(repo, 7, record(bob.brewery));
    assert.deepEqual(await claimIssue(github.host, claim(alice.brewery)), {
      kind: 'taken',
      by: 'bob/brewery',
    });
    assert.equal(github.refs.get(`${repo}#7`), record(bob.brewery));
  });

  const unreadable: [string, string][] = [
    ['text that is not JSON', 'claimed by alice'],
    ['a record of another issue', record(alice.brewery, 8)],
    ['a record with another field', JSON.stringify({ ...JSON.parse(record('x/y')), host: 'pc' })],
    ['a record without a time', JSON.stringify({ brewery: 'alice/brewery', issue: 7 })],
  ];
  for (const [what, message] of unreadable) {
    it(`is taken by someone unknown, never this Brewery, for ${what}`, async () => {
      const github = fakeGitHub();
      github.setRef(repo, 7, message);
      assert.deepEqual(await claimIssue(github.host, claim(alice.brewery)), {
        kind: 'taken',
        by: undefined,
      });
    });
  }

  it('is taken for now when the ref is gone between creating and reading it', async () => {
    const github = fakeGitHub({ vanishOnRead: true });
    github.setRef(repo, 7, record(bob.brewery));
    assert.deepEqual(await claimIssue(github.host, claim(alice.brewery)), {
      kind: 'taken',
      by: undefined,
    });
  });

  it('lets exactly one of two Breweries that claim at the same time win', async () => {
    for (const first of [alice, bob]) {
      const github = fakeGitHub();
      const second = first === alice ? bob : alice;
      const [one, other] = await Promise.all([
        claimIssue(github.host, claim(first.brewery)),
        claimIssue(github.host, claim(second.brewery)),
      ]);
      assert.deepEqual(one, { kind: 'won' });
      assert.deepEqual(other, { kind: 'taken', by: first.brewery });
      assert.equal(github.calls.get('create'), 2);
    }
  });
});

describe('claimCandidates', () => {
  const pass = (claimant: Claimant, given: Partial<CandidateOptions> = {}, limit = 10) => ({
    ...options(claimant, given),
    repo,
    now,
    limit,
  });

  it('lets one of two Breweries order an issue both pick, and the other skip it', async () => {
    const github = fakeGitHub();
    const issues = [issue(7)];
    const [ofAlice, ofBob] = await Promise.all([
      claimCandidates(github.host, issues, pass(alice)),
      claimCandidates(github.host, issues, pass(bob)),
    ]);
    assert.deepEqual(ofAlice, { order: [7], taken: [] });
    assert.deepEqual(ofBob, { order: [], taken: [{ issue: 7, by: 'alice/brewery' }] });
    assert.deepEqual(await claimCandidates(github.host, issues, pass(bob)), ofBob);
  });

  it('orders an issue once when the listing has it twice', async () => {
    // Pages of a listing shift while it is read, so one issue can come back on two of them.
    const github = fakeGitHub();
    assert.deepEqual(await claimCandidates(github.host, [issue(7), issue(7)], pass(alice)), {
      order: [7],
      taken: [],
    });
  });

  it('claims only candidates, oldest issue first', async () => {
    const github = fakeGitHub();
    const issues = [
      issue(9),
      issue(8, { assignees: ['bob'] }),
      issue(3),
      issue(5, { state: 'closed' }),
    ];
    assert.deepEqual(await claimCandidates(github.host, issues, pass(alice)), {
      order: [3, 9],
      taken: [],
    });
    assert.deepEqual([...github.refs.keys()].sort(), [`${repo}#3`, `${repo}#9`]);
  });

  it('claims oldest first only up to the limit, leaving the rest for the next pass', async () => {
    const github = fakeGitHub();
    const issues = [issue(9), issue(3), issue(5)];
    assert.deepEqual(await claimCandidates(github.host, issues, pass(alice, {}, 1)), {
      order: [3],
      taken: [],
    });
    assert.deepEqual([...github.refs.keys()], [`${repo}#3`]);
    const next = pass(alice, { brewed: new Set([3]) }, 1);
    assert.deepEqual(await claimCandidates(github.host, issues, next), { order: [5], taken: [] });
  });

  it('leaves the issues past the limit to another Brewery', async () => {
    const github = fakeGitHub();
    const issues = [issue(3), issue(5), issue(9)];
    await claimCandidates(github.host, issues, pass(alice, {}, 1));
    assert.deepEqual(await claimCandidates(github.host, issues, pass(bob, {}, 2)), {
      order: [5, 9],
      taken: [{ issue: 3, by: 'alice/brewery' }],
    });
  });

  it('claims nothing with a limit of 0', async () => {
    const github = fakeGitHub();
    assert.deepEqual(await claimCandidates(github.host, [issue(7)], pass(alice, {}, 0)), {
      order: [],
      taken: [],
    });
    assert.equal(github.refs.size, 0);
  });

  for (const limit of [-1, 1.5, Number.NaN]) {
    it(`refuses a limit of ${limit}`, async () => {
      await assert.rejects(
        claimCandidates(fakeGitHub().host, [issue(7)], pass(alice, {}, limit)),
        RangeError,
      );
    });
  }

  it('orders its own claim again when the batch was never ordered, and not once it was', async () => {
    const github = fakeGitHub();
    await claimCandidates(github.host, [issue(7)], pass(alice));
    assert.deepEqual(await claimCandidates(github.host, [issue(7)], pass(alice)), {
      order: [7],
      taken: [],
    });
    const brewed = pass(alice, { brewed: new Set([7]) });
    assert.deepEqual(await claimCandidates(github.host, [issue(7)], brewed), {
      order: [],
      taken: [],
    });
  });
});

describe('releaseClaim', () => {
  const claim = { repo, issue: 7, brewery: alice.brewery };

  it("deletes the Brewery's own claim ref", async () => {
    const github = fakeGitHub();
    github.setRef(repo, 7, record(alice.brewery));
    assert.equal(await releaseClaim(github.host, claim), 'released');
    assert.equal(github.refs.has(`${repo}#7`), false);
  });

  it('deletes its own claim ref whose record spells the Brewery in another case', async () => {
    const github = fakeGitHub();
    github.setRef(repo, 7, record('Alice/Brewery'));
    assert.equal(await releaseClaim(github.host, claim), 'released');
    assert.equal(github.refs.has(`${repo}#7`), false);
  });

  it('does nothing when the ref is gone', async () => {
    const github = fakeGitHub();
    assert.equal(await releaseClaim(github.host, claim), 'gone');
    assert.equal(github.calls.get('delete'), undefined);
  });

  it('leaves a claim that another Brewery made between reading and deleting the ref', async () => {
    const github = fakeGitHub({
      // A human released the claim by hand, and Bob's Brewery claimed the issue at once.
      afterRead: (fake) => fake.setRef(repo, 7, record(bob.brewery)),
    });
    github.setRef(repo, 7, record(alice.brewery));
    assert.equal(await releaseClaim(github.host, claim), 'not_ours');
    assert.equal(github.refs.get(`${repo}#7`), record(bob.brewery));
  });

  it("never deletes another Brewery's claim, or one it cannot read", async () => {
    for (const message of [record(bob.brewery), 'not a record']) {
      const github = fakeGitHub();
      github.setRef(repo, 7, message);
      assert.equal(await releaseClaim(github.host, claim), 'not_ours');
      assert.equal(github.refs.get(`${repo}#7`), message);
    }
  });
});

describe('claimEffectsDue', () => {
  const pullRequest = 'https://github.com/acme/app/pull/12';
  const other = 'https://github.com/acme/app/pull/13';
  const batch = (lane: Lane): ClaimedBatch => ({ batchId: 'app-7-1', repo, issue: 7, lane });
  const states =
    (byUrl: Record<string, PullRequestState>) =>
    (url: string): PullRequestState =>
      byUrl[url] ?? 'open';
  const names = (due: { key: EffectKey }[]): string[] => due.map(({ key }) => key.effect);
  const onTap: Lane = { kind: 'on_tap', pullRequests: [pullRequest, other] };

  const live: Lane[] = [
    { kind: 'ordered', routeBy: now },
    { kind: 'brewing' },
    { kind: 'conditioning', on: { kind: 'sibling', batchId: 'app-8-1' }, remindAt: now },
    {
      kind: 'stuck',
      reason: { kind: 'routing', deadlineAt: now },
      options: ['retry'],
      remindAt: now,
    },
  ];
  for (const lane of live) {
    it(`marks the issue while the batch is ${lane.kind}`, () => {
      const due = claimEffectsDue(batch(lane), alice, states({}));
      assert.deepEqual(names(due), ['claim.assignee', 'claim.label', 'claim.comment']);
      assert.deepEqual(
        due.map(({ key }) => key.batchId),
        ['app-7-1', 'app-7-1', 'app-7-1'],
      );
      assert.deepEqual(due[0]?.effect, { kind: 'assign', repo, issue: 7, login: 'alice' });
      assert.deepEqual(due[1]?.effect, { kind: 'add_label', repo, issue: 7, label: claimLabel });
      const comment = due[2]?.effect;
      assert.equal(comment?.kind, 'comment');
      assert.match(comment.kind === 'comment' ? comment.body : '', /alice\/brewery.*app-7-1/s);
    });
  }

  it('keys every effect by the batch and its name', () => {
    const due = claimEffectsDue(batch({ kind: 'brewing' }), alice, states({}));
    assert.deepEqual(
      due.map(({ key }) => effectKey.encode(key)),
      ['["app-7-1","claim.assignee"]', '["app-7-1","claim.label"]', '["app-7-1","claim.comment"]'],
    );
  });

  it('keeps the marks while a pull request of the batch is open', () => {
    const due = claimEffectsDue(batch(onTap), alice, states({ [pullRequest]: 'merged' }));
    assert.deepEqual(names(due), ['claim.assignee', 'claim.label', 'claim.comment']);
  });

  const released: [string, Lane, Record<string, PullRequestState>, RegExp][] = [
    [
      'cancelled',
      { kind: 'cancelled', by: 'alice', via: 'terminal' },
      {},
      /was cancelled\. Unassign the issue to make it available again\.$/,
    ],
    [
      'merged',
      onTap,
      { [pullRequest]: 'merged', [other]: 'merged' },
      /its pull requests were merged\.$/,
    ],
    [
      'closed',
      onTap,
      { [pullRequest]: 'merged', [other]: 'closed' },
      /a pull request was closed without being merged\. Unassign the issue to make it available again\.$/,
    ],
    [
      'On Tap without pull requests',
      { kind: 'on_tap', pullRequests: [] },
      {},
      /ended without a pull request\. Unassign the issue to make it available again\.$/,
    ],
  ];
  for (const [why, lane, byUrl, says] of released) {
    it(`releases the claim, leaving the assignee, once the batch is ${why}`, () => {
      const due = claimEffectsDue(batch(lane), alice, states(byUrl));
      assert.deepEqual(names(due), ['release.label', 'release.comment', 'release.ref']);
      assert.deepEqual(due[0]?.effect, {
        kind: 'remove_label',
        repo,
        issue: 7,
        label: claimLabel,
      });
      const comment = due[1]?.effect;
      assert.match(comment?.kind === 'comment' ? comment.body : '', says);
      assert.deepEqual(due[2]?.effect, {
        kind: 'release_ref',
        repo,
        issue: 7,
        brewery: 'alice/brewery',
      });
    });
  }

  it('applies each mark and release once across a kill between applying and recording', async () => {
    const github = fakeGitHub();
    github.setRef(repo, 7, record(alice.brewery));
    const entries = new Map<string, unknown>();
    let kills = 0;
    const ledger: Ledger = {
      find: (key) => {
        const text = effectKey.encode(key);
        return entries.has(text) ? { result: entries.get(text) } : undefined;
      },
      record: (key, result) => {
        // The first record of every key dies with the engine; the effect is on GitHub already.
        const text = effectKey.encode(key);
        if (!entries.has(`killed ${text}`)) {
          entries.set(`killed ${text}`, true);
          kills++;
          throw new Error('killed');
        }
        entries.set(text, result);
      },
    };
    const run = async (lane: Lane) => {
      for (const { key, effect } of claimEffectsDue(batch(lane), alice, states({}))) {
        await applyEffect(ledger, key, github.target(effect, alice.login)).catch(() => undefined);
        await applyEffect(ledger, key, github.target(effect, alice.login));
      }
    };
    await run({ kind: 'brewing' });
    assert.deepEqual(github.issue(repo, 7).assignees, ['alice']);
    assert.deepEqual(github.issue(repo, 7).labels, [claimLabel]);
    assert.equal(github.issue(repo, 7).comments.length, 1);
    await run({ kind: 'cancelled', by: 'alice', via: 'terminal' });
    assert.deepEqual(github.issue(repo, 7).assignees, ['alice']);
    assert.deepEqual(github.issue(repo, 7).labels, []);
    assert.equal(github.issue(repo, 7).comments.length, 2);
    assert.equal(github.refs.has(`${repo}#7`), false);
    assert.equal(kills, 6);
  });
});
