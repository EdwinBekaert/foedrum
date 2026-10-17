// The intake's reads of GitHub (ADR 0050, ADR 0052): the open issues of a target repository and
// how a pull request stands, from synthetic answers in the shape GitHub's REST API gives
// (test/fixtures/github/), through a fake `fetch`; no network (ADR 0021).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { githubTargetTracker } from '../../src/github/tracker.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/github/${name}.json`, import.meta.url), 'utf8'));

const api = 'https://api.github.com';
const listing = `${api}/repos/acme/web/issues?state=open&sort=created&direction=asc&per_page=10`;

/**
 * How many of the longest bodies GitHub keeps (65,536 characters, 6 bytes each as `\u` escapes)
 * fit in the client's 4 MiB answer limit.
 */
const longestFit = Math.floor((4 * 1024 * 1024) / (65_536 * 6 + 4096));
const perPage = (url: string | undefined): number =>
  Number(new URL(url ?? 'https://x').searchParams.get('per_page'));

const pullRequest = 'https://github.com/acme/web/pull/12';

const trackerWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({ token: 'ghp_test', fetch: fake.fetch });
  return { tracker: githubTargetTracker(createGitHubReads(client)), requests: fake.requests };
};

const pull = (fields: Record<string, unknown>): Answer => ({
  status: 200,
  body: { ...(fixture('pull-merged') as object), ...fields },
});

describe('githubTargetTracker', () => {
  describe('issues', () => {
    it('lists the open issues oldest first, as the intake reads them', async () => {
      // Issue 7's body stands for hostile input: what the intake reads of an issue has no body.
      const { tracker, requests } = trackerWith([{ status: 200, body: fixture('issues') }]);
      assert.deepStrictEqual(await tracker.issues('acme/web'), [
        {
          number: 7,
          state: 'open',
          pullRequest: false,
          labels: ['foedrum', 'ui'],
          milestone: 'M1',
          assignees: ['alice'],
          author: 'alice',
        },
        {
          number: 8,
          state: 'open',
          pullRequest: true,
          labels: ['foedrum'],
          milestone: undefined,
          assignees: [],
          author: 'bob',
        },
        // A deleted account is nobody, so never an allow-listed author.
        {
          number: 9,
          state: 'open',
          pullRequest: false,
          labels: [],
          milestone: undefined,
          assignees: [],
          author: '',
        },
      ]);
      assert.deepStrictEqual(
        requests.map(({ method, url }) => [method, url]),
        [['GET', listing]],
      );
    });

    it('reads labels given as plain names, and assignees given as null', async () => {
      const item = { number: 10, state: 'open', user: { login: 'alice' }, labels: ['foedrum'] };
      const { tracker } = trackerWith([
        { status: 200, body: [{ ...item, assignees: null, milestone: null }] },
      ]);
      const [issue] = await tracker.issues('acme/web');
      assert.deepStrictEqual(issue?.labels, ['foedrum']);
      assert.deepStrictEqual(issue?.assignees, []);
    });

    it('asks again with the ETag, and an unchanged listing answers the same issues', async () => {
      const { tracker, requests } = trackerWith([
        { status: 200, body: fixture('issues'), headers: { etag: 'W/"issues"' } },
        { status: 304 },
      ]);
      const first = await tracker.issues('acme/web');
      assert.deepStrictEqual(await tracker.issues('acme/web'), first);
      assert.equal(requests[1]?.headers['if-none-match'], 'W/"issues"');
    });

    it('asks for pages small enough that a page of the longest issues stays under the answer limit', async () => {
      const { tracker, requests } = trackerWith([{ status: 200, body: [] }]);
      await tracker.issues('acme/web');
      // Anyone may open issues on a public repository: a page of long ones must not stop the
      // listing.
      assert.ok(perPage(requests[0]?.url) >= 1);
      assert.ok(perPage(requests[0]?.url) <= longestFit, `per_page ${perPage(requests[0]?.url)}`);
    });

    it('reads every page of the listing', async () => {
      const [first, ...rest] = fixture('issues') as unknown[];
      const { tracker } = trackerWith([
        {
          status: 200,
          body: [first],
          headers: { link: `<${api}/repositories/42/issues?page=2>; rel="next"` },
        },
        { status: 200, body: rest },
      ]);
      assert.deepStrictEqual(
        (await tracker.issues('acme/web')).map(({ number }) => number),
        [7, 8, 9],
      );
    });

    it('fails on an answer it cannot read, naming the repository', async () => {
      const broken = [{ number: 'seven', state: 'open', labels: [], assignees: [] }];
      const { tracker } = trackerWith([{ status: 200, body: broken }]);
      await assert.rejects(tracker.issues('acme/web'), /the open issues of acme\/web/);
      const missing = trackerWith([{ status: 404, body: { message: 'Not Found' } }]);
      await assert.rejects(missing.tracker.issues('acme/web'), /404 .*acme\/web: Not Found/);
    });

    it('refuses a repository that is no owner/name before asking GitHub', async () => {
      const { tracker, requests } = trackerWith([]);
      await assert.rejects(tracker.issues('acme/../x'), /owner\/name/);
      assert.equal(requests.length, 0);
    });

    it('stops when its signal aborts', async () => {
      const { tracker, requests } = trackerWith(['hang']);
      const controller = new AbortController();
      const reading = tracker.issues('acme/web', undefined, controller.signal);
      controller.abort(new Error('the pass is past its deadline'));
      await assert.rejects(reading, /past its deadline/);
      assert.equal(requests[0]?.signal?.aborted, true);
    });
  });

  describe('pullRequest', () => {
    it('reads a merged pull request as merged', async () => {
      const { tracker, requests } = trackerWith([{ status: 200, body: fixture('pull-merged') }]);
      assert.equal(await tracker.pullRequest(pullRequest), 'merged');
      assert.equal(requests[0]?.url, `${api}/repos/acme/web/pulls/12`);
    });

    it('reads a pull request as merged from either merged or merged_at alone', async () => {
      const byTime = trackerWith([pull({ merged: undefined, merged_at: '2026-10-16T09:00:00Z' })]);
      assert.equal(await byTime.tracker.pullRequest(pullRequest), 'merged');
      const byFlag = trackerWith([pull({ merged: true, merged_at: null })]);
      assert.equal(await byFlag.tracker.pullRequest(pullRequest), 'merged');
    });

    it('reads a closed pull request that was not merged as closed, and an open one as open', async () => {
      const closed = trackerWith([pull({ merged: false, merged_at: null })]);
      assert.equal(await closed.tracker.pullRequest(pullRequest), 'closed');
      const open = trackerWith([
        pull({ state: 'open', merged: false, merged_at: null, closed_at: null }),
      ]);
      assert.equal(await open.tracker.pullRequest(pullRequest), 'open');
    });

    it('asks again with the ETag', async () => {
      const { tracker, requests } = trackerWith([
        { status: 200, body: fixture('pull-merged'), headers: { etag: '"pr"' } },
        { status: 304 },
      ]);
      await tracker.pullRequest(pullRequest);
      assert.equal(await tracker.pullRequest(pullRequest), 'merged');
      assert.equal(requests[1]?.headers['if-none-match'], '"pr"');
    });

    it('refuses a URL that names no pull request before asking GitHub', async () => {
      const { tracker, requests } = trackerWith([]);
      for (const url of [
        'https://github.com/acme/web/issues/12',
        'https://github.com/acme/web/pull/0',
        'https://github.com/acme/web/pull/12/files',
        'https://github.com/acme/../pull/12',
        'not a url',
      ]) {
        await assert.rejects(tracker.pullRequest(url), /not a pull request/, url);
      }
      assert.equal(requests.length, 0);
    });

    it('fails on an answer it cannot read, naming the pull request', async () => {
      const { tracker } = trackerWith([pull({ state: 'merged' })]);
      await assert.rejects(tracker.pullRequest(pullRequest), /acme\/web#12/);
      const missing = trackerWith([{ status: 404, body: { message: 'Not Found' } }]);
      await assert.rejects(missing.tracker.pullRequest(pullRequest), /404 .*acme\/web#12/);
    });

    it('stops when its signal aborts', async () => {
      const { tracker, requests } = trackerWith(['hang']);
      const controller = new AbortController();
      const reading = tracker.pullRequest(pullRequest, controller.signal);
      controller.abort(new Error('the pass is past its deadline'));
      await assert.rejects(reading, /past its deadline/);
      assert.equal(requests[0]?.signal?.aborted, true);
    });
  });
});
