// A repository's latest release on GitHub (ADR 0223): its latest published release, else its newest
// tag through GraphQL, and whether it holds a pull request's merge commit, from synthetic answers in
// the shape GitHub's API gives, through a fake `fetch`; no network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { githubReleaseReader } from '../../src/github/releases.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

const api = 'https://api.github.com';
const repo = 'acme/lib-core';
const pullRequest = 'https://github.com/acme/lib-core/pull/12';
const merge = 'b'.repeat(40);
const latestUrl = `${api}/repos/acme/lib-core/releases/latest`;
const pullUrl = `${api}/repos/acme/lib-core/pulls/12`;
const commitUrl = `${api}/repos/acme/lib-core/git/commits/${merge}`;
const compareUrl = (tag: string) =>
  `${api}/repos/acme/lib-core/compare/${encodeURIComponent(tag)}...${merge}?per_page=1`;

const readerWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
  return {
    reader: githubReleaseReader(createGitHubReads(client), client),
    requests: fake.requests,
  };
};

const release = (tag: string, published = '2026-10-26T11:00:00Z'): Answer => ({
  status: 200,
  body: {
    id: 7,
    tag_name: tag,
    name: 'Anything',
    draft: false,
    prerelease: false,
    published_at: published,
    body: 'x'.repeat(1000),
  },
  headers: { etag: `"${tag}"` },
});
const notFound: Answer = { status: 404, body: { message: 'Not Found' } };
const tags = (nodes: unknown[]): Answer => ({
  status: 200,
  body: { data: { repository: { refs: { nodes } } } },
});
const pull = (fields: Record<string, unknown>): Answer => ({
  status: 200,
  body: { state: 'closed', merged: true, ...fields },
});
const merged = pull({ merged_at: '2026-10-26T10:00:00Z', merge_commit_sha: merge });
/** The merge commit as git's data API gives it: its committer's date. */
const mergeCommit = (date: string): Answer => ({
  status: 200,
  body: { sha: merge, committer: { name: 'GitHub', date }, message: 'Merge pull request #12' },
});
const compared = (status: string): Answer => ({
  status: 200,
  body: { status, ahead_by: 0, behind_by: 3, commits: [], files: [] },
});

describe('githubReleaseReader', () => {
  describe('latest', () => {
    it("reads the repository's latest published release, conditionally the next time", async () => {
      const { reader, requests } = readerWith([
        release('v2.4.0'),
        { status: 304, headers: { etag: '"v2.4.0"' } },
      ]);
      const expected = { version: 'v2.4.0', published: '2026-10-26T11:00:00.000Z' };
      assert.deepStrictEqual(await reader.latest(repo), expected);
      assert.deepStrictEqual(await reader.latest(repo), expected);
      assert.deepStrictEqual(
        requests.map(({ url }) => url),
        [latestUrl, latestUrl],
      );
      assert.equal(requests[1]?.headers['if-none-match'], '"v2.4.0"');
    });

    it('reads the newest tag by its commit date when the repository has no release', async () => {
      const { reader, requests } = readerWith([
        notFound,
        tags([{ name: 'v1.2.0', target: { committedDate: '2026-10-25T09:00:00Z' } }]),
      ]);
      assert.deepStrictEqual(await reader.latest(repo), {
        version: 'v1.2.0',
        published: '2026-10-25T09:00:00.000Z',
        tag: true,
      });
      const query = requests[1];
      assert.equal(query?.url, `${api}/graphql`);
      const body = query?.body as { query: string; variables: Record<string, unknown> };
      assert.match(body.query, /refs\(refPrefix: "refs\/tags\/", first: 1/);
      assert.match(body.query, /orderBy: \{field: TAG_COMMIT_DATE, direction: DESC\}/);
      assert.deepStrictEqual(body.variables, { owner: 'acme', name: 'lib-core' });
    });

    it("dates an annotated tag by its commit's date", async () => {
      const { reader } = readerWith([
        notFound,
        tags([{ name: 'v1.2.0', target: { target: { committedDate: '2026-10-25T09:00:00Z' } } }]),
      ]);
      assert.equal((await reader.latest(repo))?.published, '2026-10-25T09:00:00.000Z');
    });

    it('has no release for a repository with neither a release nor a tag', async () => {
      assert.equal(await readerWith([notFound, tags([])]).reader.latest(repo), undefined);
    });

    it('refuses a tag that is no valid ref name or longer than 255 characters, and says why', async () => {
      for (const tag of ['v1..2', 'v1 2', '-x/.hidden', 'v1.lock', 'v1/', '@', 'a@{b', 'x\u0007']) {
        await assert.rejects(readerWith([release(tag)]).reader.latest(repo), /no valid ref name/);
      }
      // One near miss for each rule of git's ref names (review of #578).
      const nearMisses = ['v1~1', 'v1^', 'v1:2', 'v1?', 'v1*', 'v1[', 'v1\\2', 'v1.'];
      for (const tag of [...nearMisses, `x${String.fromCodePoint(0x7f)}`]) {
        await assert.rejects(readerWith([release(tag)]).reader.latest(repo), /no valid ref name/);
      }
      assert.equal(
        (await readerWith([release('v'.repeat(255))]).reader.latest(repo))?.version,
        'v'.repeat(255),
      );
      await assert.rejects(
        readerWith([release('v'.repeat(256))]).reader.latest(repo),
        /longer than 255 characters/,
      );
      await assert.rejects(
        readerWith([notFound, tags([{ name: 'a..b', target: {} }])]).reader.latest(repo),
        /no valid ref name/,
      );
      assert.equal(
        (await readerWith([release('release/v1.0-rc.1+b')]).reader.latest(repo))?.version,
        'release/v1.0-rc.1+b',
      );
    });

    it('fails on a newest tag that points at no commit, naming it (review of #578)', async () => {
      await assert.rejects(
        readerWith([notFound, tags([{ name: 'v9', target: {} }])]).reader.latest(repo),
        /The latest tag of acme\/lib-core, "v9", points at no commit/,
      );
    });

    it('fails on an answer that is not what it should be, and on a refusal', async () => {
      await assert.rejects(
        readerWith([{ status: 200, body: { tag_name: 'v1' } }]).reader.latest(repo),
        /not what it should be/,
      );
      await assert.rejects(
        readerWith([{ status: 502, body: { message: 'Bad gateway' } }]).reader.latest(repo),
        /502.*Bad gateway/,
      );
      await assert.rejects(
        readerWith([
          notFound,
          {
            status: 200,
            body: { data: { repository: null }, errors: [{ message: 'Could not resolve' }] },
          },
        ]).reader.latest(repo),
        /Could not resolve/,
      );
    });
  });

  describe('holds', () => {
    const v2 = { version: 'v2.4.0', published: '2026-10-26T11:00:00.000Z' };

    it('holds the merge when the merge commit is behind the tag, or is it', async () => {
      for (const status of ['behind', 'identical']) {
        const { reader, requests } = readerWith([merged, compared(status)]);
        assert.equal(await reader.holds(repo, v2, pullRequest), true, status);
        assert.deepStrictEqual(
          requests.map(({ url }) => url),
          [pullUrl, compareUrl('v2.4.0')],
        );
      }
    });

    it('does not hold it when the merge commit is ahead of the tag or diverged from it', async () => {
      for (const status of ['ahead', 'diverged']) {
        const { reader } = readerWith([merged, compared(status)]);
        assert.equal(await reader.holds(repo, v2, pullRequest), false, status);
      }
    });

    it('never compares a release published before the merge', async () => {
      const { reader, requests } = readerWith([merged]);
      const old = { version: 'v2.3.0', published: '2026-10-26T09:59:59.000Z' };
      assert.equal(await reader.holds(repo, old, pullRequest), false);
      assert.deepStrictEqual(
        requests.map(({ url }) => url),
        [pullUrl],
      );
    });

    it('compares a release published in the second of the merge', async () => {
      const { reader, requests } = readerWith([merged, compared('behind')]);
      const same = { version: 'v2.4.0', published: '2026-10-26T10:00:00.000Z' };
      assert.equal(await reader.holds(repo, same, pullRequest), true);
      assert.equal(requests.length, 2);
    });

    it('holds nothing of a pull request with a merge commit but no merge time, and compares nothing', async () => {
      const { reader, requests } = readerWith([pull({ merged_at: null, merge_commit_sha: merge })]);
      assert.equal(await reader.holds(repo, v2, pullRequest), false);
      assert.deepStrictEqual(
        requests.map(({ url }) => url),
        [pullUrl],
      );
    });

    it('holds nothing of a pull request with no merge commit, or of another repository', async () => {
      const none = readerWith([pull({ merged_at: null, merge_commit_sha: null })]);
      assert.equal(await none.reader.holds(repo, v2, pullRequest), false);
      const unmerged = readerWith([pull({ merged_at: '2026-10-26T10:00:00Z' })]);
      assert.equal(await unmerged.reader.holds(repo, v2, pullRequest), false);
      const other = readerWith([]);
      assert.equal(
        await other.reader.holds(repo, v2, 'https://github.com/acme/web/pull/12'),
        false,
      );
      assert.deepStrictEqual(other.requests, []);
      // The repository in another case is the same one.
      const cased = readerWith([merged, compared('behind')]);
      assert.equal(await cased.reader.holds('Acme/Lib-Core', v2, pullRequest), true);
    });

    it("compares a tag dated before the merge time but not before the merge commit's own date (review of #578)", async () => {
      // Merged locally at 08:59, tagged at 09:00, both pushed at 10:00, when GitHub marked it merged.
      const { reader, requests } = readerWith([
        merged,
        mergeCommit('2026-10-26T08:59:00Z'),
        compared('behind'),
      ]);
      const tag = { version: 'v2.4.0', published: '2026-10-26T09:00:00.000Z', tag: true };
      assert.equal(await reader.holds(repo, tag, pullRequest), true);
      assert.deepStrictEqual(
        requests.map(({ url }) => url),
        [pullUrl, commitUrl, compareUrl('v2.4.0')],
      );
    });

    it('never compares a tag whose commit is older than the merge commit (review of #578)', async () => {
      const { reader, requests } = readerWith([merged, mergeCommit('2026-10-26T09:30:00Z')]);
      const tag = { version: 'v2.3.0', published: '2026-10-26T09:00:00.000Z', tag: true };
      assert.equal(await reader.holds(repo, tag, pullRequest), false);
      assert.deepStrictEqual(
        requests.map(({ url }) => url),
        [pullUrl, commitUrl],
      );
    });

    it('names a tag with a slash as one path segment', async () => {
      const { reader, requests } = readerWith([merged, compared('behind')]);
      const slashed = { version: 'release/v2', published: v2.published };
      assert.equal(await reader.holds(repo, slashed, pullRequest), true);
      assert.equal(requests[1]?.url, compareUrl('release/v2'));
    });

    it('fails on a compare it cannot read or that is not what it should be', async () => {
      await assert.rejects(
        readerWith([merged, notFound]).reader.holds(repo, v2, pullRequest),
        /404.*Not Found/,
      );
      await assert.rejects(
        readerWith([merged, { status: 200, body: { status: 'sideways' } }]).reader.holds(
          repo,
          v2,
          pullRequest,
        ),
        /not what it should be/,
      );
      await assert.rejects(
        readerWith([pull({ merged_at: 'yesterday', merge_commit_sha: merge })]).reader.holds(
          repo,
          v2,
          pullRequest,
        ),
        /not what it should be/,
      );
    });
  });
});
