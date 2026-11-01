// Whether each target repository is public, as GitHub answers (ADR 0300), through a fake `gh`: read
// once, and again only while it could not be read. No network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectKey } from '../../src/engine/effect-key.ts';
import { fold } from '../../src/engine/fold.ts';
import { pullRequestKey } from '../../src/engine/pull-request.ts';
import { siblingSection } from '../../src/engine/sibling-pull-requests.ts';
import { createGitHubClient } from '../../src/github/client.ts';
import { repositoryVisibilities } from '../../src/github/repository-visibility.ts';
import type { Event } from '../../src/schemas/events.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

const clientWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  return { client: createGitHubClient({ exec: ghOver(fake.fetch).exec }), fake };
};

const publicRepo = { status: 200, body: { private: false, visibility: 'public' } };
const privateRepo = { status: 200, body: { private: true, visibility: 'private' } };
const outage = { status: 503, body: { message: 'Service Unavailable' } };

describe('the visibility of the target repositories (ADR 0300)', () => {
  it('reads each repository once, and again only one whose visibility could not be read', async () => {
    const { client, fake } = clientWith([
      publicRepo,
      privateRepo,
      { status: 200, body: { private: true, visibility: 'internal' } },
      outage,
      { status: 404, body: { message: 'Not Found' } },
      { status: 200, body: { visibility: 'public' } },
      publicRepo,
      privateRepo,
    ]);
    const repos = ['acme/web', 'acme/billing', 'acme/staff', 'acme/down', 'acme/gone', 'acme/odd'];
    const visibility = repositoryVisibilities(client, repos);
    assert.equal(visibility.of('acme/web'), 'unknown');
    await visibility.read();
    assert.deepEqual(
      repos.map((repo) => visibility.of(repo)),
      ['public', 'private', 'private', 'unknown', 'unknown', 'unknown'],
    );
    assert.equal(visibility.of('Acme/Web'), 'public');
    assert.equal(visibility.of('acme/other'), 'unknown');
    await visibility.read();
    assert.deepEqual(
      fake.requests.slice(6).map(({ url }) => url),
      [
        'https://api.github.com/repos/acme/down',
        'https://api.github.com/repos/acme/gone',
        'https://api.github.com/repos/acme/odd',
      ],
    );
    assert.equal(visibility.of('acme/down'), 'public');
    assert.equal(visibility.of('acme/gone'), 'private');
  });

  it('names a sibling once a read finds its repository public after one that failed', async () => {
    const opened = (batchId: string, url: string): Event[] => [
      { type: 'effect.applied', key: effectKey.encode(pullRequestKey(batchId)), result: url },
      { type: 'batch.on_tap', batchId, pullRequests: [url] },
    ];
    const ordered = (batchId: string, issue: number): Event => ({
      type: 'batch.ordered',
      batchId,
      order: { issue },
      parentBatchId: '1-1',
      routeBy: '2026-10-31T13:00:00.000Z',
    });
    const state = fold([
      {
        type: 'batch.ordered',
        batchId: '1-1',
        order: { issue: 1 },
        routeBy: '2026-10-31T13:00:00.000Z',
      },
      {
        type: 'order.decomposed',
        batchId: '1-1',
        subOrders: [
          { issue: 3, repo: 'acme/web' },
          { issue: 2, repo: 'acme/lib' },
        ],
        dependencies: [],
      },
      ordered('2-1', 2),
      ordered('3-1', 3),
      ...opened('2-1', 'https://github.com/acme/lib/pull/7'),
      ...opened('3-1', 'https://github.com/acme/web/pull/12'),
    ]);
    const { client } = clientWith([publicRepo, outage, publicRepo]);
    const visibility = repositoryVisibilities(client, ['acme/web', 'acme/lib']);
    await visibility.read();
    const first = siblingSection(state, '3-1', visibility.of) ?? assert.fail('no section');
    assert.doesNotMatch(first, /acme\/lib#7/);
    await visibility.read();
    assert.match(siblingSection(state, '3-1', visibility.of) ?? '', /acme\/lib#7: open/);
  });
});
