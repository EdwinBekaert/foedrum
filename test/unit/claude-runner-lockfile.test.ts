// The lockfile refresh after a release bump in the real brewer runner's shell (ADR 0412), with a
// fake stream process that plays a captured stream, a fake process runner for the refresh and a
// fake scratch tree of the attempt's branch: Foedrum refreshes and commits the lockfile once the
// brewer's attempt ended succeeded with commits, and one that cannot be refreshed blocks it.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  type ClaudeAttemptPlan,
  type ClaudeRunnerDeps,
  claudeBrewerRunnerWith,
} from '../../src/brewers/claude-runner.ts';
import { assembleBrewerPrompt } from '../../src/brewers/prompt.ts';
import { CARGO_REFRESH, NPM_REFRESH } from '../../src/checks/lockfile.ts';
import type { AttemptLimits, AttemptStart } from '../../src/engine/brewer-runner.ts';
import type { ExecOptions, ExecResult, StreamResult } from '../../src/platform/processes.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import type { PathsChanged } from '../../src/workspace/attempt-commits-git.ts';
import type { OwnRemote } from '../../src/workspace/clone-git.ts';
import type { BranchCommit } from '../../src/workspace/merge-tree-git.ts';
import { suiteFolders } from '../helpers/attempt-worktrees.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';

const nextFolder = suiteFolders('claude-runner-lockfile');
const success = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'claude-stream', 'success.jsonl'),
  'utf8',
)
  .split('\n')
  .filter((line) => line !== '');

const sessionId = '00000000-0000-4000-8000-000000000001';
const start = 'c'.repeat(40);
const made = 'd'.repeat(40);

const assembled = assembleBrewerPrompt('Bump greet to v1.2.0.', []);
if (assembled.kind !== 'assembled') throw new Error('the test prompt was refused');

const limits: AttemptLimits = {
  outDoc: { file: 'brew.md', schema: OutDocFrontmatter },
  maxTurns: 3,
  commitsSince: start,
};
const attempt: AttemptStart = { ref: { batchId: '12-1', stepId: 'implement', attempt: 1 }, limits };

const own = { url: 'https://github.com/acme/web.git', root: '/work/acme.web/git-dirs' };
const refresh = {
  own,
  deadlineAt: '2026-11-17T13:00:00.000Z',
  env: { PATH: '/usr/bin', npm_config_ignore_scripts: 'true' },
  unsandboxed: false,
};

const plan = (more: Partial<ClaudeAttemptPlan> = {}): ClaudeAttemptPlan => ({
  cwd: '/work/tree',
  env: { PATH: '/usr/bin' },
  prompt: assembled.prompt,
  call: {
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxTurns: 3,
    tools: ['Read'],
    session: { kind: 'new', id: sessionId },
  },
  permissions: { allow: ['Read'], deny: [], sandbox: false },
  settingsFile: '/work/attempt/settings.json',
  commits: { clone: '/work/clone.git', branch: 'foedrum/12-1/implement/1' },
  refresh,
  ...more,
});

const clean: StreamResult = { exitCode: 0, stderr: '' };

/** A runner whose claude plays success.jsonl and whose scratch tree holds `tree`'s files. */
const setup = (
  options: {
    plan?: ClaudeAttemptPlan;
    /** The files of the branch's tip, by relative path; default a lockfile in web/. */
    tree?: Record<string, string>;
    /** What the refresh writes over the lockfile in its folder; default a new version. */
    writes?: string;
    /** The lockfile's name the refresh writes; default package-lock.json. */
    lockfileName?: string;
    exit?: number;
    changed?: PathsChanged;
    /** Stops the attempt while git lists the changed paths. */
    stopWhileListing?: boolean;
    outDoc?: string;
    branchCommit?: false | 'throws' | 'stops' | 'throws after';
    setupRunner?: false;
  } = {},
) => {
  const refreshed: { command: string; options: ExecOptions | undefined }[] = [];
  const opened: {
    clone: string;
    own: OwnRemote;
    branch: string;
    message: string;
    files: readonly string[];
  }[] = [];
  const branchCommit =
    (clone: string, remote: OwnRemote): BranchCommit =>
    async (branch, message, use) => {
      if (options.branchCommit === 'throws') throw new Error('git worktree add failed: no space');
      // A stop while git commits: the runner kills git, which fails.
      if (options.branchCommit === 'stops') {
        stop();
        throw new Error('git commit-tree failed: killed');
      }
      const tree = nextFolder();
      for (const [file, text] of Object.entries(
        options.tree ?? { 'web/package.json': '{}', 'web/package-lock.json': 'v1.1.0\n' },
      )) {
        mkdirSync(join(tree, ...file.split('/'), '..'), { recursive: true });
        writeFileSync(join(tree, ...file.split('/')), text);
      }
      const { value, files } = await use(tree);
      // Its scratch tree cannot be removed after the refresh ran.
      if (options.branchCommit === 'throws after') throw new Error('EBUSY: the tree is in use');
      opened.push({ clone, own: remote, branch, message, files });
      return files.length === 0 ? { value } : { value, commit: made };
    };
  const deps: ClaudeRunnerDeps = {
    claude: '/opt/claude/bin/claude',
    plan: async () => options.plan ?? plan(),
    stream: async (_file, _args, streamOptions) => {
      for (const line of success) streamOptions.onLine(line);
      return clean;
    },
    files: {
      writeSettings: () => {},
      writeSystemPrompt: () => {},
      readOutDoc: () => ({
        kind: 'text',
        text: options.outDoc ?? outDoc({ status: 'done', summary: 'Bumped greet' }),
      }),
      clearOutDoc: () => {},
      restoreOutDoc: () => {},
      copyOutDoc: () => {},
    },
    now: () => new Date('2026-11-17T12:00:00.000Z'),
    wait: async () => {},
    commits: async () => ({ kind: 'counted', count: 1 }),
    scan: async () => ({ kind: 'scanned', findings: [] }),
    touches: async (_clone, _commit, paths) => ({ kind: 'read', present: new Set(paths) }),
    changed: async () => {
      // A stop kills git, which answers that it could not list them.
      if (options.stopWhileListing === true) {
        stop();
        return { kind: 'unlisted', reason: 'git diff failed: killed' };
      }
      return options.changed ?? { kind: 'listed', paths: ['web/package.json'] };
    },
    ...(options.setupRunner === false
      ? {}
      : {
          setup: async (command: string, _args: readonly string[], execOptions?: ExecOptions) => {
            refreshed.push({ command, options: execOptions });
            writeFileSync(
              join(execOptions?.cwd ?? '', options.lockfileName ?? 'package-lock.json'),
              options.writes ?? 'v1.2.0\n',
            );
            const output = options.exit === undefined ? '' : 'npm ERR! 404 greet';
            const result: ExecResult = {
              exitCode: options.exit ?? 0,
              stdout: '',
              stderr: '',
              output,
            };
            return result;
          },
        }),
    ...(options.branchCommit === false ? {} : { branchCommit }),
  };
  const runner = claudeBrewerRunnerWith(deps);
  let stop = () => {};
  return {
    refreshed,
    opened,
    runner: {
      ...runner,
      start: (at: AttemptStart) => {
        const started = runner.start(at);
        stop = started.stop;
        return started;
      },
    },
  };
};

const reading = {
  result: 'exited',
  lockfile: 'web/package-lock.json',
  command: NPM_REFRESH,
  exitCode: 0,
  tail: '',
};

describe('claudeBrewerRunner: the lockfile refresh after a release bump (ADR 0412)', () => {
  it('refreshes the lockfile beside the manifest its commits changed, in a scratch tree of its branch, and commits it', async () => {
    const { refreshed, opened, runner } = setup();
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'succeeded');
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0]?.command, NPM_REFRESH);
    assert.match(refreshed[0]?.options?.cwd ?? '', /[\\/]web$/);
    assert.equal(refreshed[0]?.options?.env?.npm_config_ignore_scripts, 'true');
    assert.deepStrictEqual(opened, [
      {
        clone: '/work/clone.git',
        own,
        branch: 'foedrum/12-1/implement/1',
        message: 'Refresh the lockfiles after the release bump (ADR 0412)',
        files: ['web/package-lock.json'],
      },
    ]);
    assert.deepStrictEqual(end.readings, [reading]);
  });

  it("commits a workspace's Cargo.lock found above the member its commits changed (ADR 0415)", async () => {
    const { refreshed, opened, runner } = setup({
      tree: {
        'Cargo.toml': '[workspace]\n',
        'Cargo.lock': 'v1.1.0\n',
        'crates/a/Cargo.toml': '[package]\n',
      },
      changed: { kind: 'listed', paths: ['crates/a/Cargo.toml'] },
      lockfileName: 'Cargo.lock',
    });
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepStrictEqual(
      refreshed.map(({ command }) => command),
      [CARGO_REFRESH],
    );
    assert.doesNotMatch(refreshed[0]?.options?.cwd ?? '', /[\\/]a$/);
    assert.deepStrictEqual(
      opened.map(({ message, files }) => ({ message, files })),
      [
        {
          message: 'Refresh the lockfiles after the release bump (ADR 0412)',
          files: ['Cargo.lock'],
        },
      ],
    );
  });

  it('commits nothing when the refresh leaves the lockfile as it was', async () => {
    const { opened, runner } = setup({ writes: 'v1.1.0\n' });
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepStrictEqual(
      opened.map(({ files }) => files),
      [[]],
    );
    assert.deepStrictEqual(end.readings, [reading]);
  });

  it('a refresh that fails ends the attempt blocked on its environment, naming the lockfile', async () => {
    const { runner } = setup({ exit: 1 });
    const end = await runner.start(attempt).ended;
    assert.deepStrictEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: `the lockfile web/package-lock.json could not be refreshed: "${NPM_REFRESH}" failed with exit code 1`,
    });
    assert.deepStrictEqual(end.readings, [{ ...reading, exitCode: 1, tail: 'npm ERR! 404 greet' }]);
  });

  it('a scratch tree that cannot be made ends the attempt blocked on its environment', async () => {
    const { runner } = setup({ branchCommit: 'throws' });
    const end = await runner.start(attempt).ended;
    assert.deepStrictEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the lockfiles could not be refreshed: git worktree add failed: no space',
    });
  });

  it('a refresh that fails names the lockfile, also when its scratch tree then fails', async () => {
    const { runner } = setup({ exit: 1, branchCommit: 'throws after' });
    const end = await runner.start(attempt).ended;
    assert.deepStrictEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: `the lockfile web/package-lock.json could not be refreshed: "${NPM_REFRESH}" failed with exit code 1`,
    });
    assert.equal(end.readings?.length, 1);
  });

  it('a stop while git lists the changed paths cancels the attempt, and opens no scratch tree', async () => {
    const { opened, runner } = setup({ stopWhileListing: true });
    const end = await runner.start(attempt).ended;
    assert.deepStrictEqual(end.ending, { kind: 'cancelled' });
    assert.deepStrictEqual(opened, []);
  });

  it("a stop while the refresh's commit runs cancels the attempt", async () => {
    const { runner } = setup({ branchCommit: 'stops' });
    const end = await runner.start(attempt).ended;
    assert.deepStrictEqual(end.ending, { kind: 'cancelled' });
  });

  it('changed files that cannot be listed end the attempt blocked on its environment', async () => {
    const { opened, runner } = setup({
      changed: { kind: 'unlisted', reason: 'git diff failed: bad object' },
    });
    const end = await runner.start(attempt).ended;
    assert.deepStrictEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary: 'the lockfiles could not be refreshed: git diff failed: bad object',
    });
    assert.deepStrictEqual(opened, []);
  });

  it('a runner with no scratch tree for refreshes ends the attempt blocked on its environment', async () => {
    const { runner } = setup({ branchCommit: false });
    const end = await runner.start(attempt).ended;
    assert.deepStrictEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the lockfiles could not be refreshed: the brewer runner has no scratch tree or process runner for them',
    });
  });

  it('a runner with no process runner for refreshes ends the attempt blocked on its environment', async () => {
    const { opened, runner } = setup({ setupRunner: false });
    const end = await runner.start(attempt).ended;
    assert.deepStrictEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the lockfiles could not be refreshed: the brewer runner has no scratch tree or process runner for them',
    });
    assert.deepStrictEqual(opened, []);
  });

  it('refreshes nothing for a plan without a refresh (regression test)', async () => {
    const { refreshed, opened, runner } = setup({
      plan: (({ refresh: _, ...rest }) => rest)(plan()),
    });
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepStrictEqual([refreshed, opened], [[], []]);
  });

  it('refreshes nothing when the attempt did not end succeeded (regression test)', async () => {
    const { refreshed, opened, runner } = setup({
      outDoc: outDoc({ status: 'needs_input', summary: 'Which tag?', questions: ['Which tag?'] }),
    });
    const end = await runner.start(attempt).ended;
    assert.notEqual(end.ending.kind, 'succeeded');
    assert.deepStrictEqual([refreshed, opened], [[], []]);
  });

  it('refreshes nothing when its commits changed no manifest (regression test)', async () => {
    const { refreshed, opened, runner } = setup({
      changed: { kind: 'listed', paths: ['src/a.ts'] },
    });
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'succeeded');
    assert.deepStrictEqual([refreshed, opened], [[], []]);
  });
});
