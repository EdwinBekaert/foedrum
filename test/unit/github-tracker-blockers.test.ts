// The repository of an issue another issue is "blocked by" (ADR 0433): GitHub names it only by the
// blocker's `repository_url`, which is untrusted input, so a URL that is no repository of the API is
// refused, naming the issue whose links were read. Synthetic answers through a fake `fetch`; no
// network (ADR 0021).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { githubTargetTracker } from '../../src/github/tracker.ts';
import { fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

const [blocker] = JSON.parse(
  readFileSync(new URL('../fixtures/github/issue-blocked-by.json', import.meta.url), 'utf8'),
) as Record<string, unknown>[];

const blockersOf = (repositoryUrl: string) => {
  const fake = fakeFetch([{ status: 200, body: [{ ...blocker, repository_url: repositoryUrl }] }]);
  const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
  return githubTargetTracker(createGitHubReads(client)).blockers('acme/web', 7);
};

describe('githubTargetTracker.blockers: the repository of a blocker (ADR 0433)', () => {
  it('reads the repository from the last two segments of its repository_url', async () => {
    assert.deepStrictEqual(await blockersOf('https://api.github.com/repos/acme/api'), [
      { repo: 'acme/api', number: 3, state: 'open' },
    ]);
  });

  it('sends API version 2026-03-10 on each read of the links, the ETag too, and none on the listing (ADR 0287)', async () => {
    const fake = fakeFetch([
      { status: 200, body: [blocker], headers: { etag: 'W/"links"' } },
      { status: 304 },
      { status: 200, body: [] },
    ]);
    const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
    const tracker = githubTargetTracker(createGitHubReads(client));
    await tracker.blockers('acme/web', 7);
    await tracker.blockers('acme/web', 7);
    await tracker.issues('acme/web');
    assert.deepStrictEqual(
      fake.requests.map(({ headers }) => [
        headers['x-github-api-version'],
        headers['if-none-match'],
      ]),
      [
        ['2026-03-10', undefined],
        ['2026-03-10', 'W/"links"'],
        ['2022-11-28', undefined],
      ],
    );
  });

  for (const url of [
    'https://api.github.com/repos/acme',
    'https://api.github.com/repos/acme/api/extra',
    'https://api.github.com/repos/acme/..',
    'https://api.github.com/orgs/acme',
  ]) {
    it(`refuses ${url}, naming the issue whose blockers it read`, async () => {
      await assert.rejects(blockersOf(url), /the blockers of acme\/web#7 is not what it should be/);
    });
  }
});
