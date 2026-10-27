// The status comments of a Brewery's issues on GitHub (ADR 0072): found, read, made and edited as
// the Brewery's own login, from synthetic answers in the shape GitHub's REST API gives
// (test/fixtures/github/), through a fake `gh` over a fake `fetch`; no network (ADR 0021, ADR 0073).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { githubStatusComments } from '../../src/github/status-comments.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

const api = 'https://api.github.com';
const repo = 'acme/brewery';
const marker = '<!-- foedrum:["7-1","status.2"] -->';
const own = (id: number, body: string, login = 'Alice') => ({ id, user: { login }, body });

const commentsWith = (answers: Answer[], login = 'alice') => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
  const comments = githubStatusComments({ client, reads: createGitHubReads(client), login });
  return { comments, requests: fake.requests };
};

const asked = (requests: { method: string; url: string; body: unknown }[]) =>
  requests.map(({ method, url, body }) => ({ method, url, body }));

describe('githubStatusComments', () => {
  it("finds the Brewery's own comment whose body ends with the marker, on any page", async () => {
    const { comments, requests } = commentsWith([
      {
        status: 200,
        body: [own(500, `Planted\n\n${marker}`, 'mallory'), own(501, `${marker} and more`)],
        headers: { link: `<${api}/repositories/42/issues/7/comments?page=2>; rel="next"` },
      },
      {
        status: 200,
        body: [{ id: 502, user: null, body: marker }, own(503, `Status\n\n${marker}`)],
      },
    ]);
    assert.deepStrictEqual(await comments.find(repo, 7, marker), {
      id: 503,
      body: `Status\n\n${marker}`,
    });
    assert.equal(requests[0]?.url, `${api}/repos/acme/brewery/issues/7/comments?per_page=10`);
  });

  it('finds nothing when no comment of its own ends with the marker', async () => {
    const { comments } = commentsWith([{ status: 200, body: [own(501, 'No marker.')] }]);
    assert.equal(await comments.find(repo, 7, marker), undefined);
  });

  it("reads a comment of its own by its id, and nothing of someone else's or of one gone", async () => {
    const { comments, requests } = commentsWith([
      { status: 200, body: own(501, 'Status') },
      { status: 200, body: own(502, 'Planted', 'mallory') },
      { status: 404, body: { message: 'Not Found' } },
    ]);
    assert.equal(await comments.read(repo, 501), 'Status');
    assert.equal(await comments.read(repo, 502), undefined);
    assert.equal(await comments.read(repo, 503), undefined);
    assert.equal(requests[0]?.url, `${api}/repos/acme/brewery/issues/comments/501`);
  });

  it('reads a comment again with its ETag', async () => {
    const { comments, requests } = commentsWith([
      { status: 200, body: own(501, 'Status'), headers: { etag: '"501"' } },
      { status: 304 },
    ]);
    await comments.read(repo, 501);
    assert.equal(await comments.read(repo, 501), 'Status');
    assert.equal(requests[1]?.headers['if-none-match'], '"501"');
  });

  it('comments on the issue and answers the new id', async () => {
    const { comments, requests } = commentsWith([{ status: 201, body: own(504, 'Status') }]);
    assert.equal(await comments.create(repo, 7, 'Status'), 504);
    assert.deepStrictEqual(asked(requests), [
      {
        method: 'POST',
        url: `${api}/repos/acme/brewery/issues/7/comments`,
        body: { body: 'Status' },
      },
    ]);
  });

  it('edits a comment by its id, and says when it is gone', async () => {
    const { comments, requests } = commentsWith([
      { status: 200, body: own(501, 'New') },
      { status: 404, body: { message: 'Not Found' } },
    ]);
    assert.equal(await comments.edit(repo, 501, 'New'), 'edited');
    assert.equal(await comments.edit(repo, 502, 'New'), 'gone');
    assert.deepStrictEqual(asked(requests).slice(0, 1), [
      {
        method: 'PATCH',
        url: `${api}/repos/acme/brewery/issues/comments/501`,
        body: { body: 'New' },
      },
    ]);
  });

  it('fails on an answer it did not expect, naming the repository and never the token', async () => {
    const { comments } = commentsWith([
      { status: 500, body: { message: 'Server Error' } },
      { status: 422, body: { message: 'Body is too long' } },
      { status: 403, body: { message: 'Resource not accessible' } },
    ]);
    await assert.rejects(comments.read(repo, 501), /500.*acme\/brewery.*Server Error/);
    await assert.rejects(comments.edit(repo, 501, 'x'), /422.*acme\/brewery.*Body is too long/);
    await assert.rejects(comments.create(repo, 7, 'x'), (error: Error) => {
      assert.match(error.message, /403.*acme\/brewery#7/);
      assert.doesNotMatch(error.message, /ghp_test/);
      return true;
    });
  });

  it('refuses a comment id that is no positive integer before it asks GitHub', async () => {
    const { comments, requests } = commentsWith([]);
    await assert.rejects(comments.read(repo, 0), /comment id/);
    await assert.rejects(comments.edit(repo, 1.5, 'x'), /comment id/);
    assert.deepStrictEqual(requests, []);
  });
});

describe('githubStatusComments: a merge brief hidden as outdated (ADR 0229)', () => {
  const node = (id: number) => ({ ...own(id, 'Brief'), node_id: `IC_${id}` });
  const graphql = `${api}/graphql`;

  it("reads its own comment's node id through REST, then whether GraphQL has it hidden", async () => {
    const { comments, requests } = commentsWith([
      { status: 200, body: node(501) },
      { status: 200, body: { data: { node: { isMinimized: true } } } },
      { status: 200, body: node(502) },
      { status: 200, body: { data: { node: { isMinimized: false } } } },
    ]);
    assert.equal(await comments.hidden(repo, 501), 'hidden');
    assert.equal(await comments.hidden(repo, 502), 'shown');
    const [read, query] = requests;
    assert.equal(read?.url, `${api}/repos/acme/brewery/issues/comments/501`);
    assert.equal(query?.url, graphql);
    assert.ok(query !== undefined);
    const { query: text, variables } = query.body as { query: string; variables: unknown };
    assert.match(text, /isMinimized/);
    assert.deepStrictEqual(variables, { id: 'IC_501' });
  });

  it('says gone for a comment that is not there or not its own, without asking GraphQL', async () => {
    const { comments, requests } = commentsWith([
      { status: 404, body: { message: 'Not Found' } },
      { status: 200, body: { ...node(502), user: { login: 'mallory' } } },
      { status: 404, body: { message: 'Not Found' } },
    ]);
    assert.equal(await comments.hidden(repo, 501), 'gone');
    assert.equal(await comments.hidden(repo, 502), 'gone');
    assert.equal(await comments.hide(repo, 501), 'gone');
    assert.ok(requests.every(({ url }) => url !== graphql));
  });

  it('hides its own comment with minimizeComment as OUTDATED, by its node id', async () => {
    const { comments, requests } = commentsWith([
      { status: 200, body: node(501) },
      {
        status: 200,
        body: { data: { minimizeComment: { minimizedComment: { isMinimized: true } } } },
      },
    ]);
    assert.equal(await comments.hide(repo, 501), 'hidden');
    const mutation = requests[1];
    assert.ok(mutation !== undefined);
    assert.equal(mutation.url, graphql);
    const { query, variables } = mutation.body as { query: string; variables: unknown };
    assert.match(query, /minimizeComment/);
    assert.deepStrictEqual(variables, { input: { subjectId: 'IC_501', classifier: 'OUTDATED' } });
  });

  it('fails on a GraphQL error, an answer it did not expect, or a refused read', async () => {
    const { comments } = commentsWith([
      { status: 200, body: node(501) },
      { status: 200, body: { data: null, errors: [{ message: 'Resource not accessible' }] } },
      { status: 200, body: node(501) },
      { status: 200, body: { data: { node: null }, errors: [{ message: 'Could not resolve' }] } },
      { status: 200, body: node(501) },
      { status: 200, body: { data: { minimizeComment: null } } },
      { status: 500, body: { message: 'Server Error' } },
      { status: 200, body: own(501, 'Brief') },
    ]);
    await assert.rejects(comments.hide(repo, 501), /Resource not accessible/);
    await assert.rejects(comments.hidden(repo, 501), /Could not resolve/);
    await assert.rejects(comments.hide(repo, 501), /not what it should be/);
    await assert.rejects(comments.hidden(repo, 501), /500.*acme\/brewery.*Server Error/);
    // A comment without its node id cannot be hidden.
    await assert.rejects(comments.hide(repo, 501), /no node id/);
  });
});
