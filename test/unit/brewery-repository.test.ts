// What `foedrum init` does on GitHub (ADR 0207), through a fake `gh`: whether the Brewery's
// repository is there, creating it under the login or an organization, and the intake label of a
// target repository. No network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createLabel,
  createRepository,
  labelExists,
  repositoryExists,
} from '../../src/github/brewery-repository.ts';
import { createGitHubClient } from '../../src/github/client.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

const clientWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  return { client: createGitHubClient({ exec: ghOver(fake.fetch).exec }), fake };
};

const missing = { status: 404, body: { message: 'Not Found' } };

describe('the Brewery repository on GitHub (ADR 0207)', () => {
  it('says whether GitHub has a repository', async () => {
    const { client, fake } = clientWith([
      { status: 200, body: { default_branch: 'main' } },
      missing,
    ]);
    assert.equal(await repositoryExists(client, 'octocat/foedrum-brewery'), true);
    assert.equal(await repositoryExists(client, 'octocat/foedrum-brewery'), false);
    assert.equal(fake.requests[0]?.url, 'https://api.github.com/repos/octocat/foedrum-brewery');
  });

  it('fails on any other answer to whether a repository is there', async () => {
    const { client } = clientWith([{ status: 500, body: { message: 'Server Error' } }]);
    await assert.rejects(repositoryExists(client, 'octocat/foedrum-brewery'), /500.*Server Error/);
  });

  it("creates a private repository under the login, the owner's case aside", async () => {
    const { client, fake } = clientWith([{ status: 201, body: {} }]);
    await createRepository(client, 'OctoCat/foedrum-brewery', 'octocat', true);
    const [request] = fake.requests;
    assert.equal(`${request?.method} ${request?.url}`, 'POST https://api.github.com/user/repos');
    assert.deepStrictEqual(request?.body, { name: 'foedrum-brewery', private: true });
  });

  it('creates a public repository under an organization that is not the login', async () => {
    const { client, fake } = clientWith([{ status: 201, body: {} }]);
    await createRepository(client, 'acme/brewery', 'octocat', false);
    const [request] = fake.requests;
    assert.equal(
      `${request?.method} ${request?.url}`,
      'POST https://api.github.com/orgs/acme/repos',
    );
    assert.deepStrictEqual(request?.body, { name: 'brewery', private: false });
  });

  it("fails with GitHub's message when the repository cannot be created", async () => {
    const { client } = clientWith([
      {
        status: 422,
        body: { message: 'Repository creation failed.', errors: [{ code: 'custom' }] },
      },
    ]);
    await assert.rejects(
      createRepository(client, 'octocat/foedrum-brewery', 'octocat', true),
      /422.*Repository creation failed/,
    );
  });

  it('says whether a repository has a label, by its name in the path', async () => {
    const { client, fake } = clientWith([{ status: 200, body: { name: 'foedrum:brew' } }, missing]);
    assert.equal(await labelExists(client, 'acme/web', 'foedrum:brew'), true);
    assert.equal(await labelExists(client, 'acme/web', 'foedrum:brew'), false);
    assert.equal(
      fake.requests[0]?.url,
      'https://api.github.com/repos/acme/web/labels/foedrum%3Abrew',
    );
  });

  it('creates a label with its description, and counts one made in the meantime as made', async () => {
    const { client, fake } = clientWith([
      { status: 201, body: {} },
      { status: 422, body: { message: 'Validation Failed', errors: [{ code: 'already_exists' }] } },
    ]);
    await createLabel(client, 'acme/web', 'foedrum:brew', 'Brewed by Foedrum');
    await createLabel(client, 'acme/web', 'foedrum:brew', 'Brewed by Foedrum');
    const [request] = fake.requests;
    assert.equal(
      `${request?.method} ${request?.url}`,
      'POST https://api.github.com/repos/acme/web/labels',
    );
    assert.deepStrictEqual(request?.body, {
      name: 'foedrum:brew',
      description: 'Brewed by Foedrum',
      color: 'ededed',
    });
  });

  it('fails when a label cannot be created', async () => {
    const { client } = clientWith([{ status: 403, body: { message: 'Must have admin rights' } }]);
    await assert.rejects(
      createLabel(client, 'acme/web', 'foedrum:brew', 'Brewed by Foedrum'),
      /403.*Must have admin rights/,
    );
  });
  it('fails on a 422 for anything but a label that is there', async () => {
    const { client } = clientWith([
      { status: 422, body: { message: 'Validation Failed', errors: [{ code: 'invalid' }] } },
    ]);
    await assert.rejects(
      createLabel(client, 'acme/web', 'foedrum:brew', 'Brewed by Foedrum'),
      /422.*Validation Failed/,
    );
  });
});
