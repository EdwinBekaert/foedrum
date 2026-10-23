import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aliasOf, nextBatchId, targetBatchId } from '../../src/engine/batch-id.ts';
import { emptyState, fold } from '../../src/engine/fold.ts';
import { PathSafeId } from '../../src/schemas/ids.ts';

const ordered = (batchId: string, issue: number) =>
  ({
    type: 'batch.ordered',
    batchId,
    order: { issue },
    routeBy: '2026-12-31T00:00:00.000Z',
  }) as const;

describe('nextBatchId', () => {
  it('numbers the first batch of an issue 1', () => {
    assert.equal(nextBatchId(emptyState, 42), '42-1');
  });

  it('takes the first number no batch uses yet', () => {
    const state = fold([ordered('42-1', 42), ordered('42-3', 42), ordered('7-2', 7)]);
    assert.equal(nextBatchId(state, 42), '42-2');
    assert.equal(nextBatchId(state, 7), '7-1');
  });

  it('skips an id another issue uses', () => {
    assert.equal(nextBatchId(fold([ordered('42-1', 9)]), 42), '42-2');
  });

  it('gives ids that pass PathSafeId (ADR 0024), up to the largest issue number', () => {
    for (const issue of [1, 42, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      const id = nextBatchId(emptyState, issue);
      assert.ok(PathSafeId.safeParse(id).success, id);
    }
  });

  for (const issue of [0, -1, 1.5, Number.NaN]) {
    it(`refuses issue ${issue}`, () => {
      assert.throws(() => nextBatchId(emptyState, issue), /issue must be a positive integer/);
    });
  }
});

describe('targetBatchId (ADR 0043)', () => {
  const target = (batchId: string, issue: number) =>
    ({ ...ordered(batchId, issue), order: { issue, repo: 'acme/web' } }) as const;

  it('is <alias>-<issue> for the first batch of a target-repository issue', () => {
    assert.equal(targetBatchId(emptyState, 'web', 7), 'web-7');
  });

  it('numbers a later batch of the issue from 2, and skips an id in use', () => {
    assert.equal(targetBatchId(fold([target('web-7', 7)]), 'web', 7), 'web-7-2');
    const state = fold([target('web-7', 7), target('web-7-2', 7), target('web-7-4', 7)]);
    assert.equal(targetBatchId(state, 'web', 7), 'web-7-3');
  });

  it('never gives an id of a Brewery issue, which starts with a digit', () => {
    const state = fold([ordered('7-1', 7)]);
    assert.equal(targetBatchId(state, 'web', 7), 'web-7');
    assert.match(targetBatchId(state, 'web', 7), /^[a-z]/);
  });

  it('gives ids that pass PathSafeId, up to the longest alias and the largest issue number', () => {
    const alias = 'a'.repeat(20);
    const issue = Number.MAX_SAFE_INTEGER;
    const first = targetBatchId(emptyState, alias, issue);
    const later = targetBatchId(fold([target(first, issue)]), alias, issue);
    for (const id of [first, later]) assert.ok(PathSafeId.safeParse(id).success, id);
  });

  for (const alias of ['', 'Web', '1web', 'my-web', 'a'.repeat(21), '../x']) {
    it(`refuses the alias ${JSON.stringify(alias)}`, () => {
      assert.throws(() => targetBatchId(emptyState, alias, 7), /alias must be/);
    });
  }

  for (const issue of [0, -1, 1.5]) {
    it(`refuses issue ${issue}`, () => {
      assert.throws(
        () => targetBatchId(emptyState, 'web', issue),
        /issue must be a positive integer/,
      );
    });
  }
});

describe('aliasOf (ADR 0144)', () => {
  for (const [id, alias] of [
    ['web-7', 'web'],
    ['web-7-2', 'web'],
    ['a1-123-10', 'a1'],
    [`${'a'.repeat(20)}-7`, 'a'.repeat(20)],
  ] as const) {
    it(`reads the alias ${alias} from ${id}`, () => {
      assert.equal(aliasOf(id), alias);
    });
  }
  for (const id of [
    '7-1',
    'web',
    'web-',
    'web-07',
    'web-7-0',
    'web-7-07',
    'Web-7',
    'w_b-7',
    'web-7-2-3',
    'web-7x',
    `${'a'.repeat(21)}-7`,
  ]) {
    it(`reads no alias from ${id}`, () => {
      assert.equal(aliasOf(id), undefined);
    });
  }
});
