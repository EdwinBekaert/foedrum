// The GitHub client (ADR 0008, ADR 0052): request headers in, answer headers out, and the pause on
// GitHub's rate limit, which fails every request until it ends without reaching GitHub. A fake
// `fetch` and a fake clock; no network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient, GitHubRateLimited } from '../../src/github/client.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';

const start = Date.parse('2026-10-16T09:00:00.000Z');
const ok: Answer = { status: 200, body: { ok: true } };

const clientWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  let now = start;
  const client = createGitHubClient({ token: 'ghp_test', fetch: fake.fetch, now: () => now });
  return {
    client,
    requests: fake.requests,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const limited = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GitHubRateLimited, `not a rate limit: ${String(error)}`);
    assert.match(error.message, /rate limit holds requests until/);
    return error.until.toISOString();
  }
  assert.fail('the request was not refused for the rate limit');
};

const at = (ms: number): string => new Date(start + ms).toISOString();
const seconds = (ms: number): string => String(Math.floor((start + ms) / 1000));

describe('createGitHubClient', () => {
  it('sends the headers it is given and answers with the headers GitHub sent', async () => {
    const { client, requests } = clientWith([
      { status: 200, body: [], headers: { etag: 'W/"abc"', link: '<x>; rel="next"' } },
    ]);
    const answer = await client.rest('GET', '/repos/acme/web/issues', undefined, undefined, {
      'if-none-match': 'W/"old"',
    });
    assert.equal(requests[0]?.headers['if-none-match'], 'W/"old"');
    assert.equal(answer.headers.get('etag'), 'W/"abc"');
    assert.equal(answer.headers.get('link'), '<x>; rel="next"');
  });

  it('names its base URL without a trailing slash, and asks there', async () => {
    const fake = fakeFetch([ok]);
    const client = createGitHubClient({
      token: 't',
      fetch: fake.fetch,
      baseUrl: 'https://ghe.example/api/v3/',
    });
    assert.equal(client.baseUrl, 'https://ghe.example/api/v3');
    await client.rest('GET', '/repos/acme/web');
    assert.equal(fake.requests[0]?.url, 'https://ghe.example/api/v3/repos/acme/web');
  });

  describe('the rate limit', () => {
    it('pauses until the reset when the primary limit is used up, without asking GitHub', async () => {
      const { client, requests, advance } = clientWith([
        {
          status: 403,
          body: { message: 'API rate limit exceeded for user ID 1001.' },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': seconds(600_000) },
        },
        ok,
      ]);
      assert.equal(await limited(client.rest('GET', '/a')), at(600_000));
      advance(599_000);
      assert.equal(await limited(client.rest('GET', '/b')), at(600_000));
      assert.equal(requests.length, 1);
      advance(1_000);
      assert.equal((await client.rest('GET', '/c')).status, 200);
      assert.equal(requests.length, 2);
    });

    it('waits the seconds a retry-after names, on a 403 or a 429', async () => {
      for (const status of [403, 429]) {
        const { client } = clientWith([
          { status, body: { message: 'slow down' }, headers: { 'retry-after': '30' } },
        ]);
        assert.equal(await limited(client.rest('GET', '/a')), at(30_000));
      }
    });

    it('prefers retry-after to the reset when GitHub sends both', async () => {
      const { client } = clientWith([
        {
          status: 429,
          headers: {
            'retry-after': '45',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': seconds(600_000),
          },
        },
      ]);
      assert.equal(await limited(client.rest('GET', '/a')), at(45_000));
    });

    it('waits a minute on a secondary limit without headers, doubling while it repeats', async () => {
      const secondary: Answer = {
        status: 403,
        body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' },
      };
      const { client, advance } = clientWith([secondary, secondary, secondary, ok, secondary]);
      assert.equal(await limited(client.rest('GET', '/a')), at(60_000));
      advance(60_000);
      assert.equal(await limited(client.rest('GET', '/a')), at(180_000));
      advance(120_000);
      assert.equal(await limited(client.rest('GET', '/a')), at(420_000));
      advance(240_000);
      assert.equal((await client.rest('GET', '/a')).status, 200);
      // An answer that was no limit starts the doubling over.
      assert.equal(await limited(client.rest('GET', '/a')), at(480_000));
    });

    it('doubles a secondary pause up to 15 minutes at most', async () => {
      const secondary: Answer = { status: 429 };
      const { client, advance } = clientWith(Array(6).fill(secondary));
      const pauses: number[] = [];
      let now = start;
      for (let n = 0; n < 6; n++) {
        const until = Date.parse(await limited(client.rest('GET', '/a')));
        pauses.push((until - now) / 60_000);
        advance(until - now);
        now = until;
      }
      assert.deepStrictEqual(pauses, [1, 2, 4, 8, 15, 15]);
    });

    it('pauses an hour at most, whatever reset or retry-after says', async () => {
      const { client } = clientWith([{ status: 429, headers: { 'retry-after': '86400' } }]);
      assert.equal(await limited(client.rest('GET', '/a')), at(3_600_000));
      const { client: other } = clientWith([
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': seconds(400 * 86_400_000) },
        },
      ]);
      assert.equal(await limited(other.rest('GET', '/a')), at(3_600_000));
    });

    it('pauses after an answer that used the last request, and still returns that answer', async () => {
      const { client, requests } = clientWith([
        {
          status: 200,
          body: { ok: true },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': seconds(120_000) },
        },
      ]);
      assert.deepStrictEqual((await client.rest('GET', '/a')).body, { ok: true });
      assert.equal(await limited(client.rest('GET', '/b')), at(120_000));
      assert.equal(requests.length, 1);
    });

    it('holds GraphQL requests too', async () => {
      const { client, requests } = clientWith([
        {
          status: 200,
          body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': seconds(60_000) },
        },
      ]);
      const answer = await client.graphql('query { viewer { login } }', {});
      assert.equal(answer.errors[0]?.message, 'API rate limit exceeded');
      assert.equal(await limited(client.graphql('query { viewer { login } }', {})), at(60_000));
      assert.equal(requests.length, 1);
    });

    it('answers a 403 that is no rate limit as it is', async () => {
      const { client } = clientWith([
        { status: 403, body: { message: 'Resource not accessible by personal access token' } },
        ok,
      ]);
      assert.equal((await client.rest('GET', '/a')).status, 403);
      assert.equal((await client.rest('GET', '/b')).status, 200);
    });

    it('ignores a reset or retry-after that is no number', async () => {
      const { client } = clientWith([
        {
          status: 429,
          headers: {
            'retry-after': 'soon',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': 'x',
          },
        },
      ]);
      assert.equal(await limited(client.rest('GET', '/a')), at(60_000));
    });
  });
});
