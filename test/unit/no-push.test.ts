// The noPush guard's pure core (ADR 0106): which refs of a remote changed between the reads before
// and after an attempt, and how the guard names them.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changedRefs, noPushReason, parseRemoteRefs } from '../../src/checks/no-push.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const refs = (entries: Record<string, string>) => new Map(Object.entries(entries));
const none = () => false;

describe('parseRemoteRefs', () => {
  it('reads each ref with its commit, CRLF or not, sha-1 or sha-256', () => {
    const sha256 = 'd'.repeat(64);
    const listed = `${A}\trefs/heads/main\r\n${B}\trefs/tags/v1\n${sha256}\trefs/heads/x/y\n`;
    assert.deepEqual(
      parseRemoteRefs(listed),
      refs({ 'refs/heads/main': A, 'refs/tags/v1': B, 'refs/heads/x/y': sha256 }),
    );
    assert.deepEqual(parseRemoteRefs(''), new Map());
  });

  it('refuses output that is not a listing, so a bent read never passes', () => {
    assert.deepEqual(parseRemoteRefs(`${A}\trefs/heads/main\nwarning: redirecting to x\n`), {
      error: 'git ls-remote printed a line that names no ref: warning: redirecting to x',
    });
    assert.deepEqual(parseRemoteRefs(`${A}\trefs/heads/main\n${B}\trefs/heads/main\n`), {
      error: 'git ls-remote listed refs/heads/main twice',
    });
  });
});

describe('changedRefs', () => {
  it('finds a ref that moved, one that was created and one that was deleted, by name', () => {
    const before = refs({ 'refs/heads/main': A, 'refs/tags/v1': B, 'refs/heads/keep': C });
    const after = refs({ 'refs/heads/main': B, 'refs/heads/new': C, 'refs/heads/keep': C });
    assert.deepEqual(changedRefs(before, after, none), [
      { ref: 'refs/heads/main', from: A, to: B },
      { ref: 'refs/heads/new', to: C },
      { ref: 'refs/tags/v1', from: B },
    ]);
  });

  it('finds nothing when the remote is as it was', () => {
    const same = refs({ 'refs/heads/main': A });
    assert.deepEqual(changedRefs(same, refs({ 'refs/heads/main': A }), none), []);
  });

  it("leaves out a merge queue's branches, which GitHub writes and nobody can push", () => {
    const before = refs({ 'refs/heads/gh-readonly-queue/main/pr-7-abc': A });
    const after = refs({ 'refs/heads/gh-readonly-queue/main/pr-8-def': B });
    assert.deepEqual(changedRefs(before, after, none), []);
  });

  it("leaves out the refs the engine wrote, and GitHub's own refs/pull/, which nobody can push", () => {
    const before = refs({ 'refs/pull/7/merge': A, 'refs/heads/foedrum/x': A });
    const after = refs({
      'refs/pull/7/merge': B,
      'refs/pull/8/head': C,
      'refs/heads/foedrum/x': B,
      'refs/heads/pull/1': C,
    });
    const engine = (ref: string) => ref === 'refs/heads/foedrum/x';
    assert.deepEqual(changedRefs(before, after, engine), [{ ref: 'refs/heads/pull/1', to: C }]);
  });
});

describe('noPushReason', () => {
  it('names the first ref with both commits, and how many more changed', () => {
    assert.equal(
      noPushReason('acme/api', [{ ref: 'refs/heads/main', from: A, to: B }]),
      `the guard noPush: the remote of acme/api changed during the attempt: refs/heads/main moved from ${A} to ${B}`,
    );
    assert.equal(
      noPushReason('acme/api', [
        { ref: 'refs/heads/new', to: C },
        { ref: 'refs/tags/v1', from: B },
        { ref: 'refs/tags/v2', from: B },
      ]),
      `the guard noPush: the remote of acme/api changed during the attempt: refs/heads/new was created at ${C} (and 2 more)`,
    );
    assert.equal(
      noPushReason('acme/api', [{ ref: 'refs/tags/v1', from: B }]),
      `the guard noPush: the remote of acme/api changed during the attempt: refs/tags/v1 was deleted at ${B}`,
    );
  });

  it('cuts a long ref name, which whoever pushed chose', () => {
    const ref = `refs/heads/${'x'.repeat(500)}`;
    const reason = noPushReason('acme/api', [{ ref, to: C }]);
    assert.ok(reason.length < 400, reason);
    assert.match(reason, /refs\/heads\/x+… was created at c{40}$/);
  });
});
