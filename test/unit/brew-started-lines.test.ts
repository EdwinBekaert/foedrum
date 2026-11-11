// What `foedrum brew`'s lines say of attempts that started (#873), through runBrew off a terminal: a
// run names the attempts that started since it began, never those of an earlier run. Serve's shell
// with an in-memory store, a fake GitHub and the scripted runner; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runBrew } from '../../src/cli/brew.ts';
import { brewFixture, request, t0 } from '../helpers/brew-fixture.ts';
import { behave } from '../helpers/fake-brewer-runner.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';

describe('runBrew', () => {
  const f = brewFixture();
  const by = { by: 'ann', via: 'terminal' } as const;

  /** Brews to Stuck once, with a failed `step brew`, and retries it; the lines start over. */
  const failedOnceThenRetried = async (): Promise<void> => {
    const first = f.shell(behave.fail(true));
    assert.equal(await runBrew(f.setup, first, request), 3, f.lines.join('\n'));
    assert.ok(
      f.lines.some((line) => line.includes('step brew')),
      f.lines.join('\n'),
    );
    f.log().issue({ kind: 'retry', batchId: '12-1', ...by }, t0);
    f.lines.length = 0;
    f.lock = fakeLock('ann');
  };

  it('foedrum brew names only attempts that started since it began', async () => {
    await failedOnceThenRetried();
    const again = f.shell(behave.succeed());
    assert.equal(await runBrew(f.setup, again, request), 0, f.lines.join('\n'));
    const said = f.lines.join('\n');
    assert.match(said, /step brew \(try 2\) started/);
    assert.doesNotMatch(said, /step brew started/);
  });

  it('names no attempt of the driver it took the batch over from', async () => {
    await failedOnceThenRetried();
    const cellarUntil = new Date(t0.getTime() + 60_000);
    f.store.withTransaction((tx) =>
      tx.putBatchLease({ batchId: '12-1', owner: 'cellar', expiresAt: cellarUntil }),
    );
    // The clock moves on a minute per wait, so the effects' wait for the Cellar's lease ends.
    let now = t0;
    const takes = f.shell(behave.succeed(), {
      clock: () => now,
      wait: async () => {
        now = new Date(now.getTime() + 60_000);
      },
    });
    assert.equal(await runBrew(f.setup, takes, { ...request, take: true }), 0, f.lines.join('\n'));
    const said = f.lines.join('\n');
    assert.match(said, /took #12 over from cellar/);
    assert.match(said, /step brew \(try 2\) started/);
    assert.doesNotMatch(said, /step brew started/);
  });

  it('names no attempt when it comes only to record the ends of an on-tap batch', async () => {
    let merged = false;
    const host = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          {
            number: 12,
            labels: ['recipe:stout'],
            author: 'ann',
            title: 'Add a --json flag',
            body: 'Add a --json flag.',
          },
        ],
      },
      instead: (method, { pathname }) =>
        merged && method === 'GET' && /\/pulls\/\d+$/.test(pathname)
          ? { status: 200, body: { state: 'closed', merged: true } }
          : undefined,
    });
    const gh = ghOver(host.fetch).exec;
    assert.equal(await runBrew(f.setup, f.shell(behave.succeed(), { gh }), request), 0);
    assert.ok(
      f.lines.some((line) => /step brew started/.test(line)),
      f.lines.join('\n'),
    );
    merged = true;
    f.lines.length = 0;
    f.lock = fakeLock('ann');
    assert.equal(
      await runBrew(f.setup, f.shell(behave.succeed(), { gh }), request),
      0,
      f.lines.join('\n'),
    );
    const said = f.lines.join('\n');
    assert.match(said, /merged: /);
    assert.doesNotMatch(said, /started/);
  });
});
