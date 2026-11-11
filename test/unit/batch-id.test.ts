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
const at = new Date('2026-11-11T14:30:05.678Z');

describe('nextBatchId', () => {
  it('names a batch by its issue and the time it was ordered, in UTC to the second (ADR 0380)', () => {
    assert.equal(nextBatchId(emptyState, 42, at), '42-20261111143005');
    assert.equal(
      nextBatchId(emptyState, 42, new Date('2026-01-02T03:04:05+01:00')),
      '42-20260102020405',
    );
  });

  it('gives a new id with no memory of earlier batches of the issue (ADR 0380)', () => {
    const later = new Date(at.getTime() + 1000);
    assert.equal(nextBatchId(emptyState, 42, later), '42-20261111143006');
  });

  it('takes the first free -<n> from 2 when a batch in the fold has that id (ADR 0380)', () => {
    const state = fold([ordered('42-20261111143005', 42), ordered('42-20261111143005-2', 42)]);
    assert.equal(nextBatchId(state, 42, at), '42-20261111143005-3');
    assert.equal(nextBatchId(state, 7, at), '7-20261111143005');
  });

  it('gives ids that pass PathSafeId (ADR 0024), up to the largest issue number', () => {
    for (const issue of [1, 42, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      const id = nextBatchId(emptyState, issue, at);
      assert.ok(PathSafeId.safeParse(id).success, id);
    }
  });

  for (const issue of [0, -1, 1.5, Number.NaN]) {
    it(`refuses issue ${issue}`, () => {
      assert.throws(() => nextBatchId(emptyState, issue, at), /issue must be a positive integer/);
    });
  }
});

describe('targetBatchId (ADR 0043)', () => {
  const target = (batchId: string, issue: number) =>
    ({ ...ordered(batchId, issue), order: { issue, repo: 'acme/web' } }) as const;

  it('is <alias>-<issue>-<the time it was ordered> for a target-repository issue (ADR 0380)', () => {
    assert.equal(targetBatchId(emptyState, 'web', 7, at), 'web-7-20261111143005');
  });

  it('takes the first free -<n> from 2 when a batch in the fold has that id (ADR 0380)', () => {
    const state = fold([target('web-7-20261111143005', 7)]);
    assert.equal(targetBatchId(state, 'web', 7, at), 'web-7-20261111143005-2');
  });

  it('never gives an id of a Brewery issue, which starts with a digit', () => {
    assert.match(targetBatchId(fold([ordered('7-1', 7)]), 'web', 7, at), /^[a-z]/);
  });

  it('gives ids that pass PathSafeId, up to the longest alias and the largest issue number', () => {
    const alias = 'a'.repeat(20);
    const issue = Number.MAX_SAFE_INTEGER;
    const first = targetBatchId(emptyState, alias, issue, at);
    const later = targetBatchId(fold([target(first, issue)]), alias, issue, at);
    for (const id of [first, later]) assert.ok(PathSafeId.safeParse(id).success, id);
  });

  for (const alias of ['', 'Web', '1web', 'my-web', 'a'.repeat(21), '../x']) {
    it(`refuses the alias ${JSON.stringify(alias)}`, () => {
      assert.throws(() => targetBatchId(emptyState, alias, 7, at), /alias must be/);
    });
  }

  for (const issue of [0, -1, 1.5]) {
    it(`refuses issue ${issue}`, () => {
      assert.throws(
        () => targetBatchId(emptyState, 'web', issue, at),
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
    ['web-7-20261111143005', 'web'],
    ['web-7-20261111143005-2', 'web'],
  ] as const) {
    it(`reads the alias ${alias} from ${id}`, () => {
      assert.equal(aliasOf(id), alias);
    });
  }
  for (const id of [
    '7-1',
    '7-20261111143005',
    'web',
    'web-',
    'web-07',
    'web-7-0',
    'web-7-07',
    'Web-7',
    'w_b-7',
    'web-7-2-3',
    'web-7-20261111143005-0',
    'web-7x',
    `${'a'.repeat(21)}-7`,
  ]) {
    it(`reads no alias from ${id}`, () => {
      assert.equal(aliasOf(id), undefined);
    });
  }
});
