// The checks GitHub runs on an open pull request's head (ADR 0213): its head, then the check runs
// and the commit statuses on it, from synthetic answers in the shape GitHub's REST API gives,
// through a fake `fetch`; no network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { githubCheckReader } from '../../src/github/checks.ts';
import { createGitHubClient, GitHubRateLimited } from '../../src/github/client.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { MAX_HEAD_CHECK_URL_LENGTH, MAX_LOG_UNREAD_LENGTH } from '../../src/schemas/events.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { flagValue, ghOver } from '../helpers/fake-gh.ts';

const api = 'https://api.github.com';
const pullRequest = 'https://github.com/acme/web/pull/12';
const head = 'a'.repeat(40);
const runs = `${api}/repos/acme/web/commits/${head}/check-runs?per_page=10`;
const statuses = `${api}/repos/acme/web/commits/${head}/status?per_page=10`;

const readerWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
  return { reader: githubCheckReader(createGitHubReads(client), client), requests: fake.requests };
};

/**
 * A reader whose gh prints `printed` for a job's log, as `gh api --include` does: a log is plain
 * text, served by the blob store GitHub redirects to.
 */
const logReaderWith = (
  printed: { stdout: string; stderr?: string; exitCode: number } | 'too long' | Error,
) => {
  const calls: { args: readonly string[]; maxOutputBytes: number | undefined }[] = [];
  const exec: ExecProcess = async (_file, args, options) => {
    calls.push({ args, maxOutputBytes: options.maxOutputBytes });
    if (printed instanceof Error) throw printed;
    if (printed === 'too long') {
      return { exitCode: null, stdout: '', stderr: '', output: '', killed: 'too-much-output' };
    }
    const { stdout, stderr = '', exitCode } = printed;
    return { exitCode, stdout, stderr, output: `${stdout}${stderr}` };
  };
  const client = createGitHubClient({ exec });
  return { reader: githubCheckReader(createGitHubReads(client), client), calls };
};
const blob = (status: string, body: string) =>
  `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nServer: Windows-Azure-Blob/1.0\r\n\r\n${body}`;
const esc = String.fromCodePoint(0x1b);
const jobLog = [
  '2026-10-26T18:47:17.4709227Z ##[group]Run npm test',
  `2026-10-26T18:47:17.4709227Z ${esc}[36;1mnpm test${esc}[0m`,
  '2026-10-26T18:47:17.4709227Z ##[endgroup]',
  '2026-10-26T18:49:21.6668871Z not ok 1 - adds',
  '2026-10-26T18:49:21.7159496Z ##[error]Process completed with exit code 1.',
  '2026-10-26T18:49:28.2565322Z Post job cleanup.',
].join('\n');

const run = (name: string, status: string, conclusion: string | null, id = 1) => ({
  id,
  name,
  status,
  conclusion,
  html_url: `https://github.com/acme/web/actions/runs/7/job/${id}`,
  // What GitHub also sends, which the reader never keeps.
  output: { title: null, summary: 'x'.repeat(1000) },
});
const status = (context: string, state: string, target_url: string | null) => ({
  context,
  state,
  target_url,
  description: 'anything',
});
const runsPage = (items: unknown[], headers?: Record<string, string>): Answer => ({
  status: 200,
  body: { total_count: items.length, check_runs: items },
  ...(headers === undefined ? {} : { headers }),
});
const statusPage = (items: unknown[], headers?: Record<string, string>): Answer => ({
  status: 200,
  body: { state: 'pending', sha: head, total_count: items.length, statuses: items },
  ...(headers === undefined ? {} : { headers }),
});

describe('githubCheckReader', () => {
  it('reads the head the pull request has now', async () => {
    const { reader, requests } = readerWith([
      { status: 200, body: { state: 'open', head: { sha: head, ref: 'foedrum/x' } } },
    ]);
    assert.equal(await reader.head(pullRequest), head);
    assert.deepStrictEqual(
      requests.map(({ url }) => url),
      [`${api}/repos/acme/web/pulls/12`],
    );
  });

  it('refuses a head that is no full commit sha, and a pull request it cannot read', async () => {
    const bad = readerWith([{ status: 200, body: { state: 'open', head: { sha: 'main' } } }]);
    await assert.rejects(bad.reader.head(pullRequest), /not what it should be/);
    const gone = readerWith([{ status: 404, body: { message: 'Not Found' } }]);
    await assert.rejects(gone.reader.head(pullRequest), /404.*Not Found/);
    await assert.rejects(readerWith([]).reader.head('https://github.com/acme/web/issues/3'));
  });

  it('reads every check run and commit status on the head, page after page', async () => {
    const { reader, requests } = readerWith([
      runsPage([run('build', 'completed', 'success', 1)], {
        link: `<${api}/repositories/42/commits/${head}/check-runs?page=2>; rel="next"`,
      }),
      runsPage([run('test', 'in_progress', null, 2), run('lint', 'queued', null, 3)]),
      statusPage([status('ci/coverage', 'failure', 'https://ci.example/7')], {
        link: `<${api}/repositories/42/commits/${head}/status?page=2>; rel="next"`,
      }),
      statusPage([status('ci/deploy', 'pending', null)]),
    ]);
    assert.deepStrictEqual(await reader.checks(pullRequest, head), [
      {
        name: 'build',
        kind: 'check_run',
        conclusion: 'success',
        url: 'https://github.com/acme/web/actions/runs/7/job/1',
      },
      { name: 'test', kind: 'check_run', url: 'https://github.com/acme/web/actions/runs/7/job/2' },
      { name: 'lint', kind: 'check_run', url: 'https://github.com/acme/web/actions/runs/7/job/3' },
      { name: 'ci/coverage', kind: 'status', conclusion: 'failure', url: 'https://ci.example/7' },
      { name: 'ci/deploy', kind: 'status' },
    ]);
    assert.deepStrictEqual(
      requests.map(({ url }) => url),
      [
        runs,
        `${api}/repositories/42/commits/${head}/check-runs?page=2`,
        statuses,
        `${api}/repositories/42/commits/${head}/status?page=2`,
      ],
    );
  });

  it('names every conclusion as GitHub does, and one it does not know as unknown', async () => {
    const conclusions = [
      'success',
      'neutral',
      'skipped',
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'stale',
      'startup_failure',
      'something_new',
    ];
    const { reader } = readerWith([
      runsPage(conclusions.map((conclusion, n) => run(conclusion, 'completed', conclusion, n))),
      statusPage([
        status('s', 'success', null),
        status('f', 'failure', null),
        status('e', 'error', null),
        status('p', 'pending', null),
      ]),
    ]);
    const read = await reader.checks(pullRequest, head);
    assert.deepStrictEqual(
      read.map(({ name, conclusion }) => [name, conclusion ?? 'running']),
      [
        ...conclusions.slice(0, -1).map((conclusion) => [conclusion, conclusion]),
        ['something_new', 'unknown'],
        ['s', 'success'],
        ['f', 'failure'],
        ['e', 'error'],
        ['p', 'running'],
      ],
    );
  });

  it('counts a waiting check run as running, and one that completed without a conclusion as unknown', async () => {
    const { reader } = readerWith([
      runsPage([run('waiting', 'waiting', null), run('odd', 'completed', null)]),
      statusPage([]),
    ]);
    assert.deepStrictEqual(
      (await reader.checks(pullRequest, head)).map(({ name, conclusion }) => [name, conclusion]),
      [
        ['waiting', undefined],
        ['odd', 'unknown'],
      ],
    );
  });

  it(`leaves out a link longer than ${MAX_HEAD_CHECK_URL_LENGTH} characters`, async () => {
    const at = 'https://ci.example/';
    const longest = `${at}${'a'.repeat(MAX_HEAD_CHECK_URL_LENGTH - at.length)}`;
    const { reader } = readerWith([
      runsPage([]),
      statusPage([status('kept', 'success', longest), status('long', 'success', `${longest}a`)]),
    ]);
    assert.deepStrictEqual(await reader.checks(pullRequest, head), [
      { name: 'kept', kind: 'status', conclusion: 'success', url: longest },
      { name: 'long', kind: 'status', conclusion: 'success' },
    ]);
  });

  it('never keeps half a character when it cuts a name', async () => {
    const smile = String.fromCodePoint(0x1f600);
    const { reader } = readerWith([
      runsPage([
        run(`${'x'.repeat(199)}${smile}y`, 'completed', 'success', 1),
        run(`${'x'.repeat(198)}${smile}y`, 'completed', 'success', 2),
      ]),
      statusPage([]),
    ]);
    assert.deepStrictEqual(
      (await reader.checks(pullRequest, head)).map(({ name }) => name),
      ['x'.repeat(199), `${'x'.repeat(198)}${smile}`],
    );
  });

  it('cuts a long name, and leaves out a link that is not https or holds credentials', async () => {
    const { reader } = readerWith([
      runsPage([{ ...run('x'.repeat(300), 'completed', 'success'), html_url: 'javascript:1' }]),
      statusPage([
        status('plain', 'success', 'http://ci.example/1'),
        status('secret', 'success', 'https://user:token@ci.example/1'),
        status('', 'success', 'https://ci.example/2'),
      ]),
    ]);
    const read = await reader.checks(pullRequest, head);
    assert.deepStrictEqual(read, [
      { name: 'x'.repeat(200), kind: 'check_run', conclusion: 'success' },
      { name: 'plain', kind: 'status', conclusion: 'success' },
      { name: 'secret', kind: 'status', conclusion: 'success' },
      // A context GitHub gives empty is still a check; it is named by its kind.
      { name: 'status', kind: 'status', conclusion: 'success', url: 'https://ci.example/2' },
    ]);
  });

  it('names the job of a GitHub Actions check run, and of no other check', async () => {
    const { reader } = readerWith([
      runsPage([
        { ...run('test', 'completed', 'failure', 9), app: { slug: 'github-actions' } },
        { ...run('scan', 'completed', 'failure', 10), app: { slug: 'some-app' } },
        run('lint', 'completed', 'failure', 11),
      ]),
      statusPage([status('deploy', 'error', null)]),
    ]);
    const read = await reader.checks(pullRequest, head);
    assert.deepStrictEqual(
      read.map(({ name, job }) => [name, job]),
      [
        ['test', 9],
        ['scan', undefined],
        ['lint', undefined],
        ['deploy', undefined],
      ],
    );
  });

  it('names no job of an Actions check run whose id is missing, zero or not a whole number', async () => {
    const actions = { slug: 'github-actions' };
    const { id: _, ...noId } = run('none', 'completed', 'failure');
    const { reader } = readerWith([
      runsPage([
        { ...noId, app: actions },
        { ...run('zero', 'completed', 'failure', 0), app: actions },
        { ...run('half', 'completed', 'failure', 1.5), app: actions },
        { ...run('huge', 'completed', 'failure', 2 ** 53), app: actions },
      ]),
      statusPage([]),
    ]);
    const read = await reader.checks(pullRequest, head);
    assert.deepStrictEqual(
      read.map(({ name, job }) => [name, job]),
      [
        ['none', undefined],
        ['zero', undefined],
        ['half', undefined],
        ['huge', undefined],
      ],
    );
  });

  it("reads a job's log as text, escape sequences allowed, outside the cached reads, and keeps its failing step", async () => {
    const { reader, calls } = logReaderWith({ stdout: blob('200 OK', jobLog), exitCode: 0 });
    assert.deepStrictEqual(await reader.log(pullRequest, 9), {
      excerpt: [
        '##[group]Run npm test',
        'npm test',
        '##[endgroup]',
        'not ok 1 - adds',
        '##[error]Process completed with exit code 1.',
      ].join('\n'),
    });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call !== undefined);
    assert.equal(call.args.at(-1), '/repos/acme/web/actions/jobs/9/logs');
    assert.equal(flagValue(call.args, '--method'), 'GET');
    assert.ok(call.args.includes('--allow-escape-sequences'));
    assert.ok(!call.args.some((arg) => /^if-none-match/i.test(arg)));
    assert.ok((call.maxOutputBytes ?? 0) >= 32 * 1024 * 1024);
  });

  for (const [status, why] of [
    ['404 Not Found', 'GitHub has no log of it (404)'],
    ['410 Gone', 'it has expired (410)'],
    ['403 Forbidden', "gh's login may not read it (403)"],
    ['500 Internal Server Error', 'GitHub answered 500'],
  ] as const) {
    it(`says why a log it cannot read could not be read: ${status}`, async () => {
      const { reader } = logReaderWith({
        stdout: blob(status, '{"message":"x"}'),
        stderr: 'gh: HTTP error',
        exitCode: 1,
      });
      assert.deepStrictEqual(await reader.log(pullRequest, 9), { unread: why });
    });
  }

  it('says a log came back empty when gh refuses to print its escape sequences', async () => {
    const { reader } = logReaderWith({
      stdout: blob('200 OK', ''),
      stderr:
        'the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway\n',
      exitCode: 1,
    });
    assert.deepStrictEqual(await reader.log(pullRequest, 9), { unread: 'it came back empty' });
  });

  it('says a log longer than its limit could not be read', async () => {
    const { reader } = logReaderWith('too long');
    assert.deepStrictEqual(await reader.log(pullRequest, 9), {
      unread:
        "GitHub's answer to GET /repos/acme/web/actions/jobs/9/logs is longer than 33554432 bytes",
    });
  });

  it("says why a read that failed could not be read: its error's first line, cut, never a secret", async () => {
    const said = async (error: Error) => {
      const log = await logReaderWith(error).reader.log(pullRequest, 9);
      assert.ok('unread' in log, JSON.stringify(log));
      return log.unread;
    };
    assert.equal(await said(new Error('spawn gh ENOENT\nat somewhere')), 'spawn gh ENOENT');
    assert.equal(await said(new Error('')), 'its read failed');
    const token = ['ghp', 'C'.repeat(36)].join('_');
    assert.equal(
      await said(new Error(`gh: bad credentials ${token}`)),
      'its read failed with an error that looks like a secret',
    );
    // An emoji whose first half is the 200th character is left out whole.
    const long = await said(new Error(`${'x'.repeat(MAX_LOG_UNREAD_LENGTH - 1)}${'🍺'.repeat(5)}`));
    assert.equal(long, 'x'.repeat(MAX_LOG_UNREAD_LENGTH - 1));
  });

  it("throws GitHub's rate limit, so the pass reads the log again after the pause", async () => {
    const { reader } = logReaderWith({
      stdout:
        'HTTP/1.1 429 Too Many Requests\nContent-Type: application/json\r\nRetry-After: 60\r\n\r\n{"message":"slow down"}',
      stderr: 'gh: HTTP 429\n',
      exitCode: 1,
    });
    await assert.rejects(reader.log(pullRequest, 9), GitHubRateLimited);
  });

  it('throws a read its pass stopped, never an unread line', async () => {
    const stop = new AbortController();
    const stopped = new Error('the pass was given up');
    const exec: ExecProcess = async () => {
      stop.abort(stopped);
      return { exitCode: null, stdout: '', stderr: '', output: '', killed: 'stopped' };
    };
    const client = createGitHubClient({ exec });
    const reader = githubCheckReader(createGitHubReads(client), client);
    await assert.rejects(reader.log(pullRequest, 9, stop.signal), stopped);
  });

  it('refuses an answer that is not a list of checks, and a head that is no commit sha', async () => {
    const odd = readerWith([{ status: 200, body: { check_runs: 'none' } }]);
    await assert.rejects(odd.reader.checks(pullRequest, head), /not what it should be/);
    const refused = readerWith([runsPage([]), { status: 422, body: { message: 'No commit' } }]);
    await assert.rejects(refused.reader.checks(pullRequest, head), /422.*No commit/);
    await assert.rejects(readerWith([]).reader.checks(pullRequest, '../../x'), /commit/);
  });
});
