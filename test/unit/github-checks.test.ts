// The checks GitHub runs on an open pull request's head (ADR 0213): its head, then the check runs
// and the commit statuses on it, from synthetic answers in the shape GitHub's REST API gives,
// through a fake `fetch`; no network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { githubCheckReader } from '../../src/github/checks.ts';
import { createGitHubClient } from '../../src/github/client.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

const api = 'https://api.github.com';
const pullRequest = 'https://github.com/acme/web/pull/12';
const head = 'a'.repeat(40);
const runs = `${api}/repos/acme/web/commits/${head}/check-runs?per_page=10`;
const statuses = `${api}/repos/acme/web/commits/${head}/status?per_page=10`;

const readerWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
  return { reader: githubCheckReader(createGitHubReads(client)), requests: fake.requests };
};

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

  it('refuses an answer that is not a list of checks, and a head that is no commit sha', async () => {
    const odd = readerWith([{ status: 200, body: { check_runs: 'none' } }]);
    await assert.rejects(odd.reader.checks(pullRequest, head), /not what it should be/);
    const refused = readerWith([runsPage([]), { status: 422, body: { message: 'No commit' } }]);
    await assert.rejects(refused.reader.checks(pullRequest, head), /422.*No commit/);
    await assert.rejects(readerWith([]).reader.checks(pullRequest, '../../x'), /commit/);
  });
});
