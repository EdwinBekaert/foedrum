// The claim ref against GitHub itself (ADR 0043): opt-in, because it writes to a real repository.
// Set FOEDRUM_GITHUB_TEST_REPO to an owner/name the token can push to, and FOEDRUM_GITHUB_TEST_TOKEN
// to that token; skipped otherwise, in CI included. It proves what the claim relies on: creating
// a ref that exists fails, so exactly one of two racing claims wins, and GraphQL `updateRefs` with
// `beforeOid` deletes the ref only while it points at that commit. Each run uses a fresh issue
// number that names no real issue, and deletes its ref at the end, whatever happened.

import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { claimIssue, releaseClaim } from '../../src/engine/issue-claims.ts';
import { EMPTY_TREE, githubClaimHost } from '../../src/github/claims.ts';
import { createGitHubClient } from '../../src/github/client.ts';

const repo = process.env.FOEDRUM_GITHUB_TEST_REPO;
const token = process.env.FOEDRUM_GITHUB_TEST_TOKEN;
const enabled = repo !== undefined && repo !== '' && token !== undefined && token !== '';

describe('the claim ref on GitHub', {
  skip: !enabled && 'set FOEDRUM_GITHUB_TEST_REPO and FOEDRUM_GITHUB_TEST_TOKEN',
}, () => {
  const target = repo ?? '';
  const client = createGitHubClient({ token: token ?? '' });
  const host = githubClaimHost(client);
  const issue = 900_000_000 + randomInt(99_999_999);
  const now = new Date().toISOString();
  const alice = 'alice/brewery';
  const bob = 'bob/brewery';
  // Whatever happened, the ref goes.
  after(async () => {
    if (!enabled) return;
    await client.rest('DELETE', `/repos/${target}/git/refs/foedrum/claims/issues/${issue}`);
  });

  it('lets exactly one of two racing claims win, and the other find it taken', async () => {
    const outcomes = await Promise.all([
      claimIssue(host, { repo: target, issue, brewery: alice, now }),
      claimIssue(host, { repo: target, issue, brewery: bob, now }),
    ]);
    const kinds = outcomes.map((outcome) => outcome.kind).sort();
    assert.deepStrictEqual(kinds, ['taken', 'won']);
  });

  it('reads the record of the Brewery that won, and finds its own claim as ours', async () => {
    const read = await host.read(target, issue);
    assert.ok(read !== undefined);
    const { brewery } = JSON.parse(read.message) as { brewery: string };
    assert.ok([alice, bob].includes(brewery));
    assert.deepStrictEqual(await claimIssue(host, { repo: target, issue, brewery, now }), {
      kind: 'ours',
    });
  });

  it('does not delete the ref from a commit it does not point at', async () => {
    const before = await host.read(target, issue);
    assert.ok(before !== undefined);
    const other = await client.rest('POST', `/repos/${target}/git/commits`, {
      message: 'another commit',
      tree: EMPTY_TREE,
      parents: [],
    });
    const { sha } = other.body as { sha: string };
    assert.equal(await host.delete(target, issue, sha), false);
    assert.deepStrictEqual(await host.read(target, issue), before);
  });

  it('deletes the ref from the commit it points at, and then it is gone', async () => {
    const read = await host.read(target, issue);
    assert.ok(read !== undefined);
    const { brewery } = JSON.parse(read.message) as { brewery: string };
    assert.equal(await releaseClaim(host, { repo: target, issue, brewery }), 'released');
    assert.equal(await host.read(target, issue), undefined);
    assert.equal(await releaseClaim(host, { repo: target, issue, brewery }), 'gone');
  });
});
