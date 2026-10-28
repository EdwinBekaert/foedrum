// A full commit id, checked one way everywhere (ADR 0254): Foedrum supports SHA-1 repositories, so
// `CommitSha` and every git reader take 40 lowercase hex characters and refuse a 64-character
// SHA-256 id before git runs, with a line that names it. Git is a fake that counts its calls
// (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rawCommits } from '../../src/formats/commit-scan.ts';
import { CommitSha } from '../../src/schemas/store.ts';
import { countCommits, scanAttemptCommits } from '../../src/workspace/attempt-commits-git.ts';
import { openWorktreeMerge } from '../../src/workspace/base-merge-git.ts';
import { openBranchPush } from '../../src/workspace/branch-push-git.ts';
import type { Git } from '../../src/workspace/git.ts';
import { openMergedTree, openMergeTree } from '../../src/workspace/merge-tree-git.ts';
import { readPathsAt } from '../../src/workspace/plan-paths-git.ts';

const SHA1 = 'c'.repeat(40);
const SHA256 = 'c'.repeat(64);
const clone = '/work/acme.api/clone';
const branch = 'foedrum/12-1/brew/1';
const own = { url: 'https://github.com/acme/api.git', root: '/work/acme.api/own', id: () => 'one' };

/** Why a reader refused a SHA-256 id: the line that names it. */
const REFUSED = `${SHA256} is a SHA-256 commit id: Foedrum supports SHA-1 repositories only`;

/** A reader, given `id` and a git; what it answered, or the message it threw. */
interface Row {
  reader: string;
  read: (git: Git, id: string) => Promise<unknown>;
  /** What it answers a SHA-256 id with, git never run. */
  refusal: unknown;
}

const ROWS: Row[] = [
  {
    reader: 'CommitSha',
    read: async (_, id) => {
      const parsed = CommitSha.safeParse(id);
      return parsed.success ? 'accepted' : parsed.error.issues[0]?.message;
    },
    refusal: 'Must be a full commit sha: 40 lowercase hex characters (SHA-1 repositories only)',
  },
  {
    reader: 'countCommits',
    read: (git, id) => countCommits(git)(clone, branch, id),
    refusal: { kind: 'uncounted', reason: REFUSED },
  },
  {
    reader: 'scanAttemptCommits',
    read: (git, id) => scanAttemptCommits(git)(clone, branch, id),
    refusal: { kind: 'unscanned', reason: REFUSED },
  },
  {
    reader: 'readPathsAt',
    read: (git, id) => readPathsAt(git)(clone, id, ['src/a.ts']),
    refusal: { kind: 'unread', reason: REFUSED },
  },
  {
    reader: "the base merge's parents",
    read: (git, id) => openWorktreeMerge({ git, clone }).parents('/work/a', id),
    refusal: REFUSED,
  },
  {
    reader: "the base merge's merge",
    read: (git, id) => openWorktreeMerge({ git, clone }).merge('/work/a', id, 'Merge'),
    refusal: REFUSED,
  },
  {
    reader: 'the merge-tree',
    read: (git, id) => openMergeTree({ git, clone, own })(id, SHA1),
    refusal: REFUSED,
  },
  {
    reader: 'the merged tree',
    read: (git, id) => openMergedTree({ git, clone, own })(SHA1, id, async () => 'read'),
    refusal: REFUSED,
  },
  {
    reader: "the push's push",
    read: (git, id) => openBranchPush({ git, clone }).push(id, 'foedrum/12-1/brew'),
    refusal: REFUSED,
  },
  {
    reader: "the push's ancestor check",
    read: (git, id) => openBranchPush({ git, clone }).isAncestor(id, SHA1),
    refusal: REFUSED,
  },
  {
    reader: "the push's secret scan",
    read: (git, id) => openBranchPush({ git, clone }).secretScan(SHA1, id),
    refusal: REFUSED,
  },
  {
    reader: "the push's touched files",
    read: (git, id) => openBranchPush({ git, clone }).touchedFiles(id, SHA1),
    refusal: REFUSED,
  },
  {
    reader: "the commit scan's commit line",
    read: async (_, id) => (rawCommits(`commit ${id}\n`).length === 1 ? 'accepted' : 'no commit'),
    refusal: 'no commit',
  },
];

/** What `row` answers `id` with: `accepted` once git runs, since the id passed the check. */
const answer = async (row: Row, id: string): Promise<unknown> => {
  let calls = 0;
  const git: Git = async () => {
    calls += 1;
    return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
  };
  let said: unknown;
  try {
    said = await row.read(git, id);
  } catch (error) {
    said = error instanceof Error ? error.message : String(error);
  }
  return calls > 0 ? 'accepted' : said;
};

describe('a full commit id (ADR 0254)', () => {
  for (const row of ROWS) {
    it(`${row.reader} refuses a SHA-256 id before git runs, and takes a SHA-1 one`, async () => {
      assert.deepEqual(await answer(row, SHA256), row.refusal);
      assert.equal(await answer(row, SHA1), 'accepted');
    });
  }
});
