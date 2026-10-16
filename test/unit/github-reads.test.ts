// Conditional reads of GitHub (ADR 0052): a GET carries the ETag of the answer before it, a 304
// answers that body again, and a list is read page by page along the `Link` header. A fake `fetch`;
// no network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { createGitHubReads, type GitHubReadsOptions } from '../../src/github/reads.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';

const api = 'https://api.github.com';

const readsWith = (answers: Answer[], options?: GitHubReadsOptions) => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({ token: 'ghp_test', fetch: fake.fetch });
  return { reads: createGitHubReads(client, options), requests: fake.requests };
};

const next = (page: number): string => `<${api}/repositories/42/issues?page=${page}>; rel="next"`;

describe('createGitHubReads', () => {
  describe('get', () => {
    it('asks with the ETag of the answer before, and answers a 304 with that body', async () => {
      const { reads, requests } = readsWith([
        { status: 200, body: { n: 1 }, headers: { etag: 'W/"one"' } },
        { status: 304, headers: { etag: 'W/"one"' } },
      ]);
      assert.deepStrictEqual((await reads.get('/repos/acme/web/issues/7')).body, { n: 1 });
      const again = await reads.get('/repos/acme/web/issues/7');
      assert.equal(requests[0]?.headers['if-none-match'], undefined);
      assert.equal(requests[1]?.headers['if-none-match'], 'W/"one"');
      assert.equal(again.status, 200);
      assert.deepStrictEqual(again.body, { n: 1 });
    });

    it('keeps the newer answer when the resource changed', async () => {
      const { reads, requests } = readsWith([
        { status: 200, body: { n: 1 }, headers: { etag: 'W/"one"' } },
        { status: 200, body: { n: 2 }, headers: { etag: 'W/"two"' } },
        { status: 304 },
      ]);
      await reads.get('/x');
      assert.deepStrictEqual((await reads.get('/x')).body, { n: 2 });
      assert.deepStrictEqual((await reads.get('/x')).body, { n: 2 });
      assert.equal(requests[2]?.headers['if-none-match'], 'W/"two"');
    });

    it('keeps each path apart', async () => {
      const { reads, requests } = readsWith([
        { status: 200, body: 'a', headers: { etag: '"a"' } },
        { status: 200, body: 'b', headers: { etag: '"b"' } },
      ]);
      await reads.get('/a');
      await reads.get('/b');
      assert.equal(requests[1]?.headers['if-none-match'], undefined);
    });

    it('keeps no answer without an ETag, and no answer that is not 200', async () => {
      const { reads, requests } = readsWith([
        { status: 200, body: 'a' },
        { status: 404, body: { message: 'Not Found' }, headers: { etag: '"gone"' } },
        { status: 200, body: 'a' },
        { status: 200, body: 'b' },
      ]);
      await reads.get('/a');
      assert.equal((await reads.get('/b')).status, 404);
      await reads.get('/a');
      await reads.get('/b');
      assert.equal(requests[2]?.headers['if-none-match'], undefined);
      assert.equal(requests[3]?.headers['if-none-match'], undefined);
    });

    it('fails on a 304 to a request that named no ETag', async () => {
      const { reads } = readsWith([{ status: 304 }]);
      await assert.rejects(reads.get('/a'), /304 to \/a/);
    });

    it('keeps at most its entries, dropping the least recently used', async () => {
      const { reads, requests } = readsWith(
        [
          { status: 200, body: 'a', headers: { etag: '"a"' } },
          { status: 200, body: 'b', headers: { etag: '"b"' } },
          { status: 304 },
          { status: 200, body: 'c', headers: { etag: '"c"' } },
          { status: 304 },
          { status: 200, body: 'b' },
        ],
        { maxEntries: 2 },
      );
      await reads.get('/a');
      await reads.get('/b');
      // Used again, so /b is now the least recently used.
      await reads.get('/a');
      await reads.get('/c');
      await reads.get('/a');
      await reads.get('/b');
      assert.equal(requests[4]?.headers['if-none-match'], '"a"');
      assert.equal(requests[5]?.headers['if-none-match'], undefined);
    });

    it('hands the request the caller signal', async () => {
      const { reads, requests } = readsWith(['hang']);
      const controller = new AbortController();
      const reading = reads.get('/a', controller.signal);
      controller.abort(new Error('past its deadline'));
      await assert.rejects(reading, /past its deadline/);
      assert.equal(requests[0]?.signal?.aborted, true);
    });
  });

  describe('pages', () => {
    it('follows the next page until there is none, each page conditional on its own', async () => {
      const { reads, requests } = readsWith([
        { status: 200, body: [1, 2], headers: { etag: '"p1"', link: next(2) } },
        { status: 200, body: [3], headers: { etag: '"p2"' } },
        { status: 304 },
        { status: 304 },
      ]);
      assert.deepStrictEqual(await reads.pages('/repos/acme/web/issues', 'the issues'), [1, 2, 3]);
      assert.deepStrictEqual(await reads.pages('/repos/acme/web/issues', 'the issues'), [1, 2, 3]);
      assert.deepStrictEqual(
        requests.map(({ url, headers }) => [url, headers['if-none-match']]),
        [
          [`${api}/repos/acme/web/issues`, undefined],
          [`${api}/repositories/42/issues?page=2`, undefined],
          [`${api}/repos/acme/web/issues`, '"p1"'],
          [`${api}/repositories/42/issues?page=2`, '"p2"'],
        ],
      );
    });

    it('reads the next page among the other relations of the Link header', async () => {
      const link = `<${api}/r?page=1>; rel="prev", <${api}/r?page=3>; rel="next", <${api}/r?page=9>; rel="last"`;
      const { reads, requests } = readsWith([
        { status: 200, body: [1], headers: { link } },
        { status: 200, body: [2] },
      ]);
      assert.deepStrictEqual(await reads.pages('/r?page=2', 'r'), [1, 2]);
      assert.equal(requests[1]?.url, `${api}/r?page=3`);
    });

    it('never follows a next page off the API, so the token goes nowhere else', async () => {
      for (const link of [
        '<https://evil.example/steal>; rel="next"',
        `<${api}.evil.example/x>; rel="next"`,
        '</relative>; rel="next"',
      ]) {
        const { reads, requests } = readsWith([{ status: 200, body: [1], headers: { link } }]);
        await assert.rejects(reads.pages('/r', 'the list'), /next page of the list is not on/);
        assert.equal(requests.length, 1);
      }
    });

    it('fails past its most pages instead of reading on, or stopping short in silence', async () => {
      const { reads, requests } = readsWith(
        [
          { status: 200, body: [1], headers: { link: next(2) } },
          { status: 200, body: [2], headers: { link: next(3) } },
        ],
        { maxPages: 2 },
      );
      await assert.rejects(reads.pages('/r', 'the issues'), /the issues has more than 2 pages/);
      assert.equal(requests.length, 2);
    });

    it('fails on a page that is not 200 or not a list, naming what it read', async () => {
      const notFound = readsWith([{ status: 404, body: { message: 'Not Found' } }]);
      await assert.rejects(
        notFound.reads.pages('/r', 'the issues of acme/web'),
        /GitHub answered 404 to the issues of acme\/web: Not Found/,
      );
      const notAList = readsWith([{ status: 200, body: { items: [] } }]);
      await assert.rejects(
        notAList.reads.pages('/r', 'the issues of acme/web'),
        /answer to the issues of acme\/web is not what it should be/,
      );
    });

    it('hands every page the caller signal', async () => {
      const { reads, requests } = readsWith([
        { status: 200, body: [1], headers: { link: next(2) } },
        'hang',
      ]);
      const controller = new AbortController();
      const reading = reads.pages('/r', 'r', controller.signal);
      while (requests.length < 2) await new Promise((resolve) => setImmediate(resolve));
      controller.abort(new Error('past its deadline'));
      await assert.rejects(reading, /past its deadline/);
      assert.equal(requests[1]?.signal?.aborted, true);
    });
  });

  it('refuses a cache or page limit that is no positive whole number', () => {
    const client = createGitHubClient({ token: 't', fetch: fakeFetch([]).fetch });
    for (const options of [{ maxEntries: 0 }, { maxPages: 0 }, { maxPages: 1.5 }]) {
      assert.throws(() => createGitHubReads(client, options), RangeError);
    }
  });
});
