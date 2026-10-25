// What `foedrum init` reads of a target repository (ADR 0199), through a fake `gh`: its default
// branch, its package.json and whether it has a lockfile on that branch. No network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { repositoryFacts } from '../../src/github/repository-facts.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

const clientWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  return { client: createGitHubClient({ exec: ghOver(fake.fetch).exec }), fake };
};

const file = (text: string) => ({
  status: 200,
  body: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') },
});
const missing = { status: 404, body: { message: 'Not Found' } };
const PACKAGE = '{ "scripts": { "test": "node --test" } }';

describe('repositoryFacts', () => {
  it('reads the default branch, then package.json and the lockfile on it', async () => {
    const { client, fake } = clientWith([
      { status: 200, body: { default_branch: 'trunk' } },
      file(PACKAGE),
      file('{}'),
    ]);
    assert.deepStrictEqual(await repositoryFacts(client, 'acme/web'), {
      base: 'trunk',
      packageJson: PACKAGE,
      lockfile: true,
    });
    assert.deepStrictEqual(
      fake.requests.map(({ method, url }) => `${method} ${url}`),
      [
        'GET https://api.github.com/repos/acme/web',
        'GET https://api.github.com/repos/acme/web/contents/package.json?ref=trunk',
        'GET https://api.github.com/repos/acme/web/contents/package-lock.json?ref=trunk',
      ],
    );
  });

  it('has no package.json and no lockfile where GitHub answers 404', async () => {
    const { client } = clientWith([
      { status: 200, body: { default_branch: 'main' } },
      missing,
      missing,
    ]);
    assert.deepStrictEqual(await repositoryFacts(client, 'acme/api'), {
      base: 'main',
      packageJson: undefined,
      lockfile: false,
    });
  });

  it('fails on a repository GitHub refuses, with its message', async () => {
    const { client } = clientWith([missing]);
    await assert.rejects(
      repositoryFacts(client, 'acme/gone'),
      /^Error: GitHub answered 404 to the repository acme\/gone: Not Found$/,
    );
  });

  it('refuses a name that is not owner/name before it reaches GitHub', async () => {
    const { client, fake } = clientWith([]);
    await assert.rejects(repositoryFacts(client, '../x'), /owner\/name/);
    assert.deepStrictEqual(fake.requests, []);
  });
});
