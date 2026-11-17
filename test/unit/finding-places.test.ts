// Whether each Taster finding's place exists at the head it reviewed (ADR 0421), with a fake read
// of the files. The git reads are in test/unit/finding-files-git.test.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Ending } from '../../src/engine/decide.ts';
import { type FilesRead, placesChecked, type ReadFiles } from '../../src/engine/finding-places.ts';
import type { TastingFinding } from '../../src/schemas/out-doc.ts';

const commit = 'c'.repeat(40);
const reviewed = { clone: '/work/api.git', commit };

/** A read that answers with `files` (three lines in src/a.ts by default), and records each call. */
const fakeRead = (
  answer: FilesRead = { kind: 'read', files: new Map([['src/a.ts', 'a\nb\nc\n']]) },
) => {
  const calls: { clone: string; commit: string; paths: readonly string[] }[] = [];
  const read: ReadFiles = async (clone, at, paths) => {
    calls.push({ clone, commit: at, paths });
    return answer;
  };
  return { calls, read };
};

const finding = (place: { file?: string; line?: number }): TastingFinding => ({
  ...place,
  severity: 'major',
  why: 'The poll has no deadline',
  introduced: true,
});

/** A Taster's succeeded ending with these findings, each minor so that it approves. */
const tasted = (...findings: TastingFinding[]): Ending => ({
  kind: 'succeeded',
  // Through JSON, as the event log keeps it.
  output: JSON.parse(
    JSON.stringify({
      status: 'done',
      summary: 'One finding',
      assumptions: [],
      verdict: 'approve',
      findings: findings.map((one) => ({ ...one, severity: 'minor' })),
    }),
  ),
});

const findingsOf = (ending: Ending): unknown =>
  ending.kind === 'succeeded'
    ? (ending.output as { findings: unknown }).findings
    : ending.kind === 'blocked'
      ? ending.findings
      : undefined;

describe('placesChecked (ADR 0421)', () => {
  it('marks a finding whose line is past the end of its file at the reviewed commit', async () => {
    const { calls, read } = fakeRead();
    const ending = await placesChecked(
      read,
      tasted(finding({ file: 'src/a.ts', line: 4 })),
      reviewed,
    );
    assert.deepEqual(calls, [{ clone: '/work/api.git', commit, paths: ['src/a.ts'] }]);
    assert.deepEqual(findingsOf(ending), [
      { ...finding({ file: 'src/a.ts', line: 4 }), severity: 'minor', missing: 'line' },
    ]);
  });

  it('leaves a finding on the last line of its file unmarked', async () => {
    const { read } = fakeRead();
    const ending = await placesChecked(
      read,
      tasted(finding({ file: 'src/a.ts', line: 3 })),
      reviewed,
    );
    assert.deepEqual(findingsOf(ending), [
      { ...finding({ file: 'src/a.ts', line: 3 }), severity: 'minor' },
    ]);
  });

  it('marks a finding whose file is not a file at the reviewed commit', async () => {
    const { read } = fakeRead({ kind: 'read', files: new Map([['src/gone.ts', undefined]]) });
    const ending = await placesChecked(
      read,
      tasted(finding({ file: 'src/gone.ts', line: 1 })),
      reviewed,
    );
    assert.deepEqual(findingsOf(ending), [
      { ...finding({ file: 'src/gone.ts', line: 1 }), severity: 'minor', missing: 'file' },
    ]);
  });

  it('marks a finding with a file and no line when the file does not exist', async () => {
    const { read } = fakeRead({ kind: 'read', files: new Map([['src/gone.ts', undefined]]) });
    const ending = await placesChecked(read, tasted(finding({ file: 'src/gone.ts' })), reviewed);
    assert.deepEqual(findingsOf(ending), [
      { ...finding({ file: 'src/gone.ts' }), severity: 'minor', missing: 'file' },
    ]);
  });

  it('leaves a finding with a file and no line unmarked when the file exists', async () => {
    const { read } = fakeRead();
    const ending = await placesChecked(read, tasted(finding({ file: 'src/a.ts' })), reviewed);
    assert.deepEqual(findingsOf(ending), [{ ...finding({ file: 'src/a.ts' }), severity: 'minor' }]);
  });

  it('marks a finding whose file is no plain path without asking git for it', async () => {
    const { calls, read } = fakeRead();
    const ending = await placesChecked(
      read,
      tasted(finding({ file: '../secrets.ts', line: 1 }), finding({ file: 'src/a.ts', line: 1 })),
      reviewed,
    );
    assert.deepEqual(calls[0]?.paths, ['src/a.ts']);
    assert.deepEqual(findingsOf(ending), [
      { ...finding({ file: '../secrets.ts', line: 1 }), severity: 'minor', missing: 'file' },
      { ...finding({ file: 'src/a.ts', line: 1 }), severity: 'minor' },
    ]);
  });

  it('asks for each cited file once', async () => {
    const { calls, read } = fakeRead();
    await placesChecked(
      read,
      tasted(finding({ file: 'src/a.ts', line: 1 }), finding({ file: 'src/a.ts', line: 9 })),
      reviewed,
    );
    assert.deepEqual(calls[0]?.paths, ['src/a.ts']);
  });

  it('reads nothing when no finding names a file, and keeps the ending as it is', async () => {
    const { calls, read } = fakeRead();
    const ending = tasted(finding({}));
    assert.deepEqual(await placesChecked(read, ending, reviewed), ending);
    assert.deepEqual(calls, []);
  });

  it('marks the findings of an attempt blocked by its findings', async () => {
    const { read } = fakeRead();
    const blocked: Ending = {
      kind: 'blocked',
      blockerKind: 'findings',
      summary: 'the Taster asks for changes: one major',
      findings: [finding({ file: 'src/a.ts', line: 40 })],
    };
    const ending = await placesChecked(read, blocked, reviewed);
    assert.deepEqual(ending, {
      ...blocked,
      findings: [{ ...finding({ file: 'src/a.ts', line: 40 }), missing: 'line' }],
    });
  });

  it('marks nothing when git cannot read the files', async () => {
    const { calls, read } = fakeRead({ kind: 'unread', reason: 'git ls-tree failed: bad object' });
    const ending = tasted(finding({ file: 'src/a.ts', line: 40 }));
    assert.deepEqual(await placesChecked(read, ending, reviewed), ending);
    assert.equal(calls.length, 1);
  });

  it('checks nothing for an attempt with no reviewed tree', async () => {
    const { calls, read } = fakeRead();
    const ending = tasted(finding({ file: 'src/a.ts', line: 40 }));
    assert.deepEqual(await placesChecked(read, ending, undefined), ending);
    assert.deepEqual(calls, []);
  });

  it("keeps another brewer's succeeded ending as it is", async () => {
    const { calls, read } = fakeRead();
    const ending: Ending = {
      kind: 'succeeded',
      output: { status: 'done', summary: 'Planned', assumptions: [] },
    };
    assert.deepEqual(await placesChecked(read, ending, reviewed), ending);
    assert.deepEqual(calls, []);
  });
});
