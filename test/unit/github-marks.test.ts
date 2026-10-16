// The marks of a claimed issue on GitHub (ADR 0043, ADR 0050): assignee, label and the Brewery's
// own comments, from synthetic answers in the shape GitHub's REST API gives
// (test/fixtures/github/), through a fake `fetch`; no network (ADR 0021).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { IssueMarks } from '../../src/engine/claim-effects.ts';
import { createGitHubClient } from '../../src/github/client.ts';
import { githubIssueMarks } from '../../src/github/marks.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/github/${name}.json`, import.meta.url), 'utf8'));

const api = 'https://api.github.com';
const repo = 'acme/web';
/**
 * How many of the longest bodies GitHub keeps (65,536 characters, 6 bytes each as `\u` escapes)
 * fit in the client's 4 MiB answer limit.
 */
const longestFit = Math.floor((4 * 1024 * 1024) / (65_536 * 6 + 4096));
const perPage = (url: string | undefined): number =>
  Number(new URL(url ?? 'https://x').searchParams.get('per_page'));
const marker = '<!-- foedrum:["web-7","claim.comment"] -->';

const marksWith = (answers: Answer[], login = 'alice') => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({ token: 'ghp_test', fetch: fake.fetch });
  const marks = githubIssueMarks({ client, reads: createGitHubReads(client), login });
  return { marks, requests: fake.requests };
};

const asked = (requests: { method: string; url: string; body: unknown }[]) =>
  requests.map(({ method, url, body }) => ({ method, url, body }));

describe('githubIssueMarks', () => {
  it('reads the assignees and the labels of the issue', async () => {
    const { marks, requests } = marksWith([
      { status: 200, body: fixture('issue') },
      { status: 200, body: fixture('issue') },
    ]);
    assert.deepStrictEqual(await marks.assignees(repo, 7), ['Alice', 'carol']);
    assert.deepStrictEqual(await marks.labels(repo, 7), ['foedrum', 'foedrum:claimed']);
    assert.equal(requests[0]?.url, `${api}/repos/acme/web/issues/7`);
  });

  it('reads assignees given as null as none, and labels given as plain names', async () => {
    const issue = { ...(fixture('issue') as object), assignees: null, labels: ['foedrum'] };
    const { marks } = marksWith([
      { status: 200, body: issue },
      { status: 200, body: issue },
    ]);
    assert.deepStrictEqual(await marks.assignees(repo, 7), []);
    assert.deepStrictEqual(await marks.labels(repo, 7), ['foedrum']);
  });

  it('reads the issue again with its ETag', async () => {
    const { marks, requests } = marksWith([
      { status: 200, body: fixture('issue'), headers: { etag: '"seven"' } },
      { status: 304 },
    ]);
    await marks.assignees(repo, 7);
    assert.deepStrictEqual(await marks.labels(repo, 7), ['foedrum', 'foedrum:claimed']);
    assert.equal(requests[1]?.headers['if-none-match'], '"seven"');
  });

  it('assigns the issue, and fails when GitHub left the assignee out', async () => {
    const { marks, requests } = marksWith([{ status: 201, body: fixture('issue') }], 'Alice');
    await marks.assign(repo, 7, 'alice');
    assert.deepStrictEqual(asked(requests), [
      {
        method: 'POST',
        url: `${api}/repos/acme/web/issues/7/assignees`,
        body: { assignees: ['alice'] },
      },
    ]);
    // GitHub drops an assignee without access to the repository, and answers 201 all the same.
    const dropped = marksWith([{ status: 201, body: fixture('issue') }]);
    await assert.rejects(dropped.marks.assign(repo, 7, 'dave'), /did not assign dave/);
  });

  it('adds a label', async () => {
    const { marks, requests } = marksWith([{ status: 200, body: [{ name: 'foedrum:claimed' }] }]);
    await marks.addLabel(repo, 7, 'foedrum:claimed');
    assert.deepStrictEqual(asked(requests), [
      {
        method: 'POST',
        url: `${api}/repos/acme/web/issues/7/labels`,
        body: { labels: ['foedrum:claimed'] },
      },
    ]);
  });

  it('removes a label by its encoded name, and counts one that is not there as removed', async () => {
    const { marks, requests } = marksWith([
      { status: 200, body: [] },
      { status: 404, body: { message: 'Label does not exist' } },
    ]);
    await marks.removeLabel(repo, 7, 'foedrum:claimed');
    await marks.removeLabel(repo, 7, 'foedrum:claimed');
    assert.deepStrictEqual(
      requests.map(({ method, url }) => [method, url]),
      [
        ['DELETE', `${api}/repos/acme/web/issues/7/labels/foedrum%3Aclaimed`],
        ['DELETE', `${api}/repos/acme/web/issues/7/labels/foedrum%3Aclaimed`],
      ],
    );
  });

  it('fails to remove a label from an issue that is not there', async () => {
    const { marks } = marksWith([{ status: 404, body: { message: 'Not Found' } }]);
    await assert.rejects(marks.removeLabel(repo, 7, 'foedrum:claimed'), /404 .*Not Found/);
  });

  it('finds only a comment of its own login that carries the marker', async () => {
    const { marks, requests } = marksWith([{ status: 200, body: fixture('comments') }]);
    // mallory's comment 501 carries the marker too, and comes first.
    assert.equal(await marks.findComment(repo, 7, marker), 502);
    assert.equal(requests[0]?.url, `${api}/repos/acme/web/issues/7/comments?per_page=10`);
    const other = marksWith([{ status: 200, body: fixture('comments') }], 'bob');
    assert.equal(await other.marks.findComment(repo, 7, marker), undefined);
  });

  it('asks for pages small enough that a page of the longest comments stays under the answer limit', async () => {
    const { marks, requests } = marksWith([{ status: 200, body: [] }]);
    await marks.findComment(repo, 7, marker);
    // Anyone may comment on a public repository: long comments must not stop the claim's
    // effects.
    assert.ok(perPage(requests[0]?.url) >= 1);
    assert.ok(perPage(requests[0]?.url) <= longestFit, `per_page ${perPage(requests[0]?.url)}`);
  });

  it('skips its own comments that carry another marker or none', async () => {
    const own = (id: number, body: string) => ({ id, user: { login: 'alice' }, body });
    const release = '<!-- foedrum:["web-7","release.comment"] -->';
    const comments = [own(500, 'No marker at all.'), own(501, `Claimed.\n\n${marker}`)];
    const { marks } = marksWith([
      { status: 200, body: comments },
      { status: 200, body: comments },
    ]);
    // The release comment is not posted yet: the claim comment must not stand in for it.
    assert.equal(await marks.findComment(repo, 7, release), undefined);
    assert.equal(await marks.findComment(repo, 7, marker), 501);
  });

  it('finds the comment on a later page', async () => {
    const comments = fixture('comments') as unknown[];
    const { marks } = marksWith([
      {
        status: 200,
        body: comments.slice(0, 1),
        headers: { link: `<${api}/repositories/42/issues/7/comments?page=2>; rel="next"` },
      },
      { status: 200, body: comments.slice(1) },
    ]);
    assert.equal(await marks.findComment(repo, 7, marker), 502);
  });

  it('comments, and answers the new comment id', async () => {
    const { marks, requests } = marksWith([{ status: 201, body: { id: 504, body: 'Hello' } }]);
    assert.equal(await marks.comment(repo, 7, 'Hello'), 504);
    assert.deepStrictEqual(asked(requests), [
      { method: 'POST', url: `${api}/repos/acme/web/issues/7/comments`, body: { body: 'Hello' } },
    ]);
  });

  it('fails on an answer it did not expect, naming the issue and never the token', async () => {
    const refusals: [string, (marks: IssueMarks) => Promise<unknown>][] = [
      ['assignees', (marks) => marks.assignees(repo, 7)],
      ['assign', (marks) => marks.assign(repo, 7, 'alice')],
      ['labels', (marks) => marks.labels(repo, 7)],
      ['addLabel', (marks) => marks.addLabel(repo, 7, 'foedrum:claimed')],
      ['removeLabel', (marks) => marks.removeLabel(repo, 7, 'foedrum:claimed')],
      ['findComment', (marks) => marks.findComment(repo, 7, marker)],
      ['comment', (marks) => marks.comment(repo, 7, 'Hello')],
    ];
    for (const [name, call] of refusals) {
      const { marks } = marksWith([{ status: 410, body: { message: 'Issues are disabled' } }]);
      await assert.rejects(call(marks), (error: Error) => {
        assert.match(error.message, /410 .*acme\/web#7.*Issues are disabled/, name);
        assert.doesNotMatch(error.message, /ghp_test/);
        return true;
      });
    }
  });

  it('fails on a comment id or an issue it cannot read', async () => {
    const noId = marksWith([{ status: 201, body: { body: 'Hello' } }]);
    await assert.rejects(noId.marks.comment(repo, 7, 'Hello'), /acme\/web#7/);
    const broken = marksWith([{ status: 200, body: { assignees: 'alice' } }]);
    await assert.rejects(broken.marks.assignees(repo, 7), /acme\/web#7/);
  });

  it('refuses a repository that is no owner/name or an issue that is no number before asking', async () => {
    const { marks, requests } = marksWith([]);
    await assert.rejects(marks.labels('acme/../x', 7), /owner\/name/);
    await assert.rejects(marks.comment(repo, 0, 'Hello'), /positive integer/);
    assert.equal(requests.length, 0);
  });

  it('stops each call when its signal aborts', async () => {
    const calls: [string, (marks: IssueMarks, signal: AbortSignal) => Promise<unknown>][] = [
      ['assignees', (marks, signal) => marks.assignees(repo, 7, signal)],
      ['assign', (marks, signal) => marks.assign(repo, 7, 'alice', signal)],
      ['labels', (marks, signal) => marks.labels(repo, 7, signal)],
      ['addLabel', (marks, signal) => marks.addLabel(repo, 7, 'foedrum:claimed', signal)],
      ['removeLabel', (marks, signal) => marks.removeLabel(repo, 7, 'foedrum:claimed', signal)],
      ['findComment', (marks, signal) => marks.findComment(repo, 7, marker, signal)],
      ['comment', (marks, signal) => marks.comment(repo, 7, 'Hello', signal)],
    ];
    for (const [name, call] of calls) {
      const { marks, requests } = marksWith(['hang']);
      const controller = new AbortController();
      const calling = call(marks, controller.signal);
      controller.abort(new Error('the effect is past its deadline'));
      await assert.rejects(calling, /past its deadline/, name);
      assert.equal(requests[0]?.signal?.aborted, true, name);
    }
  });
});
