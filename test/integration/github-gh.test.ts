// The GitHub client through the real gh against a local fake GitHub (ADR 0073): this tests
// Foedrum's parsing of what gh prints, not GitHub. See fake-github-over-gh.ts for how gh reaches
// the fake without the keyring, the user's login or github.com. It runs wherever gh is on PATH,
// and fails in CI without it.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createGitHubClient, GitHubRateLimited } from '../../src/github/client.ts';
import { resolveExecutable } from '../../src/platform/executables.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';
import {
  FAKE_HOST,
  type Route,
  SYNTHETIC_LOGIN,
  startFakeGitHubOverGh,
} from './fake-github-over-gh.ts';

const hasGh = resolveExecutable('gh') !== undefined;
const inCi = process.env.CI !== undefined && process.env.CI !== '';

const json = (
  response: Parameters<Route>[1],
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): true => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(body === undefined ? undefined : JSON.stringify(body));
  return true;
};

const route: Route = ({ method, path, headers, body }, response) => {
  switch (`${method} ${path}`) {
    case 'GET /repos/acme/web/issues/7':
      return headers['if-none-match'] === 'W/"seven"'
        ? json(response, 304, undefined, { etag: 'W/"seven"' })
        : json(response, 200, { number: 7, title: 'Brew ✓' }, { etag: 'W/"seven"' });
    case 'GET /repos/acme/web/issues/9':
      return json(response, 404, { message: 'Not Found' });
    case 'GET /rate_limited':
      return json(
        response,
        403,
        { message: 'API rate limit exceeded' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '4102444800' },
      );
    case 'GET /large':
      return json(response, 200, { text: 'x'.repeat(200_000) });
    case 'POST /repos/acme/web/issues/7/labels':
      return json(response, 200, JSON.parse(body));
    case 'DELETE /repos/acme/web/issues/7/labels/brewing':
      response.writeHead(204);
      response.end();
      return true;
    case 'POST /graphql': {
      const { query } = JSON.parse(body) as { query: string };
      if (!query.includes('foedrumProbe')) return undefined;
      return json(response, 200, { data: { probe: 1 }, errors: [{ message: 'partly' }] });
    }
    default:
      return undefined;
  }
};

describe('the GitHub client through the real gh (ADR 0073)', {
  skip: !hasGh && !inCi && 'gh is not on PATH',
}, () => {
  const dir = makeTempDir('github-gh');
  let fake: Awaited<ReturnType<typeof startFakeGitHubOverGh>> | undefined;
  const client = (options: { env?: NodeJS.ProcessEnv; maxResponseBytes?: number } = {}) =>
    createGitHubClient({
      hostname: FAKE_HOST,
      cwd: dir.path,
      env: options.env ?? fake?.env ?? {},
      ...(options.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: options.maxResponseBytes }),
    });

  before(async () => {
    assert.ok(hasGh, 'gh is not on PATH; CI needs it for this test');
    fake = await startFakeGitHubOverGh(dir.path, route);
  });
  after(async () => {
    await fake?.close();
    dir.remove();
  });

  it('reads a 200 with its headers, then a 304 for its ETag, where gh exits 1', async () => {
    const github = client();
    const first = await github.rest('GET', '/repos/acme/web/issues/7');
    assert.equal(first.status, 200);
    assert.deepStrictEqual(first.body, { number: 7, title: 'Brew ✓' });
    assert.equal(first.headers.get('etag'), 'W/"seven"');
    const again = await github.rest('GET', '/repos/acme/web/issues/7', undefined, undefined, {
      'if-none-match': 'W/"seven"',
    });
    assert.deepStrictEqual([again.status, again.body], [304, null]);
  });

  it('answers a 404 as an answer, and a 204 without a body', async () => {
    const github = client();
    const missing = await github.rest('GET', '/repos/acme/web/issues/9');
    assert.deepStrictEqual([missing.status, missing.body], [404, { message: 'Not Found' }]);
    const removed = await github.rest('DELETE', '/repos/acme/web/issues/7/labels/brewing');
    assert.deepStrictEqual([removed.status, removed.body], [204, null]);
  });

  it('pauses on a rate-limited 403, from the headers gh printed', async () => {
    await assert.rejects(client().rest('GET', '/rate_limited'), GitHubRateLimited);
  });

  it("sends a body on stdin, with gh's own login and never a token variable", async () => {
    const github = client({ env: { ...fake?.env, GH_TOKEN: 'from-the-environment' } });
    const answer = await github.rest('POST', '/repos/acme/web/issues/7/labels', {
      labels: ['--help', 'brewing'],
    });
    assert.deepStrictEqual(answer.body, { labels: ['--help', 'brewing'] });
    const sent = fake?.requests.at(-1);
    assert.equal(sent?.authorization, `token ${SYNTHETIC_LOGIN}`);
    assert.equal(sent?.headers['x-github-api-version'], '2022-11-28');
  });

  it("sends GraphQL to gh's endpoint, and reads data and errors", async () => {
    const answer = await client().graphql('query foedrumProbe { probe }', { n: 1 });
    assert.deepStrictEqual(answer, { data: { probe: 1 }, errors: [{ message: 'partly' }] });
  });

  it('fails on an answer longer than its limit', async () => {
    await assert.rejects(
      client({ maxResponseBytes: 100_000 }).rest('GET', '/large'),
      /longer than 100000 bytes/,
    );
  });

  it('fails with the login to make when gh has none for the host', async () => {
    const empty = makeTempDir('github-gh-no-login');
    try {
      await assert.rejects(
        client({ env: fake?.envWithoutLogin(empty.path) ?? {} }).rest('GET', '/user'),
        /gh auth login --hostname github\.localhost$/,
      );
    } finally {
      empty.remove();
    }
  });
});
