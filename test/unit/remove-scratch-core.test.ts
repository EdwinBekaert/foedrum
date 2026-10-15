import assert from 'node:assert/strict';
import { join, relative as relativePath, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { planScratch, type ScratchFacts } from '../../scripts/remove-scratch/core.ts';
import type { RecordFact } from '../../scripts/worktrees-clean/core.ts';

const checkout = resolve('/repo/.claude/worktrees/61-a');
const scratch = join(checkout, '.foedrum', 'tmp', '61', 'scratch');
const tree = join(scratch, 'tree');
const records = resolve('/repo/.git/worktrees');

const record = (name: string, folder: string | undefined): RecordFact => ({
  dir: join(records, name),
  name,
  folder,
  folderExists: false,
  lockReason: undefined,
});

const facts = (fact: Partial<ScratchFacts> = {}): ScratchFacts => ({
  checkout,
  scratch,
  dotGit: `gitdir: ${join(records, 'tree')}\n`,
  records: [],
  ...fact,
});

describe('planScratch', () => {
  it('removes the record that points at the scratch tree and no other', () => {
    const result = planScratch(
      facts({
        records: [
          record('tree', tree),
          record('tree1', join(checkout, '.foedrum', 'tmp', '58', 'scratch', 'tree')),
          record('61-a', checkout),
          record('orphan', undefined),
        ],
      }),
    );

    assert.deepEqual(result, { ok: true, records: [join(records, 'tree')] });
  });

  it("removes the record the tree's .git file names when that record's gitdir file is missing", () => {
    const result = planScratch(
      facts({ records: [record('tree', undefined), record('tree1', undefined)] }),
    );

    assert.deepEqual(result, { ok: true, records: [join(records, 'tree')] });
  });

  it('resolves a relative path in a CRLF .git file against the tree', () => {
    const relative = relativePath(tree, join(records, 'tree'));
    const result = planScratch(
      facts({ dotGit: `gitdir: ${relative}\r\n`, records: [record('tree', undefined)] }),
    );

    assert.deepEqual(result, { ok: true, records: [join(records, 'tree')] });
  });

  it('does not remove the record the .git file names when it points at another folder', () => {
    const result = planScratch(facts({ records: [record('tree', join(checkout, 'other'))] }));

    assert.deepEqual(result, { ok: true, records: [] });
  });

  it('removes only the folder when the tree has no .git file and no record points at it', () => {
    const result = planScratch(facts({ dotGit: undefined, records: [record('tree', undefined)] }));

    assert.deepEqual(result, { ok: true, records: [] });
  });

  for (const [title, path] of [
    ['outside .foedrum/tmp/', join(checkout, 'src')],
    ['.foedrum/tmp/ itself', join(checkout, '.foedrum', 'tmp')],
    ['outside the checkout', resolve('/elsewhere/.foedrum/tmp/61/scratch')],
  ] as const) {
    it(`refuses a scratch folder ${title}`, () => {
      const result = planScratch(facts({ scratch: path, records: [record('tree', tree)] }));

      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.reason, /is not inside/);
    });
  }

  // The script deletes recursively, so only the shape the review skill uses is accepted:
  // .foedrum/tmp/<one folder>/scratch, never another issue's folder or the tests' folder.
  const tmp = join(checkout, '.foedrum', 'tmp');
  for (const path of [join(tmp, '58'), join(tmp, 'tests'), join(tmp, '58', 'review')]) {
    const name = path.slice(checkout.length + 1).replaceAll('\\', '/');
    it(`refuses ${name}, which is not <folder>/scratch`, () => {
      const result = planScratch(facts({ scratch: path, records: [record('tree', tree)] }));

      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.reason, /is not inside .* as <folder>\/scratch/);
    });
  }

  it('accepts .foedrum/tmp/58/scratch, the folder of another issue’s review', () => {
    const other = join(tmp, '58', 'scratch');
    const result = planScratch(
      facts({ scratch: other, records: [record('tree', join(other, 'tree'))] }),
    );

    assert.deepEqual(result, { ok: true, records: [join(records, 'tree')] });
  });
});
