// What a claimed issue's history says of it (ADR 0368): its events through the conditional reads
// (ADR 0052), the edits of its body through GraphQL, and its comments, from synthetic answers
// through a fake `fetch`; no network (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGitHubClient } from '../../src/github/client.ts';
import { githubOrderActivity } from '../../src/github/order-activity.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { type Answer, fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

const activityWith = (answers: Answer[]) => {
  const fake = fakeFetch(answers);
  const client = createGitHubClient({ exec: ghOver(fake.fetch).exec });
  return { activity: githubOrderActivity(createGitHubReads(client), client), ...fake };
};

const event = (id: number, more: object) => ({
  id,
  actor: { login: 'ada' },
  created_at: `2026-11-10T10:0${id}:00Z`,
  ...more,
});
const edits = (nodes: object[], hasNextPage = false, lastEditedAt: string | null = null) => ({
  status: 200,
  body: {
    data: {
      repository: {
        issue: { lastEditedAt, userContentEdits: { pageInfo: { hasNextPage }, nodes } },
      },
    },
  },
});
const comment = {
  id: 501,
  user: { login: 'mallory' },
  author_association: 'NONE',
  created_at: '2026-11-10T11:00:00Z',
  updated_at: '2026-11-10T11:30:00Z',
  body: 'And dark mode.',
};

describe('githubOrderActivity', () => {
  it('reads who added each label and when, each change of the title, the edits of the body and every comment', async () => {
    const { activity, requests } = activityWith([
      {
        status: 200,
        body: [
          // Out of order: the events count in the order of their ids.
          event(3, { event: 'renamed', actor: null, rename: { from: 'a', to: 'b' } }),
          event(1, { event: 'labeled', label: { name: 'foedrum:brew' } }),
          event(2, { event: 'assigned' }),
        ],
      },
      edits([
        { editedAt: '2026-11-10T12:00:00Z', editor: { login: 'mallory' } },
        { editedAt: '2026-11-10T09:00:00Z', editor: null },
      ]),
      { status: 200, body: [comment] },
    ]);
    assert.deepStrictEqual(await activity('acme/web', 7), {
      labelled: [{ label: 'foedrum:brew', by: 'ada', at: '2026-11-10T10:01:00Z' }],
      renamed: [{ by: undefined, at: '2026-11-10T10:03:00Z' }],
      edited: [
        { by: 'mallory', at: '2026-11-10T12:00:00Z' },
        { by: undefined, at: '2026-11-10T09:00:00Z' },
      ],
      comments: [
        {
          id: 501,
          by: 'mallory',
          association: 'NONE',
          created: '2026-11-10T11:00:00Z',
          updated: '2026-11-10T11:30:00Z',
          body: 'And dark mode.',
        },
      ],
    });
    assert.deepStrictEqual(
      requests.map(({ method, url }) => `${method} ${url}`),
      [
        'GET https://api.github.com/repos/acme/web/issues/7/events?per_page=100',
        'POST https://api.github.com/graphql',
        'GET https://api.github.com/repos/acme/web/issues/7/comments?per_page=10',
      ],
    );
    assert.deepStrictEqual((requests[1]?.body as { variables?: unknown } | undefined)?.variables, {
      owner: 'acme',
      name: 'web',
      number: 7,
    });
  });

  it('counts the latest edit as by nobody known when the issue has more edits than one page', async () => {
    const { activity } = activityWith([
      { status: 200, body: [] },
      edits(
        [{ editedAt: '2026-11-10T09:00:00Z', editor: { login: 'ada' } }],
        true,
        '2026-11-10T14:00:00Z',
      ),
      { status: 200, body: [] },
    ]);
    const { edited } = await activity('acme/web', 7);
    assert.deepStrictEqual(edited, [
      { by: 'ada', at: '2026-11-10T09:00:00Z' },
      { by: undefined, at: '2026-11-10T14:00:00Z' },
    ]);
  });

  it('fails on a labeled or renamed event without its time, and on GraphQL errors', async () => {
    for (const kind of ['labeled', 'renamed']) {
      const { created_at: _, ...untimed } = event(1, { event: kind, label: { name: 'x' } });
      const { activity } = activityWith([{ status: 200, body: [untimed] }]);
      await assert.rejects(activity('acme/web', 7), /the events of acme\/web#7/);
    }
    const { activity } = activityWith([
      { status: 200, body: [] },
      { status: 200, body: { data: null, errors: [{ message: 'Could not resolve' }] } },
    ]);
    await assert.rejects(activity('acme/web', 7), {
      message: 'GitHub refused the edits of acme/web#7: Could not resolve',
    });
  });

  it('fails on a comment without the time it last changed', async () => {
    const { updated_at: _, ...untimed } = comment;
    const { activity } = activityWith([
      { status: 200, body: [] },
      edits([]),
      { status: 200, body: [untimed] },
    ]);
    await assert.rejects(activity('acme/web', 7), /the comments of acme\/web#7/);
  });
});
