import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planOwnGitDirs } from '../../src/workspace/attempt-worktrees.ts';

describe('planOwnGitDirs', () => {
  // One hour (ADR 0130).
  const FLOOR_MS = 3_600_000;
  const now = 1_800_000_000_000;
  const uuid = '0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d';
  const other = 'f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b';
  const dir = (name: string, ageMs: number) => ({
    name,
    directory: true,
    modifiedMs: now - ageMs,
  });

  it('removes a <uuid>.git directory older than the floor', () => {
    assert.deepEqual(planOwnGitDirs([dir(`${uuid}.git`, FLOOR_MS + 1)], now), [`${uuid}.git`]);
  });

  it('keeps one no older than the floor, which a running call may still use', () => {
    const entries = [dir(`${uuid}.git`, FLOOR_MS), dir(`${other}.git`, 0)];
    assert.deepEqual(planOwnGitDirs(entries, now), []);
  });

  it('keeps one whose time is ahead of the clock', () => {
    assert.deepEqual(planOwnGitDirs([dir(`${uuid}.git`, -FLOOR_MS * 2)], now), []);
  });

  it('leaves a file or a link of that name alone, however old', () => {
    const old = FLOOR_MS * 10;
    const entries = [{ ...dir(`${uuid}.git`, old), directory: false }];
    assert.deepEqual(planOwnGitDirs(entries, now), []);
  });

  it('leaves every other name alone, however old', () => {
    const old = FLOOR_MS * 10;
    const names = [
      uuid,
      `${uuid}.git.lock`,
      `${uuid.toUpperCase()}.git`,
      `x${uuid}.git`,
      'base',
      'notes.git',
      '.git',
    ];
    assert.deepEqual(
      planOwnGitDirs(
        names.map((name) => dir(name, old)),
        now,
      ),
      [],
    );
  });

  it('names each old one among the rest, in order', () => {
    const old = FLOOR_MS * 2;
    const entries = [dir(`${uuid}.git`, old), dir('base', old), dir(`${other}.git`, old)];
    assert.deepEqual(planOwnGitDirs(entries, now), [`${uuid}.git`, `${other}.git`]);
  });
});
