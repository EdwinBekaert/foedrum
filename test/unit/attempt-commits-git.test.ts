// The commits an attempt made (ADR 0074), the shell, with a fake git that records every call
// (ADR 0021): it asks in the clone, on the attempt's branch, from the start commit as a full sha,
// so nothing the brewer wrote in its worktree decides the answer, and git's failure is an answer,
// never a throw.

import assert from 'node:assert/strict';
import { devNull } from 'node:os';
import { describe, it } from 'node:test';
import { countCommits, scanAttemptCommits } from '../../src/workspace/attempt-commits-git.ts';
import { attemptBranch } from '../../src/workspace/attempt-worktrees.ts';
import type { Git, GitOptions, GitResult } from '../../src/workspace/git.ts';

const START = 'c'.repeat(40);
const clone = '/work/acme.api/clone.git';
const branch = 'foedrum/12-1/brew/1';

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' });
const exited = (code: number | null, stderr = ''): GitResult => ({ code, stdout: '', stderr });

/** A git that answers each call by its subcommand and records it with its options. */
const recordingGit = (answers: Record<string, GitResult>) => {
  const calls: { cwd: string; args: readonly string[]; options: GitOptions | undefined }[] = [];
  const git: Git = async (cwd, args, options) => {
    calls.push({ cwd, args, options });
    return answers[args[0] ?? ''] ?? exited(2, 'unexpected call');
  };
  return { git, calls };
};

describe('countCommits', () => {
  it("asks in the clone whether the start is an ancestor of the attempt's branch, then counts the commits after it", async () => {
    const { git, calls } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('3\n') });
    const signal = new AbortController().signal;
    assert.deepEqual(await countCommits(git)(clone, branch, START, signal), {
      kind: 'counted',
      count: 3,
    });
    assert.deepEqual(
      calls.map(({ cwd, args }) => [cwd, ...args]),
      [
        [clone, 'merge-base', '--is-ancestor', START, `refs/heads/${branch}`],
        [clone, 'rev-list', '--count', `${START}..refs/heads/${branch}`],
      ],
    );
    assert.ok(calls.every(({ options }) => options?.signal === signal));
  });

  it('runs git in the clone with no hook or fsmonitor (ADR 0137)', async () => {
    const { git, calls } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('3\n') });
    await countCommits(git)(clone, branch, START);
    assert.equal(calls.length, 2);
    for (const { options } of calls) {
      assert.equal(options?.env, undefined);
      assert.deepEqual(options?.config, {
        'core.hooksPath': devNull,
        'core.fsmonitor': 'false',
      });
    }
  });

  it('counts none when the branch is at the start', async () => {
    const { git } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('0\n') });
    assert.deepEqual(await countCommits(git)(clone, branch, START), { kind: 'counted', count: 0 });
  });

  it('counts from a SHA-256 start, which a commit sha may be (review of #208)', async () => {
    const start = 'd'.repeat(64);
    const { git, calls } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('1\n') });
    assert.deepEqual(await countCommits(git)(clone, branch, start), { kind: 'counted', count: 1 });
    assert.equal(calls[0]?.args[2], start);
  });

  it('says the start was rewritten when it is no ancestor of the branch, and counts nothing', async () => {
    const { git, calls } = recordingGit({ 'merge-base': exited(1) });
    assert.deepEqual(await countCommits(git)(clone, branch, START), { kind: 'rewritten' });
    assert.equal(calls.length, 1);
  });

  it("gives git's first line when either call fails", async () => {
    const failing = recordingGit({ 'merge-base': exited(128, '\nfatal: not a git repository\n') });
    assert.deepEqual(await countCommits(failing.git)(clone, branch, START), {
      kind: 'uncounted',
      reason: 'git merge-base failed: fatal: not a git repository',
    });
    const silent = recordingGit({ 'merge-base': exited(128) });
    assert.deepEqual(await countCommits(silent.git)(clone, branch, START), {
      kind: 'uncounted',
      reason: 'git merge-base failed: git exited with 128',
    });
    const killed = recordingGit({ 'merge-base': ok(), 'rev-list': exited(null) });
    assert.deepEqual(await countCommits(killed.git)(clone, branch, START), {
      kind: 'uncounted',
      reason: 'git rev-list failed: git did not finish in time',
    });
  });

  it('does not read a count that is no number', async () => {
    const { git } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('three\n') });
    assert.deepEqual(await countCommits(git)(clone, branch, START), {
      kind: 'uncounted',
      reason: 'git rev-list gave no count: "three"',
    });
  });

  it('runs no git for a start that is no full commit sha, so nothing reaches git as an option', async () => {
    const { git, calls } = recordingGit({});
    for (const since of ['--output=x', 'HEAD~1', 'c'.repeat(39), 'c'.repeat(41)]) {
      assert.deepEqual(await countCommits(git)(clone, branch, since), {
        kind: 'uncounted',
        reason: `${since} is no full commit sha`,
      });
    }
    assert.deepEqual(calls, []);
  });

  it('counts on every branch attemptBranch makes, a target batch and a step id with a dot among them (review of #208)', async () => {
    const other = attemptBranch({ batchId: 'web-12-2', stepId: 'red.proof', attempt: 3 });
    const { git, calls } = recordingGit({ 'merge-base': ok(), 'rev-list': ok('1\n') });
    assert.deepEqual(await countCommits(git)(clone, other, START), { kind: 'counted', count: 1 });
    assert.equal(calls[0]?.args[3], `refs/heads/${other}`);
  });

  it('runs no git for a branch that is no attempt branch', async () => {
    const { git, calls } = recordingGit({});
    for (const other of ['main', '--all', 'foedrum/../main', 'foedrum/12-1/brew/1 x']) {
      assert.deepEqual(await countCommits(git)(clone, other, START), {
        kind: 'uncounted',
        reason: `${JSON.stringify(other)} is no attempt branch`,
      });
    }
    assert.deepEqual(calls, []);
  });
});

describe('scanAttemptCommits (ADR 0187)', () => {
  // Built at run time, so no scanner takes this file for one that holds a token.
  const token = ['ghp', 'A1b2'.repeat(9)].join('_');
  const OLD = 'a'.repeat(40);
  const NEW = 'd'.repeat(40);
  const TIP = 'e'.repeat(40);
  /** The history of the attempt's branch, oldest first: what each commit adds to which file. */
  const history = [
    { sha: OLD, file: 'old.txt', added: token },
    { sha: START, file: 'start.txt', added: 'start' },
    { sha: NEW, file: 'keys.test.ts', added: 'const key = "plain";' },
    { sha: TIP, file: 'tip.txt', added: 'tip' },
  ];
  type Commit = (typeof history)[number];
  const header = ({ sha }: Commit) =>
    `commit ${sha}\nauthor B <b@example.com> 1792484716 +0200\ncommitter B <b@example.com> 1792484716 +0200\n\n    Add\n`;
  const patch = ({ sha, file, added }: Commit) =>
    `\0${sha}\n\ndiff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${added}\n`;

  /**
   * A git over `commits`: the tip of the attempt's branch is the last one, and a log of
   * `<tip> ^<since>` shows the commits after `since`, newest first, as git would.
   */
  const historyGit = (commits: readonly Commit[]) => {
    const calls: { cwd: string; args: readonly string[]; options: GitOptions | undefined }[] = [];
    const git: Git = async (cwd, args, options) => {
      calls.push({ cwd, args, options });
      const tip = commits.at(-1)?.sha ?? '';
      if (args[0] === 'rev-parse') return ok(`${tip}\n`);
      const since = args.find((arg) => arg.startsWith('^'))?.slice(1);
      const from = commits.findIndex(({ sha }) => sha === since);
      const shown = commits.slice(from + 1).reverse();
      if (args[0] === 'rev-list') return ok('');
      if (args[0] !== 'log') return exited(2, 'unexpected call');
      if (args.includes('--patch')) return ok(shown.map(patch).join(''));
      if (args.includes('--format=raw')) return ok(shown.map(header).join('\n'));
      return ok(shown.map(({ sha }) => `\0${sha}\nAdd\n`).join(''));
    };
    return { git, calls };
  };

  it("scans the commits after the start to the tip of the attempt's branch, in the clone, as the push does", async () => {
    const committed = [...history.slice(0, 2), { ...history[2], added: `const key = '${token}';` }];
    const { git, calls } = historyGit(committed as Commit[]);
    const signal = new AbortController().signal;
    assert.deepEqual(await scanAttemptCommits(git)(clone, branch, START, signal), {
      kind: 'scanned',
      findings: [{ commit: NEW, place: 'keys.test.ts', kind: 'GitHub token' }],
    });
    assert.deepEqual(calls[0]?.args, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `refs/heads/${branch}^{commit}`,
    ]);
    const scans = calls.filter(({ args }) => args[0] === 'log');
    assert.equal(scans.length, 3);
    for (const { cwd, args, options } of scans) {
      assert.equal(cwd, clone);
      assert.deepEqual(args.slice(-3), ['--end-of-options', NEW, `^${START}`]);
      // The push's environment: objects as committed, no transport (ADR 0079).
      assert.equal(options?.env?.GIT_NO_REPLACE_OBJECTS, '1');
      assert.equal(options?.config?.['protocol.allow'], 'never');
      assert.equal(options?.signal, signal);
    }
  });

  it("finds nothing in clean commits, and nothing in a commit before the attempt's start, which is not the attempt's", async () => {
    const { git } = historyGit(history);
    assert.deepEqual(await scanAttemptCommits(git)(clone, branch, START), {
      kind: 'scanned',
      findings: [],
    });
    // The same history scanned from before the old commit finds it: the start is what keeps it out.
    assert.deepEqual(await scanAttemptCommits(git)(clone, branch, 'f'.repeat(40)), {
      kind: 'scanned',
      findings: [{ commit: OLD, place: 'old.txt', kind: 'GitHub token' }],
    });
  });

  it('says why when git fails, never throwing, and runs no git for a start or branch it would read as an option', async () => {
    const failing: Git = async (_cwd, args) =>
      args[0] === 'rev-parse' ? ok(`${TIP}\n`) : exited(128, 'fatal: bad object\n');
    assert.deepEqual(await scanAttemptCommits(failing)(clone, branch, START), {
      kind: 'unscanned',
      reason: 'git log failed: fatal: bad object',
    });
    const unresolved: Git = async () => exited(1);
    assert.deepEqual(await scanAttemptCommits(unresolved)(clone, branch, START), {
      kind: 'unscanned',
      reason: `The revision refs/heads/${branch} is no commit in ${clone}`,
    });
    const { git, calls } = recordingGit({});
    assert.deepEqual(await scanAttemptCommits(git)(clone, branch, '--output=x'), {
      kind: 'unscanned',
      reason: '--output=x is no full commit sha',
    });
    assert.deepEqual(await scanAttemptCommits(git)(clone, '--all', START), {
      kind: 'unscanned',
      reason: '"--all" is no attempt branch',
    });
    assert.deepEqual(calls, []);
  });
});
