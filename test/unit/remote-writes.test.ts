// The engine's own writes to the remotes (ADR 0106): what a window on one remote saw the engine
// write, which the noPush guard leaves out.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { notedClaims, notedPush, remoteWrites } from '../../src/checks/remote-writes.ts';
import type { ClaimHost } from '../../src/engine/issue-claims.ts';
import type { BranchPush } from '../../src/engine/pull-request-actions.ts';

const TIP = 'c'.repeat(40);

describe('remoteWrites', () => {
  it('sees the writes made while it was open, also one begun before and ended within', () => {
    const writes = remoteWrites();
    const early = writes.writing('acme/api', 'refs/heads/foedrum/a');
    const done = writes.writing('acme/api', 'refs/heads/foedrum/done');
    done();
    const window = writes.watch('acme/api');
    early();
    writes.writing('ACME/Api', 'refs/heads/foedrum/b')();
    writes.writing('acme/web', 'refs/heads/foedrum/c')();
    assert.deepEqual(window.close(), new Set(['refs/heads/foedrum/a', 'refs/heads/foedrum/b']));
  });

  it('keeps each window to itself, and sees no write after it closed', () => {
    const writes = remoteWrites();
    const first = writes.watch('acme/api');
    writes.writing('acme/api', 'refs/heads/one')();
    const second = writes.watch('acme/api');
    writes.writing('acme/api', 'refs/heads/two')();
    const seen = first.close();
    writes.writing('acme/api', 'refs/heads/three')();
    assert.deepEqual(seen, new Set(['refs/heads/one', 'refs/heads/two']));
    assert.deepEqual(second.close(), new Set(['refs/heads/two', 'refs/heads/three']));
  });
});

describe('notedPush', () => {
  it('notes the branch it pushes while the push runs, also when it fails', async () => {
    const writes = remoteWrites();
    const window = writes.watch('acme/api');
    const pushed: string[] = [];
    const inner: BranchPush = {
      commit: async () => TIP,
      baseTip: async () => TIP,
      isAncestor: async () => false,
      remoteTip: async () => undefined,
      push: async (commit, branch) => {
        pushed.push(`${commit} ${branch}`);
        if (branch.endsWith('bad')) throw new Error('rejected');
      },
      secretScan: async () => [],
    };
    const push = notedPush(inner, writes, 'acme/api');
    await push.push(TIP, 'foedrum/acme.brewery/12-1/acme.api');
    await assert.rejects(push.push(TIP, 'foedrum/acme.brewery/bad'), /rejected/);
    assert.equal(await push.commit('x'), TIP);
    assert.deepEqual(pushed, [
      `${TIP} foedrum/acme.brewery/12-1/acme.api`,
      `${TIP} foedrum/acme.brewery/bad`,
    ]);
    assert.deepEqual(
      window.close(),
      new Set([
        'refs/heads/foedrum/acme.brewery/12-1/acme.api',
        'refs/heads/foedrum/acme.brewery/bad',
      ]),
    );
    // Each write ended with its push: a later window sees neither.
    assert.deepEqual(writes.watch('acme/api').close(), new Set());
  });
});

describe('notedClaims', () => {
  it('notes the claim ref it creates or deletes, not one it only reads', async () => {
    const writes = remoteWrites();
    const window = writes.watch('acme/api');
    const inner: ClaimHost = {
      create: async () => 'created',
      read: async () => undefined,
      delete: async () => true,
    };
    const claims = notedClaims(inner, writes);
    assert.equal(await claims.create('acme/api', 7, 'claim'), 'created');
    assert.equal(await claims.read('acme/api', 8), undefined);
    assert.equal(await claims.delete('acme/api', 9, TIP), true);
    assert.deepEqual(
      window.close(),
      new Set(['refs/foedrum/claims/issues/7', 'refs/foedrum/claims/issues/9']),
    );
    assert.deepEqual(writes.watch('acme/api').close(), new Set());
  });
});
