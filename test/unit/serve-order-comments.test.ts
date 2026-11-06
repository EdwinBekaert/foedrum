// `foedrum serve` hands its brewers the maintainers' comments (ADR 0333): through the driver's wiring
// and the fake host, with the Brewery's login, so Foedrum's own comments on the issue stay out.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runServe } from '../../src/cli/serve.ts';
import { markedComment } from '../../src/engine/claim-effects.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { createGitHubClient } from '../../src/github/client.ts';
import { githubOrderComments } from '../../src/github/order-text.ts';
import { createGitHubReads } from '../../src/github/reads.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { serveFixture } from '../helpers/serve-fixture.ts';

describe('foedrum serve: the order holds the comments', () => {
  const f = serveFixture();

  it("a maintainer's comment reaches the brewer, and a status comment by the same login and a stranger's do not", async () => {
    f.api.comments.set('acme/brewery#12', [
      {
        id: 9001,
        author: 'ann',
        body: markedComment(
          'THE-STATUS-TEXT',
          effectKey.encode({ batchId: '12-1', effect: 'status.1' }),
        ),
      },
      { id: 9002, author: 'mallory', body: 'THE-STRANGER-TEXT', association: 'NONE' },
      { id: 9003, author: 'ann', body: 'THE-MAINTAINER-TEXT', created: '2026-11-05T19:44:00Z' },
    ]);
    assert.equal(await runServe(f.setup, f.shell()), 0);
    const prompt = f.plans[0]?.prompt ?? '';
    assert.match(prompt, /Add a --json flag\./);
    assert.match(
      prompt,
      /source="comment 9003 on Acme\/Brewery#12, by ann \(OWNER\), 2026-11-05T19:44:00Z" name="order">\nTHE-MAINTAINER-TEXT\n/,
    );
    assert.doesNotMatch(prompt, /THE-STATUS-TEXT/);
    assert.doesNotMatch(prompt, /THE-STRANGER-TEXT/);
  });

  it('the comments serve itself posts stay out of what the next attempt reads', async () => {
    assert.equal(await runServe(f.setup, f.shell()), 0);
    // It posted on the issue as the login that reads as OWNER, with nothing else there.
    const posted = f.api.comments.get('acme/brewery#12') ?? [];
    assert.match(posted[0]?.body ?? '', /Foedrum · batch/);
    assert.equal(posted[0]?.author, 'ann');
    const reads = createGitHubReads(createGitHubClient({ exec: ghOver(f.api.fetch).exec }));
    const read = githubOrderComments(reads, 'acme/brewery', 'ann');
    assert.deepEqual(await read([{ issue: 12 }]), []);
  });

  it('a read of the comments that fails does not brew on without them', async () => {
    const failing = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: [], author: 'ann', title: 'Add a --json flag', body: 'Please.' },
        ],
      },
      instead: (method, url) =>
        method === 'GET' && url.pathname.endsWith('/issues/12/comments')
          ? { status: 500, body: { message: 'Server Error' } }
          : undefined,
    });
    await runServe(f.setup, f.shell({ fetch: failing.fetch }));
    assert.deepEqual(f.plans, []);
    const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
    const lane = log.state().batches.get('12-1')?.lane;
    assert.notEqual(lane?.kind, 'on_tap', JSON.stringify(lane));
  });
});
