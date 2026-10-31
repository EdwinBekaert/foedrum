// The GitHub client (ADR 0052, ADR 0073): requests through `gh api --include`, request headers in,
// answer headers out, and the pause on GitHub's rate limit, which fails every request until it
// ends without reaching GitHub. A fake `gh` (a fake process runner over a fake `fetch`, or
// captured output) and a fake clock; no process and no network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient, GitHubRateLimited } from '../../src/github/client.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { flagValue, type GhOutput, ghAnswering, ghOver } from '../helpers/fake-gh.ts';

const start = Date.parse('2026-10-16T09:00:00.000Z');
const ok: Answer = { status: 200, body: { ok: true } };

const clientWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  let now = start;
  const client = createGitHubClient({ exec: ghOver(fake.fetch).exec, now: () => now });
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

// What gh 2.102.0 printed with --include against a local fake GitHub (ADR 0073): the status line
// ends in LF, the headers in CRLF, and an empty line comes before the body.
const printed = (status: string, headers: string[], body: string): string =>
  `HTTP/1.1 ${status}\n${headers.map((header) => `${header}\r\n`).join('')}\r\n${body}`;
const captured: Record<string, GhOutput> = {
  ok: {
    stdout: printed(
      '200 OK',
      ['Content-Type: application/json; charset=utf-8', 'Etag: "e1"', 'X-Ratelimit-Remaining: 42'],
      '{"login":"octocat"}',
    ),
    exitCode: 0,
  },
  notModified: {
    stdout: printed('304 Not Modified', ['Etag: "a"'], ''),
    stderr: 'gh: HTTP 304\n',
    exitCode: 1,
  },
  notFound: {
    stdout: printed('404 Not Found', ['Content-Type: application/json'], '{"message":"Not Found"}'),
    stderr: 'gh: Not Found (HTTP 404)\n',
    exitCode: 1,
  },
  rateLimited: {
    stdout: printed(
      '403 Forbidden',
      [
        'Content-Type: application/json',
        'X-Ratelimit-Remaining: 0',
        `X-Ratelimit-Reset: ${seconds(600_000)}`,
      ],
      '{"message":"API rate limit exceeded"}',
    ),
    stderr: 'gh: API rate limit exceeded (HTTP 403)\n',
    exitCode: 1,
  },
  noContent: { stdout: printed('204 No Content', [], ''), exitCode: 0 },
  notLoggedIn: {
    stdout: '',
    stderr:
      'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
    exitCode: 4,
  },
};

const capturedClient = (outputs: GhOutput[], options = {}) => {
  const gh = ghAnswering(outputs);
  return { client: createGitHubClient({ exec: gh.exec, now: () => start, ...options }), gh };
};

describe('createGitHubClient', () => {
  describe('an answer kept as text (ADR 0228)', () => {
    it('asks with escape sequences allowed, under its own limit, and never parses the answer', async () => {
      const esc = String.fromCodePoint(0x1b);
      for (const body of ['true', '12', `${esc}[31mred${esc}[0m\nnext`]) {
        const { client, gh } = capturedClient([
          { stdout: printed('200 OK', ['Content-Type: text/plain'], body), exitCode: 0 },
        ]);
        const answer = await client.text('/repos/acme/web/actions/jobs/9/logs', 1000);
        assert.equal(answer.status, 200);
        assert.equal(answer.text, body);
        assert.equal(answer.headers.get('content-type'), 'text/plain');
        const call = gh.calls[0];
        assert.ok(call !== undefined);
        assert.equal(call.args.at(-1), '/repos/acme/web/actions/jobs/9/logs');
        assert.equal(flagValue(call.args, '--method'), 'GET');
        assert.ok(call.args.includes('--allow-escape-sequences'));
        assert.ok((call.options.maxOutputBytes ?? 0) > 1000);
        assert.ok((call.options.maxOutputBytes ?? 0) < 4 * 1024 * 1024);
      }
    });

    it('answers a refusal with its status, and fails an answer longer than its limit', async () => {
      const { client } = capturedClient([
        captured.notFound as GhOutput,
        { stdout: printed('200 OK', [], 'x'.repeat(1001)), exitCode: 0 },
      ]);
      const missing = await client.text('/repos/acme/web/actions/jobs/9/logs', 1000);
      assert.equal(missing.status, 404);
      assert.equal(missing.text, '{"message":"Not Found"}');
      await assert.rejects(
        client.text('/repos/acme/web/actions/jobs/9/logs', 1000),
        /longer than 1000 bytes/,
      );
    });

    it("pauses for GitHub's rate limit, and asks nothing more until the pause ends", async () => {
      const { client, gh } = capturedClient([captured.rateLimited as GhOutput]);
      assert.equal(
        await limited(client.text('/repos/acme/web/actions/jobs/9/logs', 1000)),
        at(600_000),
      );
      assert.equal(
        await limited(client.text('/repos/acme/web/actions/jobs/10/logs', 1000)),
        at(600_000),
      );
      assert.equal(gh.calls.length, 1);
    });

    it('never asks for a path that is not one', async () => {
      const { client } = capturedClient([]);
      await assert.rejects(client.text('--hostname=evil', 1000), /starts with \//);
    });
  });

  describe('through gh api (ADR 0073)', () => {
    it('runs gh api --include on the host with the method, the headers and the path', async () => {
      const { client, gh } = capturedClient([captured.ok as GhOutput]);
      await client.rest('GET', '/repos/acme/web/issues?state=open', undefined, undefined, {
        'if-none-match': 'W/"old"',
      });
      const call = gh.calls[0];
      assert.equal(call?.file, 'gh');
      assert.deepEqual(call?.args, [
        'api',
        '--include',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        '-H',
        'if-none-match: W/"old"',
        '-H',
        'accept: application/vnd.github+json',
        '-H',
        'user-agent: foedrum',
        '-H',
        'x-github-api-version: 2022-11-28',
        '/repos/acme/web/issues?state=open',
      ]);
      assert.equal(call?.options.stdin, undefined);
    });

    it("sends a caller's API version instead of its own, once", async () => {
      const { client, gh } = capturedClient([captured.ok as GhOutput]);
      await client.rest('GET', '/repos/acme/web/issues/7/sub_issues', undefined, undefined, {
        'x-github-api-version': '2026-03-10',
      });
      const versions = (gh.calls[0]?.args ?? []).filter((arg) =>
        arg.startsWith('x-github-api-version:'),
      );
      assert.deepStrictEqual(versions, ['x-github-api-version: 2026-03-10']);
    });

    it('sends a body as JSON on stdin, never as an argument', async () => {
      const { client, gh } = capturedClient([captured.ok as GhOutput]);
      await client.rest('POST', '/repos/acme/web/issues/7/labels', { labels: ['--help'] });
      const call = gh.calls[0];
      assert.deepEqual(call?.args.slice(-3), ['/repos/acme/web/issues/7/labels', '--input', '-']);
      assert.equal(call?.options.stdin, '{"labels":["--help"]}');
    });

    it("sends GraphQL to gh's graphql endpoint", async () => {
      const { client, gh } = capturedClient([
        { ...(captured.ok as GhOutput), stdout: printed('200 OK', [], '{"data":{"a":1}}') },
      ]);
      assert.deepStrictEqual(await client.graphql('query { a }', { n: 1 }), {
        data: { a: 1 },
        errors: [],
      });
      assert.deepEqual(gh.calls[0]?.args.slice(-3), ['graphql', '--input', '-']);
      assert.equal(gh.calls[0]?.options.stdin, '{"query":"query { a }","variables":{"n":1}}');
    });

    it('refuses a path that is not under the API root before running gh', async () => {
      const { client, gh } = capturedClient([]);
      for (const path of ['--hostname=evil.example', 'repos/acme/web', '']) {
        await assert.rejects(client.rest('GET', path), /A GitHub API path starts with \//);
      }
      assert.equal(gh.calls.length, 0);
    });

    it('runs gh without the GitHub token variables and without debug output', async () => {
      const { client, gh } = capturedClient([captured.ok as GhOutput], {
        env: {
          PATH: '/usr/bin',
          GH_TOKEN: 'a',
          GITHUB_TOKEN: 'b',
          GH_ENTERPRISE_TOKEN: 'c',
          GITHUB_ENTERPRISE_TOKEN: 'd',
          GH_DEBUG: 'api',
          DEBUG: '1',
          GH_CONFIG_DIR: '/home/me/.config/gh',
        },
        platform: 'linux',
      });
      await client.rest('GET', '/user');
      assert.deepStrictEqual(gh.calls[0]?.options.env, {
        PATH: '/usr/bin',
        GH_CONFIG_DIR: '/home/me/.config/gh',
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
      });
    });

    it('compares the token variables as Windows does there', async () => {
      const { client, gh } = capturedClient([captured.ok as GhOutput], {
        env: { Path: 'C:\\bin', Gh_Token: 'a', github_token: 'b' },
        platform: 'win32',
      });
      await client.rest('GET', '/user');
      const names = Object.keys(gh.calls[0]?.options.env ?? {});
      assert.deepEqual(
        names.filter((name) => /token/i.test(name)),
        [],
      );
    });

    it('reads the status, the headers and the body of a 200', async () => {
      const { client } = capturedClient([captured.ok as GhOutput]);
      const answer = await client.rest('GET', '/user');
      assert.equal(answer.status, 200);
      assert.deepStrictEqual(answer.body, { login: 'octocat' });
      assert.equal(answer.headers.get('etag'), '"e1"');
      assert.equal(answer.headers.get('x-ratelimit-remaining'), '42');
      assert.equal(answer.bytes, 19);
    });

    it('answers a 304 and a 404, where gh exits 1, as answers', async () => {
      const { client } = capturedClient([
        captured.notModified as GhOutput,
        captured.notFound as GhOutput,
      ]);
      const unchanged = await client.rest('GET', '/repos/acme/web/issues');
      assert.equal(unchanged.status, 304);
      assert.equal(unchanged.body, null);
      assert.equal(unchanged.headers.get('etag'), '"a"');
      const missing = await client.rest('GET', '/repos/acme/web/issues/9');
      assert.equal(missing.status, 404);
      assert.deepStrictEqual(missing.body, { message: 'Not Found' });
    });

    it('answers a 204 with no body', async () => {
      const { client } = capturedClient([captured.noContent as GhOutput]);
      const answer = await client.rest('DELETE', '/repos/acme/web/issues/7/labels/x');
      assert.deepStrictEqual([answer.status, answer.body, answer.bytes], [204, null, 0]);
    });

    it("pauses on a rate-limited 403 from gh's headers", async () => {
      const { client, gh } = capturedClient([captured.rateLimited as GhOutput]);
      assert.equal(await limited(client.rest('GET', '/a')), at(600_000));
      assert.equal(await limited(client.rest('GET', '/b')), at(600_000));
      assert.equal(gh.calls.length, 1);
    });

    it('keeps a body that holds an empty line, and reads CRLF headers after an HTTP/2 status', async () => {
      const { client } = capturedClient([
        { stdout: 'HTTP/2.0 200 OK\r\nEtag: "x"\r\n\r\n"one\\n\\ntwo"\n\nmore', exitCode: 0 },
      ]);
      const answer = await client.rest('GET', '/a');
      assert.equal(answer.headers.get('etag'), '"x"');
      assert.equal(answer.body, '"one\\n\\ntwo"\n\nmore');
    });

    it('reads a body of exactly its limit', async () => {
      const body = JSON.stringify('x'.repeat(126));
      assert.equal(Buffer.byteLength(body), 128);
      const { client } = capturedClient([{ stdout: printed('200 OK', [], body), exitCode: 0 }], {
        maxResponseBytes: 128,
      });
      const answer = await client.rest('GET', '/a');
      assert.deepStrictEqual([answer.bytes, answer.body], [128, 'x'.repeat(126)]);
    });

    it('fails on a body longer than its limit', async () => {
      const long = printed('200 OK', [], JSON.stringify('x'.repeat(200)));
      const { client, gh } = capturedClient([{ stdout: long, exitCode: 0 }], {
        maxResponseBytes: 128,
      });
      await assert.rejects(client.rest('GET', '/a'), /answer to GET \/a is longer than 128 bytes/);
      // The runner stops gh once its output passes the limit and room for the headers.
      assert.equal(gh.calls[0]?.options.maxOutputBytes, 128 + 64 * 1024);
    });

    it('fails on output the runner cut off at its limit', async () => {
      const exec: ExecProcess = async () => ({
        exitCode: null,
        stdout: '',
        stderr: '',
        output: '',
        killed: 'too-much-output',
      });
      const client = createGitHubClient({ exec, maxResponseBytes: 128 });
      await assert.rejects(client.rest('GET', '/a'), /longer than 128 bytes/);
    });

    it('fails with the login to make when gh has none for the host', async () => {
      const { client } = capturedClient([captured.notLoggedIn as GhOutput], {
        hostname: 'ghe.example',
      });
      await assert.rejects(
        client.rest('GET', '/user'),
        /^Error: gh could not ask GitHub for GET \/user: To get started with GitHub CLI, please run: {2}gh auth login; run gh auth login --hostname ghe\.example$/,
      );
    });

    it("fails with gh's first line when it printed no answer", async () => {
      const { client } = capturedClient([
        { stdout: '', stderr: '\nerror connecting to api.github.com\n', exitCode: 1 },
        { stdout: 'not an answer', stderr: '', exitCode: 0 },
        { stdout: '', stderr: 'gh: not found on PATH (ENOENT)', exitCode: null },
      ]);
      await assert.rejects(
        client.rest('GET', '/a'),
        /GET \/a: error connecting to api\.github\.com$/,
      );
      await assert.rejects(client.rest('GET', '/a'), /GET \/a: gh exited with 0$/);
      await assert.rejects(client.rest('GET', '/a'), /GET \/a: gh: not found on PATH/);
    });

    it('does not read an answer from a gh that exited with another code', async () => {
      const { client } = capturedClient([{ ...(captured.ok as GhOutput), exitCode: 2 }]);
      await assert.rejects(client.rest('GET', '/a'), /gh could not ask GitHub for GET \/a/);
    });

    it('gives gh its timeout and the caller signal', async () => {
      const { client, gh } = capturedClient([captured.ok as GhOutput], { timeoutMs: 5000 });
      const controller = new AbortController();
      await client.rest('GET', '/a', undefined, controller.signal);
      assert.equal(gh.calls[0]?.options.timeoutMs, 5000);
      assert.equal(gh.calls[0]?.options.signal, controller.signal);
    });
  });

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

  it('says how many bytes each answer was, for the reads to bound their cache (ADR 0068)', async () => {
    const { client } = clientWith([{ status: 200, body: { title: 'é' } }, { status: 204 }]);
    // {"title":"é"}: 13 characters, 14 bytes in UTF-8.
    assert.equal((await client.rest('GET', '/repos/acme/web/issues/1')).bytes, 14);
    assert.equal((await client.rest('GET', '/repos/acme/web/issues/2')).bytes, 0);
  });

  it("names the API root of gh's host, and asks that host", async () => {
    for (const [hostname, root] of [
      [undefined, 'https://api.github.com'],
      ['github.com', 'https://api.github.com'],
      ['ghe.example', 'https://ghe.example/api/v3'],
      ['github.localhost', 'http://api.github.localhost'],
    ] as const) {
      const gh = ghAnswering([captured.ok as GhOutput]);
      const client = createGitHubClient({
        exec: gh.exec,
        ...(hostname === undefined ? {} : { hostname }),
      });
      assert.equal(client.baseUrl, root);
      await client.rest('GET', '/repos/acme/web');
      assert.equal(flagValue(gh.calls[0]?.args ?? [], '--hostname'), hostname ?? 'github.com');
    }
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
