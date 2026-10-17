// The order's text (ADR 0063): the body of the batch's issue, through the conditional GitHub reads
// (ADR 0052), from synthetic answers through a fake `fetch`; no network (ADR 0021).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { githubOrderText } from '../../src/github/order-text.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';

const issue = JSON.parse(
  readFileSync(new URL('../fixtures/github/issue.json', import.meta.url), 'utf8'),
) as object;

const orderTextWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({ token: 'ghp_test', fetch: fake.fetch });
  return { orderText: githubOrderText(createGitHubReads(client), 'acme/brewery'), ...fake };
};

describe('githubOrderText', () => {
  it("reads a Brewery issue's body in the Brewery", async () => {
    const { orderText, requests } = orderTextWith([
      { status: 200, body: { ...issue, number: 12, body: 'Add a --json flag.' } },
    ]);
    assert.equal(await orderText({ issue: 12 }), 'Add a --json flag.');
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${url}`),
      ['GET https://api.github.com/repos/acme/brewery/issues/12'],
    );
  });

  it("reads a claimed issue's body in its own repository", async () => {
    const { orderText, requests } = orderTextWith([
      { status: 200, body: { ...issue, body: 'Dark theme, please.' } },
    ]);
    assert.equal(await orderText({ issue: 7, repo: 'acme/web' }), 'Dark theme, please.');
    assert.equal(requests[0]?.url, 'https://api.github.com/repos/acme/web/issues/7');
  });

  it('gives an empty text for an issue without a body', async () => {
    for (const body of [null, undefined]) {
      const { orderText } = orderTextWith([{ status: 200, body: { ...issue, body } }]);
      assert.equal(await orderText({ issue: 7, repo: 'acme/web' }), '');
    }
  });

  it("fails with GitHub's status and message when the issue cannot be read", async () => {
    const { orderText } = orderTextWith([{ status: 404, body: { message: 'Not Found' } }]);
    await assert.rejects(orderText({ issue: 7, repo: 'acme/web' }), {
      message: 'GitHub answered 404 to the issue acme/web#7: Not Found',
    });
  });

  it('fails on an answer that is not an issue, or another issue than asked', async () => {
    for (const body of [{ number: 'seven' }, { ...issue, number: 8, body: 'other' }]) {
      const { orderText } = orderTextWith([{ status: 200, body }]);
      await assert.rejects(orderText({ issue: 7, repo: 'acme/web' }), /the issue acme\/web#7/);
    }
  });
});
