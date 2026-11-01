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
import type { Answer } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';

/**
 * A client whose answers come by repository, each list in order, so reads that run at once get the
 * answers meant for them; `held` repositories answer only once `release` is called.
 */
const clientByRepo = (answers: Record<string, Answer[]>, held: readonly string[] = []) => {
  const asked: string[] = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = async (input: string | URL | Request) => {
    const repo = new URL(String(input)).pathname.replace(/^\/repos\//, '');
    asked.push(repo);
    if (held.includes(repo)) await released;
    const answer = answers[repo]?.shift() ?? assert.fail(`no answer for ${repo}`);
    if (answer === 'hang') return assert.fail('no hang here');
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createGitHubClient({
    exec: ghOver(fetch as typeof globalThis.fetch).exec,
  });
  return { client, asked, release: () => release() };
};

const publicRepo = { status: 200, body: { private: false, visibility: 'public' } };
const privateRepo = { status: 200, body: { private: true, visibility: 'private' } };
const outage = { status: 503, body: { message: 'Service Unavailable' } };
const missing = { status: 404, body: { message: 'Not Found' } };

describe('the visibility of the target repositories (ADR 0300)', () => {
  it('reads each repository once, and again only one whose visibility could not be read', async () => {
    const { client, asked } = clientByRepo({
      'acme/web': [publicRepo],
      'acme/billing': [privateRepo],
      'acme/staff': [{ status: 200, body: { private: true, visibility: 'internal' } }],
      'acme/down': [outage, publicRepo],
      'acme/gone': [missing],
      'acme/odd': [{ status: 200, body: { visibility: 'public' } }, privateRepo],
    });
    const repos = ['acme/web', 'acme/billing', 'acme/staff', 'acme/down', 'acme/gone', 'acme/odd'];
    const visibility = repositoryVisibilities(client, repos);
    assert.equal(visibility.of('acme/web'), 'unknown');
    await visibility.read();
    assert.deepEqual(
      repos.map((repo) => visibility.of(repo)),
      ['public', 'private', 'internal', 'unknown', 'unknown', 'unknown'],
    );
    assert.equal(visibility.of('Acme/Web'), 'public');
    assert.equal(visibility.of('acme/other'), 'unknown');
    await visibility.read();
    // A repository GitHub does not find is one the login cannot see: read once, and unknown, so it
    // is hidden as a sibling and hides its siblings as a pull request's own.
    assert.deepEqual(asked.slice(6).sort(), ['acme/down', 'acme/odd']);
    assert.equal(visibility.of('acme/down'), 'public');
    assert.equal(visibility.of('acme/odd'), 'private');
  });

  it('reads every repository it does not know at once, so one slow answer holds up no other', async () => {
    const { client, asked, release } = clientByRepo(
      { 'acme/slow': [publicRepo], 'acme/fast': [privateRepo] },
      ['acme/slow'],
    );
    const visibility = repositoryVisibilities(client, ['acme/slow', 'acme/fast']);
    const reading = visibility.read();
    for (let turn = 0; turn < 50 && asked.length < 2; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const askedBeforeRelease = [...asked];
    release();
    await reading;
    assert.deepEqual(askedBeforeRelease.sort(), ['acme/fast', 'acme/slow']);
    assert.equal(visibility.of('acme/slow'), 'public');
    assert.equal(visibility.of('acme/fast'), 'private');
  });

  it('reads public only when GitHub answers 200, not private, and public or no visibility (regression test)', async () => {
    const { client } = clientByRepo({
      'acme/bare': [{ status: 200, body: { private: false } }],
      'acme/odd': [{ status: 200, body: { private: false, visibility: 'private' } }],
      'acme/flaky': [{ status: 500, body: { private: false, visibility: 'public' } }],
      'acme/old': [{ status: 200, body: { private: true } }],
      'acme/mixed': [{ status: 200, body: { private: true, visibility: 'public' } }],
    });
    const repos = ['acme/bare', 'acme/odd', 'acme/flaky', 'acme/old', 'acme/mixed'];
    const visibility = repositoryVisibilities(client, repos);
    await visibility.read();
    assert.deepEqual(
      repos.map((repo) => visibility.of(repo)),
      ['public', 'private', 'unknown', 'private', 'private'],
    );
  });

  it('gives up a read when its signal aborts, rather than counting it unknown (regression test)', async () => {
    const { client } = clientByRepo({ 'acme/web': [publicRepo] }, ['acme/web']);
    const visibility = repositoryVisibilities(client, ['acme/web']);
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    await assert.rejects(visibility.read(stop.signal), /stopped/);
    assert.equal(visibility.of('acme/web'), 'unknown');
  });

  it('keeps a repository foedrum.jsonc names in another case under one name (regression test)', async () => {
    const { client, asked } = clientByRepo({ 'Acme/Web': [publicRepo] });
    const visibility = repositoryVisibilities(client, ['Acme/Web']);
    await visibility.read();
    assert.equal(visibility.of('acme/web'), 'public');
    await visibility.read();
    assert.deepEqual(asked, ['Acme/Web']);
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
    const { client } = clientByRepo({ 'acme/web': [publicRepo], 'acme/lib': [outage, publicRepo] });
    const visibility = repositoryVisibilities(client, ['acme/web', 'acme/lib']);
    await visibility.read();
    const first = siblingSection(state, '3-1', visibility.of) ?? assert.fail('no section');
    assert.doesNotMatch(first, /acme\/lib#7/);
    await visibility.read();
    assert.match(siblingSection(state, '3-1', visibility.of) ?? '', /acme\/lib#7: open/);
  });
});
