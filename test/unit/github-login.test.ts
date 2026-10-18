// The GitHub login gh uses (ADR 0068, ADR 0073), from `GET /user`, through a fake `gh`; no
// network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { githubLogin } from '../../src/github/login.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

const clientWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  return { client: createGitHubClient({ exec: ghOver(fake.fetch).exec }), fake };
};

describe('githubLogin', () => {
  it('reads the login gh uses from GET /user', async () => {
    const { client, fake } = clientWith([{ status: 200, body: { login: 'ann', id: 1 } }]);
    assert.equal(await githubLogin(client), 'ann');
    assert.deepStrictEqual(
      fake.requests.map(({ method, url }) => `${method} ${url}`),
      ['GET https://api.github.com/user'],
    );
  });

  it('fails on a refusal or an answer without a login, never naming a token', async () => {
    const refused = clientWith([{ status: 401, body: { message: 'Bad credentials' } }]);
    await assert.rejects(
      githubLogin(refused.client),
      /^Error: GitHub answered 401 to the login gh uses: Bad credentials$/,
    );
    for (const body of [{}, { login: '' }, { login: 7 }]) {
      const odd = clientWith([{ status: 200, body }]);
      await assert.rejects(githubLogin(odd.client), /answer to the login gh uses is not/);
    }
  });

  it('stops when its signal aborts', async () => {
    const { client, fake } = clientWith(['hang']);
    const controller = new AbortController();
    const reading = githubLogin(client, controller.signal);
    controller.abort(new Error('serve was stopped'));
    await assert.rejects(reading, /serve was stopped/);
    assert.equal(fake.requests[0]?.signal?.aborted, true);
  });
});
