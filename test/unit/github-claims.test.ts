// The GitHub side of a claim (ADR 0043): the claim ref created through the REST API, read back
// with its commit's message, and deleted through GraphQL `updateRefs` only while it still points
// at the commit that was read. A fake `fetch` with canned answers; no network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_TREE, githubClaimHost } from '../../src/github/claims.ts';
import { createGitHubClient } from '../../src/github/client.ts';

const repo = 'acme/web';
const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const message = '{"brewery":"alice/brewery","issue":7,"claimedAt":"2026-10-16T09:00:00.000Z"}';

interface Request {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}
type Answer = { status: number; body?: unknown } | 'hang';

/** A `fetch` that answers each request with the next answer, recording what it was asked. */
const fakeFetch = (answers: Answer[]) => {
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({
      method: init.method ?? 'GET',
      url: String(input),
      headers,
      body,
      signal: init.signal ?? undefined,
    });
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`no answer for ${init.method} ${String(input)}`);
    if (answer === 'hang') {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
};

const hostWith = (answers: Answer[], timeoutMs?: number) => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({
    token: 'ghp_test',
    fetch: fake.fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { host: githubClaimHost(client), requests: fake.requests };
};

const refAt = (at: string) => ({
  status: 200,
  body: { ref: 'refs/foedrum/claims/issues/7', object: { type: 'commit', sha: at } },
});
const commit = (at: string, text = message) => ({ status: 200, body: { sha: at, message: text } });
const repositoryId = { status: 200, body: { data: { repository: { id: 'R_kgDOacme' } } } };
const deleted = { status: 200, body: { data: { updateRefs: { clientMutationId: null } } } };
const failed = { status: 200, body: { errors: [{ message: 'Something went wrong' }] } };

describe('githubClaimHost', () => {
  describe('create', () => {
    it('makes a parentless commit of the empty tree with the record, then the ref to it', async () => {
      const { host, requests } = hostWith([
        { status: 201, body: { sha } },
        { status: 201, body: { ref: 'refs/foedrum/claims/issues/7', object: { sha } } },
      ]);
      assert.equal(await host.create(repo, 7, message), 'created');
      assert.deepStrictEqual(
        requests.map(({ method, url, body }) => ({ method, url, body })),
        [
          {
            method: 'POST',
            url: 'https://api.github.com/repos/acme/web/git/commits',
            body: { message, tree: EMPTY_TREE, parents: [] },
          },
          {
            method: 'POST',
            url: 'https://api.github.com/repos/acme/web/git/refs',
            body: { ref: 'refs/foedrum/claims/issues/7', sha },
          },
        ],
      );
    });

    it('authenticates with the token and names the API version', async () => {
      const { host, requests } = hostWith([{ status: 201, body: { sha } }, { status: 201 }]);
      await host.create(repo, 7, message);
      const headers: Record<string, string> = requests[0]?.headers ?? {};
      assert.equal(headers.authorization, 'Bearer ghp_test');
      assert.equal(headers.accept, 'application/vnd.github+json');
      assert.equal(headers['x-github-api-version'], '2022-11-28');
      assert.match(headers['user-agent'] ?? '', /^foedrum/);
    });

    it('says the ref exists when GitHub refuses it as one that does', async () => {
      const { host } = hostWith([
        { status: 201, body: { sha } },
        { status: 422, body: { message: 'Reference already exists' } },
      ]);
      assert.equal(await host.create(repo, 7, message), 'exists');
    });

    it('fails on any other refusal, naming the status and never the token', async () => {
      for (const answer of [
        { status: 422, body: { message: 'Validation Failed' } },
        { status: 403, body: { message: 'Resource not accessible by personal access token' } },
      ]) {
        const { host } = hostWith([{ status: 201, body: { sha } }, answer]);
        await assert.rejects(host.create(repo, 7, message), (error: Error) => {
          assert.match(error.message, new RegExp(`${answer.status}`));
          assert.doesNotMatch(error.message, /ghp_test/);
          return true;
        });
      }
    });

    it('fails when the commit cannot be made, before it tries the ref', async () => {
      const { host, requests } = hostWith([{ status: 404, body: { message: 'Not Found' } }]);
      await assert.rejects(host.create(repo, 7, message), /404/);
      assert.equal(requests.length, 1);
    });

    it('fails on a commit answer without a sha', async () => {
      const { host } = hostWith([{ status: 201, body: { sha: 'not a sha' } }]);
      await assert.rejects(host.create(repo, 7, message), /answer/);
    });
  });

  describe('read', () => {
    it('reads the commit the ref points at and its message', async () => {
      const { host, requests } = hostWith([refAt(sha), commit(sha)]);
      assert.deepStrictEqual(await host.read(repo, 7), { sha, message });
      assert.deepStrictEqual(
        requests.map(({ url }) => url),
        [
          'https://api.github.com/repos/acme/web/git/ref/foedrum/claims/issues/7',
          `https://api.github.com/repos/acme/web/git/commits/${sha}`,
        ],
      );
    });

    it('answers undefined when there is no ref', async () => {
      const { host } = hostWith([{ status: 404, body: { message: 'Not Found' } }]);
      assert.equal(await host.read(repo, 7), undefined);
    });

    it('answers no message for a ref that points at something other than a commit', async () => {
      const { host, requests } = hostWith([
        {
          status: 200,
          body: { ref: 'refs/foedrum/claims/issues/7', object: { type: 'tag', sha } },
        },
      ]);
      assert.deepStrictEqual(await host.read(repo, 7), { sha, message: '' });
      assert.equal(requests.length, 1);
    });

    it('fails on an answer that is not a ref', async () => {
      const { host } = hostWith([
        { status: 200, body: [{ ref: 'refs/foedrum/claims/issues/70' }] },
      ]);
      await assert.rejects(host.read(repo, 7), /answer/);
    });
  });

  describe('delete', () => {
    it('deletes the ref through updateRefs only from the commit it was read at', async () => {
      const { host, requests } = hostWith([repositoryId, deleted]);
      assert.equal(await host.delete(repo, 7, sha), true);
      const [lookup, update] = requests;
      assert.ok(lookup !== undefined && update !== undefined);
      assert.equal(update.url, 'https://api.github.com/graphql');
      assert.match(JSON.stringify(lookup.body), /repository\(owner: \$owner, name: \$name\)/);
      assert.deepStrictEqual((lookup.body as { variables: unknown }).variables, {
        owner: 'acme',
        name: 'web',
      });
      const { query, variables } = update.body as { query: string; variables: unknown };
      assert.match(query, /updateRefs/);
      assert.deepStrictEqual(variables, {
        input: {
          repositoryId: 'R_kgDOacme',
          refUpdates: [
            {
              name: 'refs/foedrum/claims/issues/7',
              beforeOid: sha,
              afterOid: '0'.repeat(40),
              force: false,
            },
          ],
        },
      });
    });

    it('looks the repository id up once', async () => {
      const { host, requests } = hostWith([repositoryId, deleted, deleted]);
      await host.delete(repo, 7, sha);
      await host.delete(repo, 8, sha);
      assert.equal(requests.length, 3);
    });

    it('answers false when the update failed because the ref moved or is gone', async () => {
      const moved = hostWith([repositoryId, failed, refAt(other), commit(other)]);
      assert.equal(await moved.host.delete(repo, 7, sha), false);
      const gone = hostWith([repositoryId, failed, { status: 404 }]);
      assert.equal(await gone.host.delete(repo, 7, sha), false);
    });

    it('fails when the update failed and the ref still points at the commit', async () => {
      const { host } = hostWith([repositoryId, failed, refAt(sha), commit(sha)]);
      await assert.rejects(host.delete(repo, 7, sha), /Something went wrong/);
    });

    it('refuses a sha that is no full commit sha before asking GitHub', async () => {
      const { host, requests } = hostWith([]);
      await assert.rejects(host.delete(repo, 7, 'abc'), /sha/);
      assert.equal(requests.length, 0);
    });
  });

  it('refuses a repository that is no owner/name before asking GitHub', async () => {
    const { host, requests } = hostWith([]);
    await assert.rejects(host.read('acme', 7), /owner\/name/);
    await assert.rejects(host.create('acme/../x', 7, message), /owner\/name/);
    assert.equal(requests.length, 0);
  });

  it('hands every request the caller signal, and stops at it', async () => {
    const { host, requests } = hostWith(['hang']);
    const controller = new AbortController();
    const reading = host.read(repo, 7, controller.signal);
    controller.abort(new Error('past its deadline'));
    await assert.rejects(reading, /past its deadline/);
    assert.equal(requests[0]?.signal?.aborted, true);
  });

  it('gives up a request GitHub does not answer within its timeout', async () => {
    const { host } = hostWith(['hang'], 20);
    await assert.rejects(host.read(repo, 7), /did not answer within 20 ms/);
  });

  it('gives up an answer longer than its limit, as the process runner does (ADR 0035)', async () => {
    const fake = fakeFetch([refAt(sha), commit(sha, 'x'.repeat(200))]);
    const client = createGitHubClient({
      token: 'ghp_test',
      fetch: fake.fetch,
      maxResponseBytes: 128,
    });
    await assert.rejects(githubClaimHost(client).read(repo, 7), /longer than 128 bytes/);
  });
});
