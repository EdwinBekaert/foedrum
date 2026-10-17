// The attempt settings files go with their batch's worktrees (ADR 0063): the cleanup of an ended
// batch removes `<workRoot>/attempt-settings/<batch>/`, and the repair at a driver's start those of
// ended and unknown batches.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptSettingsCleaner } from '../../src/brewers/attempt-settings-cleanup.ts';
import type { Claims } from '../../src/workspace/attempt-worktrees.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const claims = (batches: Record<string, 'live' | 'ended'>): Claims => ({
  batches: new Map(Object.entries(batches)),
  leased: [],
});

describe('attemptSettingsCleaner', () => {
  let dir: TempDir;
  let workRoot: string;
  const folder = (batchId: string) => join(workRoot, 'attempt-settings', batchId);
  const settings = (batchId: string) => {
    mkdirSync(join(folder(batchId), 'brew'), { recursive: true });
    writeFileSync(join(folder(batchId), 'brew', '1.json'), '{}');
  };

  beforeEach(() => {
    dir = makeTempDir('attempt-settings');
    workRoot = join(dir.path, 'work');
  });
  afterEach(() => dir.remove());

  it('is rooted at the attempt settings folder of the work root', () => {
    assert.equal(attemptSettingsCleaner(workRoot).root, join(workRoot, 'attempt-settings'));
  });

  it("removes an ended batch's settings when that batch is cleaned, and nothing else", async () => {
    settings('12-1');
    settings('13-1');
    const report = await attemptSettingsCleaner(workRoot).clean(
      claims({ '12-1': 'ended', '13-1': 'ended' }),
      { batchId: '12-1' },
    );
    assert.deepEqual(report, { done: ['removed attempt settings 12-1'], kept: [], failed: [] });
    assert.equal(existsSync(folder('12-1')), false);
    assert.equal(existsSync(folder('13-1')), true);
  });

  it("keeps a live batch's settings, also when that batch is cleaned", async () => {
    settings('12-1');
    const report = await attemptSettingsCleaner(workRoot).clean(claims({ '12-1': 'live' }), {
      batchId: '12-1',
    });
    assert.deepEqual(report, { done: [], kept: [], failed: [] });
    assert.equal(existsSync(folder('12-1')), true);
  });

  it('repairs: removes the settings of ended and unknown batches, keeps the live ones', async () => {
    for (const batchId of ['12-1', '13-1', 'web-7']) settings(batchId);
    const report = await attemptSettingsCleaner(workRoot).clean(
      claims({ '12-1': 'ended', '13-1': 'live' }),
    );
    assert.deepEqual(report.done.sort(), [
      'removed attempt settings 12-1',
      'removed attempt settings web-7',
    ]);
    assert.deepEqual([report.kept, report.failed], [[], []]);
    assert.equal(existsSync(folder('13-1')), true);
  });

  it('has nothing to do when no attempt wrote settings yet', async () => {
    const report = await attemptSettingsCleaner(workRoot).clean(claims({}));
    assert.deepEqual(report, { done: [], kept: [], failed: [] });
    const scoped = await attemptSettingsCleaner(workRoot).clean(claims({}), { batchId: '12-1' });
    assert.deepEqual(scoped, { done: [], kept: [], failed: [] });
  });

  it('reports what it could not remove and goes on with the next batch', async () => {
    settings('12-1');
    settings('13-1');
    const busy = async (path: string) => {
      if (path === folder('12-1')) throw new Error('EBUSY: resource busy');
    };
    const report = await attemptSettingsCleaner(workRoot, busy).clean(
      claims({ '12-1': 'ended', '13-1': 'ended' }),
    );
    assert.deepEqual(report, {
      done: ['removed attempt settings 13-1'],
      kept: [],
      failed: ['could not clean attempt settings 12-1: EBUSY: resource busy'],
    });
  });
});
