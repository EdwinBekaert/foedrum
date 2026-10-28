// The gate's decisions on the hook input, with the check and the process runner injected. The
// hook command and the real npm run in test/integration/precheck.test.ts (ADR 0021).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve, win32 } from 'node:path';
import { describe, it } from 'node:test';
import { parseArgs } from 'node:util';
import {
  type CheckResult,
  type DeniedPush,
  type FindNpmCli,
  forbiddenReason,
  ghPullRequest,
  gitHeadIsDetached,
  gitPushConfig,
  isDetached,
  isGatedCommand,
  type LookupPullRequest,
  lockfileBinary,
  npmCheck,
  type PathModule,
  type ProcessOutcome,
  type PullRequestFacts,
  precheck,
  projectHolds,
  type ReadyTarget,
  type RunProcess,
  resolvePlace,
} from '../../scripts/precheck.ts';
import type { RunOptions } from '../../scripts/process-runner.ts';
import type { ExecOptions, ExecProcess, ExecResult } from '../../src/platform/processes.ts';

const root = join(import.meta.dirname, '..', '..');

const hookInput = (command: string, cwd = root, tool = 'Bash'): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { command },
    cwd,
  });

const fakeCheck = (result: CheckResult) => {
  const calls: string[] = [];
  const runCheck = async (cwd: string): Promise<CheckResult> => {
    calls.push(cwd);
    return result;
  };
  return { calls, runCheck };
};

describe('isGatedCommand', () => {
  const gated = [
    'git push',
    'git push -u origin 24-local-gate',
    'git -C ../foedrum push',
    'git -c push.default=current push --force-with-lease',
    'npm test && git push',
    'cd repo; git push origin main',
    'GIT_TRACE=1 git push',
    'git.exe push',
    '& git push',
  ];
  for (const command of gated) {
    it(`gates: ${command}`, () => {
      assert.equal(isGatedCommand(command), true);
    });
  }

  const ungated = [
    'git status',
    'git commit -m "git push later"',
    'git log --grep push',
    'echo git push',
    'gh pr view 24',
    'gh pr list --state all',
    'gh issue create --title push',
    'gh -R owner/repo pr view 30',
    // The push before it checked the tree a pull request opens (ADR 0135).
    'gh pr create --draft --title "Local gate"',
    'gh pr new',
    'gh -R owner/repo pr create --draft',
    'npm run check',
    '',
    // git prints push's help and pushes nothing (ADR 0246).
    'git push -h',
    'git push -h 2>&1',
    'git push --help',
    'git --help push',
    'git -h',
    'git help push',
  ];
  for (const command of ungated) {
    it(`lets through: ${command || '(empty)'}`, () => {
      assert.equal(isGatedCommand(command), false);
    });
  }

  // git reads -h as help only when it is push's one argument, and git's own -h only as its first
  // word: after an option the gate does not know, -h may be that option's value (review of #635).
  for (const command of [
    'git push -h origin',
    'git push origin -h',
    'git --attr-source -h push origin',
    'git --no-pager -h push origin',
  ]) {
    it(`gates: ${command}`, () => {
      assert.equal(isGatedCommand(command), true);
    });
  }

  it('runs no check and no scan for push’s help', async () => {
    const { calls, runCheck } = fakeCheck({ ok: false, output: 'fails' });
    const scans: string[] = [];
    const result = await precheck(
      hookInput('git push -h'),
      runCheck,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (dir) => {
        scans.push(dir);
        return 'denied';
      },
    );
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(calls, []);
    assert.deepEqual(scans, []);
  });
});

describe('precheck', () => {
  it('does not run the check for other commands', async () => {
    const { calls, runCheck } = fakeCheck({ ok: false, output: '' });
    const result = await precheck(hookInput('git status'), runCheck);
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(calls, []);
  });

  it('allows a push when the check passes, running it in the hook cwd', async () => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: 'all green' });
    const result = await precheck(hookInput('git push', '/work/tree'), runCheck);
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(calls, ['/work/tree']);
  });

  it('blocks a push with exit code 2 and the check output when the check fails', async () => {
    const { runCheck } = fakeCheck({ ok: false, output: 'not ok 1 - fold replays events' });
    const result = await precheck(hookInput('git push -u origin 24-local-gate'), runCheck);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /npm run check failed/);
    assert.match(result.stderr, /not ok 1 - fold replays events/);
  });

  it('allows tool calls without a command', async () => {
    const { calls, runCheck } = fakeCheck({ ok: false, output: '' });
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: {}, cwd: root });
    assert.deepEqual(await precheck(input, runCheck), { exitCode: 0, stderr: '' });
    assert.deepEqual(calls, []);
  });

  it('reads hook input that starts with a byte order mark', async () => {
    const { calls, runCheck } = fakeCheck({ ok: false, output: 'red' });
    const bom = String.fromCharCode(0xfeff);
    const result = await precheck(`${bom}${hookInput('git push')}`, runCheck);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(calls, [root]);
  });

  it('blocks when hook input that mentions git cannot be read', async () => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
    const result = await precheck('not json: git push', runCheck);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /hook input/);
    assert.deepEqual(calls, []);
  });

  it('lets through input that mentions neither git nor gh without parsing it', async () => {
    const { calls, runCheck } = fakeCheck({ ok: false, output: '' });
    assert.deepEqual(await precheck('not json', runCheck), { exitCode: 0, stderr: '' });
    assert.deepEqual(calls, []);
  });

  it('gates a push spelled in capitals', async () => {
    const { calls, runCheck } = fakeCheck({ ok: false, output: 'red' });
    const result = await precheck(hookInput('GIT push', root, 'PowerShell'), runCheck);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(calls, [root]);
  });

  it('gates a push hidden behind a JSON unicode escape', async () => {
    const { calls, runCheck } = fakeCheck({ ok: false, output: 'red' });
    const input = hookInput('git push', '/work/tree').replace('git', '\\u0067it');
    assert.doesNotMatch(input, /git/i);
    const result = await precheck(input, runCheck);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(calls, ['/work/tree']);
  });
});

describe('precheck on a stale node_modules', () => {
  const REASON = 'node_modules/zod 4.6.4 is installed, package-lock.json has 4.6.5';
  // A staleness check that records where it looked and answers with the given reason.
  const fakeStale = (reason: string | undefined) => {
    const calls: string[] = [];
    const staleReason = async (cwd: string): Promise<string | undefined> => {
      calls.push(cwd);
      return reason;
    };
    return { calls, staleReason };
  };

  it('blocks a push with one clear line, without running the check', async () => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
    const stale = fakeStale(REASON);
    const result = await precheck(hookInput('git push', '/work/tree'), runCheck, stale.staleReason);
    assert.deepEqual(result, {
      exitCode: 2,
      stderr: `node_modules is out of date with package-lock.json (${REASON}); run npm ci\n`,
    });
    assert.deepEqual(stale.calls, ['/work/tree']);
    assert.deepEqual(calls, []);
  });

  it('runs the check in the hook cwd when node_modules is up to date', async () => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
    const stale = fakeStale(undefined);
    const result = await precheck(hookInput('git push', '/work/tree'), runCheck, stale.staleReason);
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(stale.calls, ['/work/tree']);
    assert.deepEqual(calls, ['/work/tree']);
  });

  // Every Bash and PowerShell call goes through the gate, so only gated commands read files;
  // forbidden ones are blocked for their own reason first.
  for (const command of ['git status', 'git push --force']) {
    it(`does not look at node_modules for: ${command}`, async () => {
      const { runCheck } = fakeCheck({ ok: true, output: '' });
      const stale = fakeStale(REASON);
      await precheck(hookInput(command), runCheck, stale.staleReason);
      assert.deepEqual(stale.calls, []);
    });
  }
});

// The personal denylist's scan of what a push sends (ADR 0114), injected: its own tests are in
// denylist-shell.test.ts.
describe('precheck with a personal denylist', () => {
  const upToDate = async (): Promise<string | undefined> => undefined;
  const fakeScan = (answer: () => Promise<string | undefined>) => {
    const calls: string[] = [];
    const remotes: (string | null | undefined)[] = [];
    const destinations: (string | null)[] = [];
    const deniedPush: DeniedPush = async (dir, pushed, names) => {
      calls.push(dir);
      remotes.push(...pushed);
      destinations.push(...names);
      return answer();
    };
    return { calls, remotes, destinations, deniedPush };
  };
  const gate = (
    command: string,
    runCheck: (cwd: string) => Promise<CheckResult>,
    deniedPush: DeniedPush,
    detached = false,
  ) =>
    precheck(
      hookInput(command, '/work/tree'),
      runCheck,
      upToDate,
      async () => detached,
      undefined,
      undefined,
      undefined,
      deniedPush,
    );
  const REFUSAL = 'git push is blocked: it would send a word on your denylist (ADR 0114), at x';

  it('blocks a push with the scan’s line, before the check, in the tree it pushes', async () => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
    const scan = fakeScan(async () => REFUSAL);
    const result = await gate('git -C sub push', runCheck, scan.deniedPush);
    assert.deepEqual(result, { exitCode: 2, stderr: `${REFUSAL}\n` });
    assert.deepEqual(scan.calls, [resolve('/work/tree', 'sub')]);
    assert.deepEqual(calls, []);
  });

  it('runs the check when the scan finds nothing', async () => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
    const scan = fakeScan(async () => undefined);
    const result = await gate('git push', runCheck, scan.deniedPush);
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(scan.calls, ['/work/tree']);
    assert.deepEqual(calls, ['/work/tree']);
  });

  it('blocks the push when the scan fails', async () => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
    const scan = fakeScan(async () => {
      throw new Error('no git');
    });
    const result = await gate('git push', runCheck, scan.deniedPush);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /^git push is blocked: could not check it against your denylist/);
    assert.match(result.stderr, /no git/);
    assert.deepEqual(calls, []);
  });

  // The scan reads against the remote the push goes to (ADR 0114): the one the command names, none
  // when it names none (the scan asks git), and null when it is computed at run time.
  const remotes: [string, (string | null | undefined)[]][] = [
    ['git push', [undefined]],
    ['git push -u origin 131-denylist', ['origin']],
    ['git push --set-upstream work HEAD', ['work']],
    ['git push -o ci.skip --repo=mirror', ['mirror']],
    ['git push --repo mirror', ['mirror']],
    ['git push --push-option ci.skip origin', ['origin']],
    ['git push https://example.com/o/r.git HEAD', ['https://example.com/o/r.git']],
    ['git push "$remote" HEAD', [null]],
    ['git push origin && git push work', ['origin', 'work']],
    // A redirection is the shell's, never the push's remote.
    ['git push 2>&1', [undefined]],
    ['git push >out.txt', [undefined]],
    ['git push > out.txt', [undefined]],
    ['git push 2>/dev/null', [undefined]],
    ['git push 2> /dev/null origin', ['origin']],
    ['git push >>push.log origin', ['origin']],
    ['git push 1>out.txt 2>&1 work', ['work']],
    ['git push -u origin 131-denylist 2>&1', ['origin']],
    ['git push origin 131-denylist >out.txt', ['origin']],
    ['git push origin 131-denylist 2>/dev/null', ['origin']],
    ['git push &>push.log', [undefined]],
  ];
  for (const [command, expected] of remotes) {
    it(`scans against the remote the push names: ${command}`, async () => {
      const { runCheck } = fakeCheck({ ok: true, output: '' });
      const scan = fakeScan(async () => undefined);
      await gate(command, runCheck, scan.deniedPush);
      assert.deepEqual(scan.remotes, expected);
    });
  }

  // One scan for the command, so its git calls stay within one deadline budget.
  it('scans once for a command that pushes to two remotes, with both', async () => {
    const { runCheck } = fakeCheck({ ok: true, output: '' });
    const scan = fakeScan(async () => undefined);
    await gate('git push origin && git push work', runCheck, scan.deniedPush);
    assert.deepEqual(scan.calls, ['/work/tree']);
    assert.deepEqual(scan.remotes, ['origin', 'work']);
  });

  // The branch names the push creates on the remote go to the scan too (ADR 0246): the part of
  // each refspec after `:`, or the whole refspec, and null when it is computed at run time.
  const destinations: [string, (string | null)[]][] = [
    ['git push', []],
    ['git push origin', []],
    ['git push -u origin 613-x', ['613-x']],
    ['git push origin 613-x 2>&1', ['613-x']],
    ['git push origin HEAD:refs/heads/613-y', ['refs/heads/613-y']],
    ['git push origin a b:c', ['a', 'c']],
    ['git push -- origin 613-x', ['613-x']],
    ['git push origin "$branch"', [null]],
    ['git push origin "HEAD:$branch"', [null]],
  ];
  for (const [command, expected] of destinations) {
    it(`scans the branch names the push creates: ${command}`, async () => {
      const { runCheck } = fakeCheck({ ok: true, output: '' });
      const scan = fakeScan(async () => undefined);
      await gate(command, runCheck, scan.deniedPush);
      assert.deepEqual(scan.destinations, expected);
    });
  }

  it('does not scan a push from a detached HEAD, or what pushes nothing', async () => {
    const { runCheck } = fakeCheck({ ok: true, output: '' });
    const scan = fakeScan(async () => REFUSAL);
    await gate('git push', runCheck, scan.deniedPush, true);
    await gate('gh pr create --draft', runCheck, scan.deniedPush);
    await gate('git status', runCheck, scan.deniedPush);
    assert.deepEqual(scan.calls, []);
  });
});

// What git's configuration files make a push do, read before it in the tree it pushes, as
// `git config -z --get-regexp` prints it: key, line break, value, NUL; a key alone when it has no
// value (ADR 0246).
describe("precheck on a push that git's configuration makes delete, force or mirror", () => {
  const gate = async (command: string, config: () => Promise<string>, detached = false) => {
    const { calls: checks, runCheck } = fakeCheck({ ok: true, output: '' });
    const read: string[] = [];
    const result = await precheck(
      hookInput(command, '/work/tree'),
      runCheck,
      async () => undefined,
      async () => detached,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (dir) => {
        read.push(dir);
        return config();
      },
    );
    return { result, checks, read };
  };
  const blocked = (setting: string) =>
    `git push is blocked: git's configuration makes it delete, force or mirror remote refs (${setting}); push without that setting, or ask a maintainer.\n`;

  const cases: [command: string, config: string, setting?: string][] = [
    ['git push', 'remote.origin.push\n:refs/heads/x\0', 'remote.origin.push :refs/heads/x'],
    [
      'git push origin',
      'remote.origin.push\n+refs/heads/*:refs/heads/*\0',
      'remote.origin.push +refs/heads/*:refs/heads/*',
    ],
    ['git push', 'remote.origin.mirror\ntrue\0', 'remote.origin.mirror true'],
    ['git push origin', 'remote.origin.mirror\0', 'remote.origin.mirror'],
    ['git push origin', 'remote.origin.mirror\nyes\0', 'remote.origin.mirror yes'],
    // A push that names no remote, or one computed at run time, is held to every remote's.
    ['git push', 'remote.backup.mirror\ntrue\0', 'remote.backup.mirror true'],
    ['git push "$r" HEAD', 'remote.backup.mirror\ntrue\0', 'remote.backup.mirror true'],
    ['git push my.remote', 'remote.my.remote.push\n:x\0', 'remote.my.remote.push :x'],
    // A value option given by prefix or as the next word does not move the remote (review of
    // #635).
    [
      'git push --push-opt ci.skip origin',
      'remote.origin.mirror\ntrue\0',
      'remote.origin.mirror true',
    ],
    [
      'git push --recurse-submodules check origin',
      'remote.origin.mirror\ntrue\0',
      'remote.origin.mirror true',
    ],
    ['git push --rep origin', 'remote.origin.mirror\ntrue\0', 'remote.origin.mirror true'],
    // What does not delete, force or mirror, or is another remote's.
    ['git push', ''],
    ['git push', 'remote.origin.mirror\nfalse\0'],
    ['git push', 'remote.origin.mirror\n\0'],
    ['git push', 'remote.origin.mirror\nOff\0'],
    ['git push', 'remote.origin.push\nrefs/heads/main:refs/heads/main\0'],
    ['git push origin', 'remote.backup.mirror\ntrue\0remote.backup.push\n:x\0'],
  ];
  for (const [command, config, setting] of cases) {
    it(`${setting === undefined ? 'lets through' : 'blocks'} ${command} with ${JSON.stringify(config)}`, async () => {
      const { result, checks, read } = await gate(command, async () => config);
      assert.deepEqual(read, ['/work/tree']);
      if (setting === undefined) {
        assert.deepEqual(result, { exitCode: 0, stderr: '' });
      } else {
        assert.deepEqual(result, { exitCode: 2, stderr: blocked(setting) });
        assert.deepEqual(checks, []);
      }
    });
  }

  it('blocks the push when the configuration cannot be read', async () => {
    const { result, checks } = await gate('git push', async () => {
      throw new Error('git config exited 3');
    });
    assert.deepEqual(result, {
      exitCode: 2,
      stderr:
        "git push is blocked: could not read git's push configuration in /work/tree (git config exited 3).\n",
    });
    assert.deepEqual(checks, []);
  });
});

describe('gitPushConfig', () => {
  const fakeGit = (answer: Partial<ExecResult>) => {
    const calls: { file: string; args: readonly string[]; options: ExecOptions }[] = [];
    const exec: ExecProcess = async (file, args, options) => {
      calls.push({ file, args, options });
      return { exitCode: 0, stdout: '', stderr: '', output: '', ...answer };
    };
    return { calls, exec };
  };

  it('reads every remote’s push and mirror settings in the tree, with a deadline', async () => {
    const { calls, exec } = fakeGit({ stdout: 'remote.origin.mirror\ntrue\0', stderr: 'note' });
    assert.equal(await gitPushConfig(exec)('/work/tree'), 'remote.origin.mirror\ntrue\0');
    assert.deepEqual(
      calls.map(({ file, args, options }) => [file, args, options.cwd, options.timeoutMs]),
      [
        [
          'git',
          ['config', '-z', '--get-regexp', '^remote\\..*\\.(push|mirror)$'],
          '/work/tree',
          10_000,
        ],
      ],
    );
  });

  it('reads no settings when git finds none (exit 1)', async () => {
    const { exec } = fakeGit({ exitCode: 1 });
    assert.equal(await gitPushConfig(exec)('/work/tree'), '');
  });

  const failures: [name: string, answer: Partial<ExecResult>, why: RegExp][] = [
    ['exits 3', { exitCode: 3, output: 'fatal: bad config line 4' }, /git config exited 3/],
    ['cannot start', { exitCode: null }, /git config could not start/],
    ['times out', { exitCode: null, killed: 'timed-out' }, /git config timed out after 10 s/],
  ];
  for (const [name, answer, why] of failures) {
    it(`rejects when git ${name}`, async () => {
      const { exec } = fakeGit(answer);
      await assert.rejects(gitPushConfig(exec)('/work/tree'), why);
    });
  }
});

describe('precheck on a detached HEAD', () => {
  // A HEAD check that records where it looked and answers with the given state.
  const fakeHead = (detached: boolean) => {
    const calls: string[] = [];
    const headIsDetached = async (cwd: string): Promise<boolean> => {
      calls.push(cwd);
      return detached;
    };
    return { calls, headIsDetached };
  };
  const upToDate = async (): Promise<string | undefined> => undefined;

  it('blocks a push with one line, without running the check', async () => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
    const head = fakeHead(true);
    const result = await precheck(
      hookInput('git add . && git push', '/work/tree'),
      runCheck,
      upToDate,
      head.headIsDetached,
    );
    assert.deepEqual(result, {
      exitCode: 2,
      stderr:
        'git push is blocked: HEAD is detached in /work/tree, so new commits are on no branch; switch to your branch, move it to those commits, and push again.\n',
    });
    assert.deepEqual(head.calls, ['/work/tree']);
    assert.deepEqual(calls, []);
  });

  it('runs the check when HEAD is on a branch', async () => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
    const head = fakeHead(false);
    const result = await precheck(
      hookInput('git push -u origin 80-scratch', '/work/tree'),
      runCheck,
      upToDate,
      head.headIsDetached,
    );
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(head.calls, ['/work/tree']);
    assert.deepEqual(calls, ['/work/tree']);
  });

  it('blocks a detached push before looking at node_modules', async () => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
    const staleCalls: string[] = [];
    const stale = async (cwd: string): Promise<string | undefined> => {
      staleCalls.push(cwd);
      return 'node_modules/.package-lock.json is missing';
    };
    const head = fakeHead(true);
    const result = await precheck(
      hookInput('git push', '/work/tree'),
      runCheck,
      stale,
      head.headIsDetached,
    );
    assert.match(result.stderr, /^git push is blocked: HEAD is detached/);
    assert.deepEqual(staleCalls, []);
    assert.deepEqual(calls, []);
  });

  // Only a push is blocked: opening a pull request pushes nothing.
  for (const command of ['git status', 'git push --force', 'gh pr create --draft']) {
    it(`does not look at HEAD for: ${command}`, async () => {
      const { runCheck } = fakeCheck({ ok: true, output: '' });
      const head = fakeHead(true);
      await precheck(hookInput(command), runCheck, upToDate, head.headIsDetached);
      assert.deepEqual(head.calls, []);
    });
  }
});

describe('isDetached', () => {
  // `git symbolic-ref -q HEAD` exits 1 without output only when HEAD is detached.
  const outcomes: [name: string, outcome: ProcessOutcome, detached: boolean][] = [
    ['on a branch', { exitCode: 0, output: 'refs/heads/main\n' }, false],
    ['detached', { exitCode: 1, output: '' }, true],
    [
      'outside a repository',
      { exitCode: 128, output: 'fatal: not a git repository (or any of the parent directories)' },
      false,
    ],
    ['when git could not start', { exitCode: null, output: 'spawn git ENOENT' }, false],
  ];
  for (const [name, outcome, detached] of outcomes) {
    it(`is ${detached} ${name}`, () => {
      assert.equal(isDetached(outcome), detached);
    });
  }
});

describe('gitHeadIsDetached', () => {
  const fakeGit = (outcome: ProcessOutcome) => {
    const calls: [file: string, args: string[], cwd: string][] = [];
    const runProcess: RunProcess = async (file, args, cwd) => {
      calls.push([file, args, cwd]);
      return outcome;
    };
    return { calls, runProcess };
  };

  it('asks git symbolic-ref in the given directory', async () => {
    const { calls, runProcess } = fakeGit({ exitCode: 1, output: '' });
    assert.equal(await gitHeadIsDetached(runProcess)('/work/tree'), true);
    assert.deepEqual(calls, [['git', ['symbolic-ref', '-q', 'HEAD'], '/work/tree']]);
  });

  it('answers false on a branch', async () => {
    const { runProcess } = fakeGit({ exitCode: 0, output: 'refs/heads/main\n' });
    assert.equal(await gitHeadIsDetached(runProcess)('/work/tree'), false);
  });
});

describe('precheck on pushes inside compound commands', () => {
  const pushes: [name: string, tool: string, command: string][] = [
    [
      'the exact command that slipped past the if filter',
      'Bash',
      [
        "mkdir -p test/unit && cat > test/unit/gate-smoke.test.ts <<'EOF'",
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        '',
        'test("gate smoke: deliberately fails", () => {',
        '  assert.equal(1 + 1, 3);',
        '});',
        'EOF',
        'git push 2>&1 | tail -30',
      ].join('\n'),
    ],
    [
      'the same command with ; before the push',
      'Bash',
      "mkdir -p test/unit && cat > test/unit/gate-smoke.test.ts <<'EOF'\nok\nEOF\n; git push",
    ],
    ['a push after a heredoc', 'Bash', "cat > notes.md <<'EOF'\nnotes\nEOF\ngit push origin main"],
    ['a push after ;', 'Bash', 'npm test; git push'],
    ['a push inside ( … )', 'Bash', '(npm test && git push)'],
    ['a PowerShell push after ;', 'PowerShell', 'npm run check; git push origin main'],
  ];
  for (const [name, tool, command] of pushes) {
    it(`runs the check and blocks on failure: ${name}`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: false, output: 'not ok 1 - gate smoke' });
      const result = await precheck(hookInput(command, root, tool), runCheck);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /npm run check failed/);
      assert.deepEqual(calls, [root]);
    });
  }
});

describe('precheck on a push from another directory', () => {
  // The hook runs in the main checkout; the command pushes the tree it names (#132).
  const gate = async (command: string, tool = 'Bash', detached = false) => {
    const { calls: checks, runCheck } = fakeCheck({ ok: true, output: '' });
    const heads: string[] = [];
    const stale: string[] = [];
    const lookups: string[] = [];
    const result = await precheck(
      hookInput(command, root, tool),
      runCheck,
      async (cwd) => {
        stale.push(cwd);
        return undefined;
      },
      async (cwd) => {
        heads.push(cwd);
        return detached;
      },
      async (cwd) => {
        lookups.push(cwd);
        return {
          number: 5,
          head: 'a'.repeat(40),
          comments: [],
          commits: [],
          files: ['docs/x/a.md'],
        };
      },
    );
    return { result, checks, heads, stale, lookups };
  };
  const worktree = join(root, '..', 'wt');
  const absolute = resolve(root, 'elsewhere').replaceAll('\\', '/');

  const pushes: [command: string, dir: string, tool?: string][] = [
    ['git -C ../wt push', worktree],
    ['git -C ../wt push', worktree, 'PowerShell'],
    // The last -C wins, resolved against the ones before it, as git reads them.
    ['git -C a -C b push', join(root, 'a', 'b')],
    [`git -C a -C ${absolute} push -u origin x`, resolve(absolute)],
    ['cd ../wt && git push', worktree],
    ['cd ../wt; git push', worktree],
    ['cd a && cd b && git push', join(root, 'a', 'b')],
    ['cd a && git -C b push', join(root, 'a', 'b')],
    ['cd ../wt && npm test && git push 2>&1 | tail -5', worktree],
    ['(cd ../wt && git push)', worktree],
    ['pushd ../wt && git push', worktree],
    ['cd -P ../wt && git push', worktree],
    ['env -C ../wt git push', worktree],
    ['env --chdir=../wt git push', worktree],
    ['sudo -D ../wt git push', worktree],
    ['sudo --chdir=../wt git push', worktree],
    ['bash -c "cd ../wt && git push"', worktree],
    [`cd ${absolute} && git push`, resolve(absolute)],
    ['Set-Location ../wt; git push', worktree, 'PowerShell'],
    ['Set-Location -Path ../wt; git push', worktree, 'PowerShell'],
    ['sl ../wt; git push', worktree, 'PowerShell'],
    ['cd..; git push', join(root, '..'), 'PowerShell'],
    ['cd\\; git push', resolve(root, '\\'), 'PowerShell'],
    ['chdir ../wt && git push', worktree],
    ['Set-Location -LiteralPath ../wt; git push', worktree, 'PowerShell'],
    ['Set-Location -Path:../wt; git push', worktree, 'PowerShell'],
    ['Push-Location -StackName s ../wt; git push', worktree, 'PowerShell'],
    // A pull request after the push: only the push is checked (ADR 0135).
    ['cd ../wt && git push && gh pr create --draft', worktree],
    ['cd ../wt && gh pr create --draft && git push', worktree],
    // gh pr create's directory is no tree to check, so it adds no second one.
    ['git -C ../wt push && cd a && gh pr create --draft', worktree],
  ];
  for (const [command, dir, tool = 'Bash'] of pushes) {
    it(`checks the pushed tree in ${tool}: ${command}`, async () => {
      const { result, checks, heads, stale } = await gate(command, tool);
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.deepEqual(heads, [dir]);
      assert.deepEqual(stale, [dir]);
      assert.deepEqual(checks, [dir]);
    });
  }

  it('names the pushed tree when its HEAD is detached', async () => {
    const { result, checks } = await gate('git -C ../wt push', 'Bash', true);
    assert.deepEqual(result, {
      exitCode: 2,
      stderr: `git push is blocked: HEAD is detached in ${worktree}, so new commits are on no branch; switch to your branch, move it to those commits, and push again.\n`,
    });
    assert.deepEqual(checks, []);
  });

  for (const command of ['cd ../wt && gh pr ready', 'cd ../wt && gh pr ready 5']) {
    it(`looks the pull request up where gh runs: ${command}`, async () => {
      const { result, lookups } = await gate(command);
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.deepEqual(lookups, [worktree]);
    });
  }

  it('still checks the hook cwd when nothing changes directory', async () => {
    const { checks, heads } = await gate('git -c core.x=1 push');
    assert.deepEqual(heads, [root]);
    assert.deepEqual(checks, [root]);
  });

  it('blocks pushes from two trees in one command with one line', async () => {
    const { result, checks, heads } = await gate('git -C a push; git -C b push');
    assert.deepEqual(result, {
      exitCode: 2,
      stderr: `This command pushes from more than one directory (${join(root, 'a')}, ${join(root, 'b')}), or the gate read its directory two ways (write the path with /): the gate checks one tree per command; run each from a command of its own.\n`,
    });
    assert.deepEqual(heads, []);
    assert.deepEqual(checks, []);
  });

  // The review of #301: a wrapper's option with its value attached, and cmd's switches before
  // the command it runs.
  const attached: [command: string, dir: string][] = [
    ['env -C../wt git push', worktree],
    ['sudo -D../wt git push', worktree],
    ['cmd /c "cd /d ../wt && git push"', worktree],
    // Second round: getopt's option groups and abbreviated long options, and a reading of a
    // command with an unclosed quote in one dialect (PowerShell does not escape with \).
    ['env -iC ../wt git push', worktree],
    ['env -iC../wt git push', worktree],
    ['env --chd=../wt git push', worktree],
    ['env --chd ../wt git push', worktree],
    ['bash -c "cd ../wt && echo it\\\\\'s && git push"', worktree],
  ];
  for (const [command, dir] of attached) {
    it(`checks the pushed tree: ${command}`, async () => {
      const { result, checks, heads } = await gate(command);
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.deepEqual(heads, [dir]);
      assert.deepEqual(checks, [dir]);
    });
  }

  const PUSH_COMPUTED =
    'git push is blocked: it runs in a directory computed at run time (such as cd "$d" or git -C $d), so the gate cannot tell which tree to check: push from inside the worktree, or name its path as it is.\n';
  const computed: [command: string, tool?: string][] = [
    ['cd "$d" && git push'],
    ['cd $d; git push'],
    ['git -C $d push'],
    ['git -C "$(git rev-parse --show-toplevel)" push'],
    ['git -C a -C "$d" push'],
    ['cd - && git push'],
    ['cd && git push'],
    ['popd && git push'],
    ['cd ~- && git push'],
    ['env -C "$d" git push'],
    // wsl's directory is a Linux path, which the gate does not map to Windows.
    ['wsl --cd /mnt/d/wt git push'],
    // A nested command after a change of directory: the gate cannot tell where it runs.
    ['cd ../wt && bash -c "git push"'],
    ['Set-Location $env:WT; git push', 'PowerShell'],
    ['Pop-Location; git push', 'PowerShell'],
    ['D:; git push', 'PowerShell'],
  ];
  for (const [command, tool = 'Bash'] of computed) {
    it(`blocks a push from a directory computed at run time in ${tool}: ${command}`, async () => {
      const { result, checks, heads } = await gate(command, tool);
      assert.deepEqual(result, { exitCode: 2, stderr: PUSH_COMPUTED });
      assert.deepEqual(heads, []);
      assert.deepEqual(checks, []);
    });
  }

  it('blocks gh pr ready without a number from a directory computed at run time', async () => {
    const { result, lookups } = await gate('cd "$d" && gh pr ready');
    assert.deepEqual(result, {
      exitCode: 2,
      stderr:
        'gh pr ready is blocked: it runs in a directory computed at run time (such as cd "$d"), so the gate cannot tell which pull request it marks ready: give the pull request number.\n',
    });
    assert.deepEqual(lookups, []);
  });

  it('looks up a numbered pull request in the hook cwd after a computed cd', async () => {
    const { result, lookups } = await gate('cd "$d" && gh pr ready 5');
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(lookups, [root]);
  });

  it('lets a computed cd through when nothing is pushed', async () => {
    const { result } = await gate('cd "$d" && git status');
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
  });

  // The push before it checked the tree the pull request opens (ADR 0135).
  it('lets gh pr create through from a directory computed at run time, checking nothing', async () => {
    const { result, checks, heads } = await gate('cd "$d" && gh pr create --draft');
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(checks, []);
    assert.deepEqual(heads, []);
  });
});

describe('precheck on a push from outside the project', () => {
  // The project holds the hook's checkout and ../wt; ../other is someone else's tree, whose
  // check script the gate must not run before the command is approved (review of #301).
  const other = join(root, '..', 'other');
  const gate = async (command: string, cwd = root) => {
    const { calls: checks, runCheck } = fakeCheck({ ok: true, output: '' });
    const heads: string[] = [];
    const lookups: string[] = [];
    const asked: string[] = [];
    const result = await precheck(
      hookInput(command, cwd),
      runCheck,
      async () => undefined,
      async (cwd) => {
        heads.push(cwd);
        return false;
      },
      async (cwd) => {
        lookups.push(cwd);
        return {
          number: 5,
          head: 'a'.repeat(40),
          comments: [],
          commits: [],
          files: ['docs/x/a.md'],
        };
      },
      undefined,
      async (dir) => {
        asked.push(dir);
        return dir !== other;
      },
    );
    return { result, checks, heads, lookups, asked };
  };

  const outside: [command: string, line: string][] = [
    [
      'git -C ../other push',
      `git push is blocked: it runs in ${other}, outside the project this session works in, so the gate does not run that tree's code: push from inside that checkout.`,
    ],
    [
      'cd ../other && gh pr ready',
      `gh pr ready is blocked: it runs in ${other}, outside the project this session works in, so the gate does not run that tree's code: run gh pr ready from inside that checkout.`,
    ],
  ];
  for (const [command, line] of outside) {
    it(`blocks with one line, running nothing there: ${command}`, async () => {
      const { result, checks, heads, lookups } = await gate(command);
      assert.deepEqual(result, { exitCode: 2, stderr: `${line}\n` });
      assert.deepEqual(checks, []);
      assert.deepEqual(heads, []);
      assert.deepEqual(lookups, []);
    });
  }

  // gh pr create runs none of that tree's code (ADR 0135).
  it('lets gh pr create through from outside the project, running nothing there', async () => {
    const { result, checks, heads } = await gate('cd ../other && gh pr create --draft');
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(checks, []);
    assert.deepEqual(heads, []);
  });

  it('checks a tree inside the project', async () => {
    const { result, checks, asked } = await gate('git -C ../wt push');
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(asked, [join(root, '..', 'wt')]);
    assert.deepEqual(checks, [join(root, '..', 'wt')]);
  });

  // gh pr ready with a number looks the pull request up where the hook runs, as before.
  it("does not ask about the hook's own directory: gh pr ready 5", async () => {
    const { result, asked } = await gate('gh pr ready 5');
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(asked, []);
  });

  // A push that changes no directory runs in the hook's working directory, which takes the same
  // test: a session's directory lasts between commands (ADR 0246).
  it("checks the hook's own directory for a push", async () => {
    const { result, asked, checks } = await gate('git push');
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(asked, [root]);
    assert.deepEqual(checks, [root]);
  });

  for (const command of ['git push', 'git push -u origin 613-x', 'npm test && git push']) {
    it(`blocks a push that starts outside the project, running nothing there: ${command}`, async () => {
      const { result, checks, heads } = await gate(command, other);
      assert.deepEqual(result, {
        exitCode: 2,
        stderr: `git push is blocked: it runs in ${other}, outside the project this session works in, so the gate does not run that tree's code: push from inside that checkout.\n`,
      });
      assert.deepEqual(checks, []);
      assert.deepEqual(heads, []);
    });
  }

  // gh runs none of that tree's code (ADR 0135, ADR 0246).
  for (const command of ['gh pr create --draft', 'gh pr ready 5']) {
    it(`lets ${command} through from a starting directory outside the project`, async () => {
      const { result, checks } = await gate(command, other);
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.deepEqual(checks, []);
    });
  }
});

describe('projectHolds', () => {
  // A real-path resolver that records what it was asked, as the identity.
  const resolver = (fails = false) => {
    const calls: string[] = [];
    const realPath = (path: string): string => {
      calls.push(path);
      if (fails) throw new Error('EACCES');
      return path;
    };
    return { calls, realPath };
  };
  const project = 'D:\\code\\foedrum';
  const cases: [name: string, root: string | undefined, dir: string, holds: boolean][] = [
    ['the project itself', project, project, true],
    ['a worktree', project, `${project}\\.claude\\worktrees\\x`, true],
    ['a sibling folder', project, 'D:\\code\\other', false],
    // A review's scratch clone may hold someone else's branch.
    ['a scratch clone', project, `${project}\\.foedrum\\tmp\\132\\scratch\\tree`, false],
    [
      "a worktree's scratch clone",
      project,
      `${project}\\.claude\\worktrees\\x\\.foedrum\\tmp\\s\\tree`,
      false,
    ],
    ['no project', undefined, `${project}\\wt`, false],
    ['a relative project', 'foedrum', `${project}\\wt`, false],
  ];
  for (const [name, root, dir, holds] of cases) {
    it(`is ${holds} for ${name}`, async () => {
      const { realPath } = resolver();
      assert.equal(await projectHolds(root, dir, 'win32', realPath), holds);
    });
  }

  // Resolving these would reach the network or a device before the command is approved.
  for (const dir of ['\\\\host\\share\\wt', '\\\\?\\D:\\code\\foedrum', 'E:\\wt']) {
    it(`refuses ${dir} without resolving it`, async () => {
      const { calls, realPath } = resolver();
      assert.equal(await projectHolds(project, dir, 'win32', realPath), false);
      assert.deepEqual(calls, []);
    });
  }

  it('refuses a directory it cannot resolve', async () => {
    const { realPath } = resolver(true);
    assert.equal(await projectHolds(project, `${project}\\wt`, 'win32', realPath), false);
  });

  it('compares POSIX paths', async () => {
    const { realPath } = resolver();
    assert.equal(await projectHolds('/srv/foedrum', '/srv/foedrum/wt', 'linux', realPath), true);
    assert.equal(await projectHolds('/srv/foedrum', '/srv/other', 'linux', realPath), false);
  });
});

describe('resolvePlace', () => {
  const home = { win32: 'C:\\Users\\dev', posix: '/home/dev' };
  const cases: [name: string, path: PathModule, cwd: string, steps: string[], dir: string][] = [
    ['no step', win32, 'D:\\code\\foedrum', [], 'D:\\code\\foedrum'],
    ['a relative step', win32, 'D:\\code\\foedrum', ['..\\wt'], 'D:\\code\\wt'],
    ["Git Bash's drive path", win32, 'D:\\code\\foedrum', ['/c/work/wt'], 'C:\\work\\wt'],
    ["Git Bash's drive root", win32, 'D:\\code\\foedrum', ['/e'], 'E:\\'],
    ['a home path', win32, 'D:\\code', ['~/wt'], 'C:\\Users\\dev\\wt'],
    ['home', posix, '/srv/foedrum', ['~'], '/home/dev'],
    ['steps in order', posix, '/srv/foedrum', ['a', '../b', 'c'], '/srv/foedrum/b/c'],
    ['an absolute step', posix, '/srv/foedrum', ['a', '/d/code'], '/d/code'],
  ];
  for (const [name, path, cwd, steps, dir] of cases) {
    it(`resolves ${name} (${path === win32 ? 'win32' : 'posix'})`, () => {
      const given = path === win32 ? home.win32 : home.posix;
      assert.equal(resolvePlace(cwd, steps, path, given), dir);
    });
  }
});

describe('forbiddenReason', () => {
  const forcePushes = [
    'git push --force',
    'git push origin main --force',
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc123 origin main',
    'git push -f',
    'git push origin main -f',
    'git push -uf origin main',
    'git push origin +main',
    'git push origin +HEAD:main',
    'git -C ../foedrum push --force',
    'npm run check && git push -f',
    'cd repo; git push origin +main',
    // git takes a unique prefix of a long option, and the gate also blocks an ambiguous one that
    // may expand to a force (ADR 0246).
    'git push --for origin x',
    'git push --forc origin x',
    'git push --force-w origin x',
    'git push --force-with=main origin x',
    'git push --force-i origin x',
    'git push --fo origin x',
    'git --attr-source -h push -f origin x',
  ];
  for (const command of forcePushes) {
    it(`forbids force push: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /force push/i);
    });
  }

  const merges = [
    'gh pr merge 30',
    'gh pr merge --squash --admin',
    'git status && gh pr merge 30',
    'gh -R owner/repo pr merge 30',
    'gh --repo owner/repo pr merge 30',
    'gh --repo=owner/repo pr merge 30',
    'gh pr -R owner/repo merge 30',
    'gh pr --repo owner/repo merge 30',
  ];
  for (const command of merges) {
    it(`forbids merging a pull request: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /^`gh pr merge` is blocked/);
    });
  }

  const deletingPushes = [
    'git push origin --delete old-branch',
    'git push -d origin old-branch',
    'git push origin :old-branch',
    'git push --mirror',
    'git push origin --mirror',
    'git -C ../foedrum push origin --delete old-branch',
    'npm test && git push origin :old-branch',
    // By prefix, and --prune in every form (ADR 0246).
    'git push --del origin x',
    'git push origin --dele x',
    'git push --mirr',
    'git push --mir origin',
    'git push --d origin x',
    'git push --prune origin',
    "git push --prune origin 'refs/heads/*:refs/heads/*'",
    'git push --pru origin',
    'git push --pr origin',
  ];
  for (const command of deletingPushes) {
    it(`forbids deleting or mirroring remote refs: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /delet.*mirror|mirror.*delet/i);
    });
  }

  const allowed = [
    'git push',
    'git push -u origin 24-local-gate',
    'git push --follow-tags',
    'git push --no-force-with-lease',
    'git push -o ci.skip origin main',
    'git push origin HEAD:main',
    'git push --dry-run origin main',
    'git push --dry origin 613-x',
    'git push --set-upstream origin 613-x',
    'git push --follow-tags --progress --no-verify origin 613-x',
    'git push --porcelain origin 613-x',
    'git -c core.quotePath=false push origin 613-x',
    'git config --get user.name',
    'git merge origin/main',
    'git commit -m "never force push: use git push -f only in emergencies"',
    'gh pr create --draft',
    'gh pr view 30',
    'gh -R owner/repo pr view 30',
    'echo git push --force',
  ];
  for (const command of allowed) {
    it(`does not forbid: ${command}`, () => {
      assert.equal(forbiddenReason(command), undefined);
    });
  }
});

// git's configuration can make a push delete, force or mirror; the gate reads where it comes from on
// the command line (ADR 0246). What the configuration files hold is read before the push.
describe('forbiddenReason on a push configured on its command line', () => {
  const configured = [
    'git -c remote.origin.mirror=true push origin',
    'git -c push.default=matching push',
    'git -c Remote.origin.Push=:refs/heads/x push',
    'git -c core.quotePath=false -c remote.origin.push=+HEAD push',
    'git --config-env=remote.origin.mirror=MIRROR push',
    'git --config-env remote.origin.push=SPEC push',
    // An included file may set a remote's settings (review of #635).
    'git -c include.path=mirror.cfg push',
    'git -c includeIf.onbranch:main.path=mirror.cfg push',
    'git -c "$setting" push',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.mirror GIT_CONFIG_VALUE_0=true git push',
    `GIT_CONFIG_PARAMETERS="'remote.origin.mirror'='true'" git push`,
    'GIT_CONFIG_GLOBAL=mirror.cfg git push',
    'git config remote.origin.push :refs/heads/x && git push',
    'git remote add --mirror=push backup ../b && git push backup',
  ];
  for (const command of configured) {
    it(`forbids: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /^git push is blocked .*git's configuration/);
    });
  }

  it('forbids a push configured in PowerShell', () => {
    const command = '$env:GIT_CONFIG_PARAMETERS = "x"; git push';
    assert.match(forbiddenReason(command) ?? '', /git's configuration/);
  });

  // Only a push is held to it: configuration alone sends nothing.
  for (const command of [
    'git -c remote.origin.mirror=true fetch',
    'git config remote.origin.push refs/heads/main',
    'GIT_CONFIG_COUNT=0 git status',
  ]) {
    it(`does not forbid: ${command}`, () => {
      assert.equal(forbiddenReason(command), undefined);
    });
  }
});

// The bypasses from the independent review of #30 (#42): wrappers, other shells, substitutions,
// variables and quoted paths. Each case is a force push or a merge in disguise.
describe('forbiddenReason through wrappers and other shells', () => {
  const encoded = (command: string): string => Buffer.from(command, 'utf16le').toString('base64');
  const forcePushes = [
    // Wrapper words before the program.
    'command git push -f',
    'exec git push --force',
    'env git push -f',
    'env -i GIT_TRACE=1 git push -f',
    'env -u HOME git push -f',
    'time git push -f',
    'time -p git push -f',
    'nohup git push -f',
    'nice -n 5 git push -f',
    'timeout 60 git push -f',
    'echo origin | xargs git push -f',
    'xargs -n 1 git push --force',
    'npx git push -f',
    'npm exec -- git push -f',
    'pnpm dlx git push --force',
    'npx -c "git push -f"',
    'npm exec --call "git push --force"',
    'command env time git push -f',
    'env -S "git push -f"',
    "Start-Process git -ArgumentList 'push','-f'",
    'Start-Process -FilePath git -ArgumentList "push --force" -Wait',
    "Start-Process git 'push -f'",
    "Start-Process git -ArgumentList @('push', '-f') -NoNewWindow",
    'start git push -f',
    // Other shells.
    'bash -c "git push -f"',
    "sh -c 'git push --force'",
    'zsh -c "git push origin +main"',
    'pwsh -c "git push -f"',
    'pwsh -Command "git push -f"',
    'powershell -NoProfile -Command "git push -f"',
    'pwsh -c git push -f',
    'powershell "git push -f"',
    `pwsh -EncodedCommand ${encoded('git push -f')}`,
    `powershell -enc ${encoded('git push --force')}`,
    'cmd /c git push -f',
    'cmd.exe /C "git push -f"',
    'cmd /s /c "git push --force"',
    'cmd /c g^it push -f',
    'iex "git push -f"',
    "Invoke-Expression 'git push -f'",
    '$c = "git push -f"; iex $c',
    'eval "git push -f"',
    "echo 'git push -f' | bash",
    'echo git push -f | sh',
    // Substitutions and variables.
    '$(echo git) push -f',
    '`echo git` push -f',
    'echo "`git push -f`"',
    '$g="git"; & $g push -f',
    'g=git; $g push -f',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a placeholder
    '"${g}" push --force',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a placeholder
    '${g} push -f',
    // A quoted path with a space, and escapes inside the program name.
    '"C:\\Program Files\\Git\\cmd\\git.exe" push -f',
    "& 'C:\\Program Files\\Git\\cmd\\git.exe' push --force",
    '"/c/Program Files/Git/cmd/git" push -f',
    'g\\it push -f',
    'g`it push -f',
    'git.cmd push -f',
  ];
  for (const command of forcePushes) {
    it(`forbids force push: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /force push/i);
    });
  }

  const merges = [
    'command gh pr merge 30',
    'env GH_TOKEN=x gh pr merge 30',
    'bash -c "gh pr merge 30"',
    'pwsh -Command "gh pr merge 30 --squash"',
    'cmd /c gh pr merge 30',
    "iex 'gh pr merge 30'",
    "Start-Process gh -ArgumentList 'pr','merge','30'",
    '"C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 30',
    '$gh pr merge 30',
    // A brace group runs its commands; only a {name} inside a word is text in bash.
    '{ gh pr merge 30; }',
    'x{a}; gh pr merge 30',
  ];
  for (const command of merges) {
    it(`forbids merging a pull request: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /^`gh pr merge` is blocked/);
    });
  }

  // gh pr with an action computed at run time could be a merge.
  for (const command of ['gh pr $(echo merge) 30', 'gh pr $action 30', 'gh $(echo pr) merge 30']) {
    it(`forbids a gh pr action it cannot read: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /computed at run time/);
    });
  }

  it('blocks commands nested too deeply to check', () => {
    assert.match(forbiddenReason(`${'eval '.repeat(40)}git status`) ?? '', /too deeply/);
  });

  // Quotes are honoured, so a separator in a string does not start a command.
  for (const command of [
    'git commit -m "fix; git push -f later"',
    "git commit -m 'never; gh pr merge 30'",
  ]) {
    it(`does not forbid: ${command}`, () => {
      assert.equal(forbiddenReason(command), undefined);
    });
  }
});

// A command bash or PowerShell could not run (an unclosed quote) is read without its quotes, so
// honouring quotes never hides a push behind a stray one (#42).
describe('forbiddenReason on a command with an unclosed quote', () => {
  for (const command of ['echo "unclosed; git push -f', "echo 'unclosed\ngit push -f"]) {
    it(`reads it without its quotes: ${JSON.stringify(command)}`, () => {
      assert.match(forbiddenReason(command) ?? '', /force push/i);
    });
  }
});

// Commands that look like the bypasses above but neither push nor merge (#42).
describe('forbiddenReason and isGatedCommand on look-alikes of the bypasses', () => {
  // Text in a string is not a command unless something runs it.
  const allowed = [
    'echo "git push -f"',
    "echo 'gh pr merge 30'",
    'git push -u origin "$(git branch --show-current)"',
    'gh pr create --body "$(cat body.md)"',
    'time npm test',
    'env',
    'xargs rm < list.txt',
    'bash scripts/build.sh',
    'pwsh -File scripts/build.ps1',
    'cmd /c dir',
    'Start-Process notepad -ArgumentList notes.txt',
    'git config alias.st status',
    'git config user.name "Synthetic Person"',
    "gh alias set co 'pr checkout'",
    '$x = 1; Write-Output $x',
    'bash -c "git push"',
    'echo $HOME',
  ];
  for (const command of allowed) {
    it(`does not forbid: ${command}`, () => {
      assert.equal(forbiddenReason(command), undefined);
    });
  }

  const ungated = [
    'git commit -m "then git push"',
    'echo "gh pr create"',
    'bash -c "git status"',
    'pwsh -Command "gh pr view 30"',
    '$x = 1',
  ];
  for (const command of ungated) {
    it(`lets through: ${command}`, () => {
      assert.equal(isGatedCommand(command), false);
    });
  }
});

// Disguises the gate already caught because it split on ( { & | ; even inside quotes, or stripped
// quotes from words. They must stay caught once it honours quotes (#42).
describe('forbiddenReason and isGatedCommand on disguises caught before #42', () => {
  const forcePushes = [
    "'git push -f' | iex",
    'Invoke-Command -ScriptBlock ([scriptblock]::Create("git push -f"))',
    "Invoke-Expression('git push -f')",
    'bash -lc "cd repo && git push -f"',
    'echo "$(git push -f)"',
    'echo $(git push -f)',
    'git push "-f"',
    'git push origin "+main"',
    'powershell.exe -Command "& { git push -f }"',
  ];
  for (const command of forcePushes) {
    it(`forbids force push: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /force push/i);
    });
  }

  it('forbids merging a pull request: gh pr "merge" 30', () => {
    assert.match(forbiddenReason('gh pr "merge" 30') ?? '', /^`gh pr merge` is blocked/);
  });

  it('gates: X=$(date) git push', () => {
    assert.equal(isGatedCommand('X=$(date) git push'), true);
  });
});

// Each shell's own escapes inside quotes, and the ends of options and substitutions (#42).
describe('forbiddenReason on quoting details', () => {
  const forcePushes = [
    // PowerShell doubles a quote inside a string; bash reads '' as two empty strings.
    "iex 'echo ''it''; git push -f'",
    'iex "echo ""it""; git push -f"',
    // -- ends a wrapper's options.
    'env -- git push -f',
    'nice -n 5 -- git push --force',
    // An unclosed substitution is read without it.
    'echo $(git push -f',
  ];
  for (const command of forcePushes) {
    it(`forbids force push: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /force push/i);
    });
  }

  const allowed = [
    // A doubled quote stays inside the PowerShell string; an escaped one inside the bash string.
    "git commit -m 'it''s; git push -f'",
    'git commit -m "say \\"hi\\"; git push -f"',
  ];
  for (const command of allowed) {
    it(`does not forbid: ${command}`, () => {
      assert.equal(forbiddenReason(command), undefined);
    });
  }
});

describe('isGatedCommand through wrappers and other shells', () => {
  const gated = [
    'command git push',
    'env FOO=1 git push -u origin 42-harden-gate',
    'time git push',
    'bash -c "git push"',
    'pwsh -Command "git push"',
    'cmd /c git push',
    "iex 'git push'",
    '"C:\\Program Files\\Git\\cmd\\git.exe" push',
    "& 'C:\\Program Files\\Git\\cmd\\git.exe' push",
    'Start-Process git -ArgumentList push',
    // A program or subcommand computed at run time may be git push.
    '$g push',
    '& $g push origin main',
    'git $(echo push)',
    'git $sub',
  ];
  for (const command of gated) {
    it(`gates: ${command}`, () => {
      assert.equal(isGatedCommand(command), true);
    });
  }
});

describe('precheck on pushes hidden from a plain search for git', () => {
  // A command that never spells git or gh still reaches the parser when it may push or merge.
  const hidden = [
    `pwsh -EncodedCommand ${Buffer.from('git push -f', 'utf16le').toString('base64')}`,
    '$a = [char]103 + "it"; & $a push -f',
  ];
  for (const command of hidden) {
    it(`blocks: ${command}`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
      const result = await precheck(hookInput(command, root, 'PowerShell'), runCheck);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /force push/i);
      assert.deepEqual(calls, []);
    });
  }

  it('checks HEAD for a push through another shell', async () => {
    const { runCheck } = fakeCheck({ ok: true, output: '' });
    const heads: string[] = [];
    const headIsDetached = async (cwd: string): Promise<boolean> => {
      heads.push(cwd);
      return true;
    };
    const result = await precheck(
      hookInput('bash -c "git push"', '/work/tree'),
      runCheck,
      async () => undefined,
      headIsDetached,
    );
    assert.match(result.stderr, /^git push is blocked: HEAD is detached/);
    assert.deepEqual(heads, ['/work/tree']);
  });
});

// The tool says which shell runs the command, so the gate reads it that way only; what that
// command runs in turn is still read both ways (#42).
describe("precheck reads a command in its tool's shell", () => {
  const cases: [name: string, tool: string | undefined, command: string, gated: boolean][] = [
    ['an escaped quote in a bash string', 'Bash', 'grep -E "a \\"|gh pr create" notes.md', false],
    [
      'an escaped quote in a PowerShell string',
      'PowerShell',
      'Write-Output "a `"|git push"',
      false,
    ],
    ['a bash escape PowerShell does not know', 'PowerShell', 'echo a \\"|git push', true],
    ['a nested shell, read both ways', 'Bash', `pwsh -c 'Write-Output "a \\"|git push"'`, true],
    ['a command from an unknown tool, read both ways', undefined, 'echo "a \\"|git push"', true],
  ];
  for (const [name, tool, command, gated] of cases) {
    it(`${gated ? 'gates' : 'lets through'} ${name}: ${command}`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
      const input = JSON.stringify({
        hook_event_name: 'PreToolUse',
        ...(tool === undefined ? {} : { tool_name: tool }),
        tool_input: { command },
        cwd: '/work/tree',
      });
      assert.deepEqual(await precheck(input, runCheck), { exitCode: 0, stderr: '' });
      assert.deepEqual(calls, gated ? ['/work/tree'] : []);
    });
  }
});

// Bypasses found by the review of #123 (#42), most of which the old gate caught.
describe('forbiddenReason on the bypasses found in review', () => {
  const forcePushes = [
    // An apostrophe in a comment or a heredoc body is no quote to the shell.
    "# don't rebase\ngit push -f\n# it's fine",
    "cat > a.md <<'EOF'\nIt's a fix\nEOF\ngit push -f\necho it's",
    "<# don't #>\ngit push -f\n# it's",
    // Reserved words and PowerShell assignments before the program.
    'if true; then git push -f; fi',
    'for b in x; do git push --force origin $b; done',
    'while true; do git push -f; done',
    '! git push -f',
    '$out = git push -f 2>&1',
    '$log += git push --force',
    // cmd as Git Bash spells it.
    'cmd //c git push -f',
    // A quoted program path with a space, through Start-Process.
    'Start-Process -FilePath "C:\\Program Files\\Git\\cmd\\git.exe" -ArgumentList "push -f"',
    // A line continuation before CRLF.
    'git push origin main `\r\n  --force',
    'git push origin main \\\r\n  --force',
    // Interpreters that run code given on the command line.
    `node -e "cp.execSync('git push -f', { stdio: 'inherit' })"`,
    `node --eval "execSync('git push --force')"`,
    `python -c "import os; os.system('git push -f')"`,
    `python3 -c "import subprocess; subprocess.run(['git', 'push', '-f'])"`,
    `perl -e "system('git push -f')"`,
    `ruby -e "system('git push -f')"`,
    // bash's $'…' escapes a quote with a backslash.
    "echo $'\\'' ; git push -f ; echo \\'",
  ];
  for (const command of forcePushes) {
    it(`forbids force push: ${JSON.stringify(command)}`, () => {
      assert.match(forbiddenReason(command) ?? '', /force push/i);
    });
  }

  for (const command of ['$null = gh pr merge 30', 'if true; then gh pr merge 30; fi']) {
    it(`forbids merging a pull request: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /^`gh pr merge` is blocked/);
    });
  }
});

// Bypasses found by the second review of #123 (#42).
describe('precheck on words split by quotes and escapes', () => {
  // The pre-filter reads the raw hook input, where quotes and escapes still split the words.
  const split: [tool: string | undefined, command: string, reason: RegExp][] = [
    ['Bash', "gi''t pu''sh -f", /force push/i],
    ['Bash', 'g\\it pu\\sh -f', /force push/i],
    ['Bash', 'g"i"t p"u"sh --force', /force push/i],
    ['Bash', 'cmd /c g^h pr m^erge 30', /^`gh pr merge` is blocked/],
    // PowerShell takes typographic quotes as quotes.
    [undefined, '& “g”it pu“”sh -f', /force push/i],
  ];
  for (const [tool, command, reason] of split) {
    it(`blocks: ${command}`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
      const input = JSON.stringify({
        ...(tool === undefined ? {} : { tool_name: tool }),
        tool_input: { command },
        cwd: '/work/tree',
      });
      assert.doesNotMatch(input, /git|gh|push|merge|pwsh|powershell/i);
      const result = await precheck(input, runCheck);
      assert.equal(result.exitCode, 2, result.stderr);
      assert.match(result.stderr, reason);
      assert.deepEqual(calls, []);
    });
  }
});

// A line continuation inside a word, which each shell removes before it reads the word (#158).
describe('precheck on words split by line continuations', () => {
  const split: [tool: string, command: string][] = [];
  for (const newline of ['\n', '\r\n']) {
    split.push(
      ['Bash', `g\\${newline}it pu\\${newline}sh`],
      ['PowerShell', `g\`${newline}it pu\`${newline}sh`],
      // Quoted, since bash ends an unquoted command at the newline.
      ['Bash', `cmd /c "g^${newline}it pu^${newline}sh"`],
    );
  }
  for (const [tool, command] of split) {
    it(`runs the check like git push: ${tool} ${JSON.stringify(command)}`, async () => {
      assert.doesNotMatch(command, /git|push/i);
      const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
      const input = JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: '/work/tree' });
      const result = await precheck(input, runCheck);
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.deepEqual(calls, ['/work/tree']);
    });
    it(`blocks a force push like git push -f: ${tool} ${JSON.stringify(command)}`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
      const input = JSON.stringify({
        tool_name: tool,
        tool_input: { command: `${command} -f` },
        cwd: '/work/tree',
      });
      const result = await precheck(input, runCheck);
      assert.equal(result.exitCode, 2, result.stderr);
      assert.match(result.stderr, /force push/i);
      assert.deepEqual(calls, []);
    });
  }

  // Bash removes a backslash-newline inside double quotes too (#359).
  const FORCE =
    'Force push is blocked: update a pushed branch by merging origin/main; never rebase or force-push a branch that has been pushed (CLAUDE.md).';
  // Bash may keep the CR of a backslash-CRLF: the PowerShell reading of the nested string still
  // reads its next line as a command. An escaped backslash keeps its newline (review of #372).
  it('still reads the line after a backslash-CRLF in double quotes as a command', () => {
    assert.equal(forbiddenReason('bash -c "echo \\\r\ngit push -f"'), FORCE);
  });
  it('reads no push after an escaped backslash and a newline', () => {
    assert.equal(forbiddenReason('git "pu\\\\\nsh" -f'), undefined);
  });
  for (const newline of ['\n', '\r\n']) {
    const command = `bash -c "g\\${newline}it push -f"`;
    it(`blocks a force push split inside a nested shell's string: ${JSON.stringify(command)}`, () => {
      assert.equal(forbiddenReason(command), FORCE);
    });
  }
  for (const newline of ['\n', '\r\n']) {
    const command = `git "pu\\${newline}sh" -f`;
    it(`blocks a force push split inside double quotes: ${JSON.stringify(command)}`, () => {
      assert.equal(forbiddenReason(command), FORCE);
    });
    it(`runs the check like git push: ${JSON.stringify(`git "pu\\${newline}sh"`)}`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
      const command = `git "pu\\${newline}sh"`;
      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command },
        cwd: '/work/tree',
      });
      const result = await precheck(input, runCheck);
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.deepEqual(calls, ['/work/tree']);
    });
  }

  // A backslash before n that is no line continuation keeps its n, in the raw input as in the
  // command (#158, review of #355).
  const backslashN: string[] = [
    'bash -c "\\\\npx some-pkg"',
    '"C:\\\\tools\\\\npx.cmd" cowsay',
    'x=`\\npx cowsay`',
  ];
  for (const command of backslashN) {
    it(`still reads npx after a backslash: ${JSON.stringify(command)}`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command },
        cwd: '/work/tree',
      });
      const result = await precheck(input, runCheck);
      assert.equal(result.exitCode, 2, result.stderr);
      assert.match(result.stderr, /would download a package/);
      assert.deepEqual(calls, []);
    });
  }
});

describe('forbiddenReason on the bypasses found in the second review', () => {
  const forcePushes = [
    // PowerShell's typographic quotes.
    '& “C:\\Program Files\\Git\\cmd\\git.exe” push -f',
    'iex “git push -f”',
    'iex ‘git push -f’',
    // A shell computed at run time runs its strings.
    '"$SHELL" -c "git push --force origin main"',
    // wsl runs git against the same checkout.
    'wsl git push -f',
    'wsl -e git push -f',
    'wsl.exe -- git push --force',
    'wsl -d Ubuntu git push -f',
    // PowerShell's dot operator runs a command too.
    '. git push -f',
  ];
  for (const command of forcePushes) {
    it(`forbids force push: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /force push/i);
    });
  }

  it("forbids merging a pull request: & $pwsh -Command 'gh pr merge 12'", () => {
    assert.match(
      forbiddenReason("& $pwsh -Command 'gh pr merge 12'") ?? '',
      /^`gh pr merge` is blocked/,
    );
  });

  it("does not block a closed @( that holds a parenthesis: $p = @('(') ; git status", () => {
    assert.equal(forbiddenReason("$p = @('(') ; git status"), undefined);
  });
});

// Limits and the pre-filter, pinned after the review of #123 (#42).
describe('precheck limits and pre-filter', () => {
  it('blocks a command too wide to read, though shallow', () => {
    const strings = Array.from({ length: 3000 }, (_, i) => `"x${i}"`).join(' ');
    assert.match(forbiddenReason(`bash -c ${strings}`) ?? '', /too deeply/);
  });

  // A Bash call that never spells git, gh, push or pwsh still reaches the parser.
  const hidden: [command: string, reason: RegExp][] = [
    ["a=$(printf '\\x67h'); $a pr merge 30", /^`gh pr merge` is blocked/],
    [`powershell -enc ${Buffer.from('git push -f', 'utf16le').toString('base64')}`, /force push/i],
  ];
  for (const [command, reason] of hidden) {
    it(`blocks: ${command}`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
      const input = hookInput(command, '/work/tree', 'Bash');
      assert.doesNotMatch(input.replace(/powershell|merge/gi, ''), /git|gh|push|pwsh/i);
      const result = await precheck(input, runCheck);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, reason);
      assert.deepEqual(calls, []);
    });
  }

  // The pre-filter reads only the command, so a path or description that spells git or gh does not
  // send the call to the parser (#152).
  it('lets through a command that mentions neither git nor gh without reading it, wherever the checkout is', async () => {
    const { calls, runCheck } = fakeCheck({ ok: false, output: '' });
    // Too wide to read, so the parser would block it.
    const command = `bash -c ${Array.from({ length: 3000 }, (_, i) => `"x${i}"`).join(' ')}`;
    assert.match(forbiddenReason(command) ?? '', /too deeply/);
    const input = JSON.stringify({
      session_id: 'abc123',
      transcript_path: '/home/dev/.claude/projects/-home-dev-github-foedrum/abc123.jsonl',
      cwd: '/home/dev/github/foedrum/.claude/worktrees/152-gh-git',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command, description: 'Echo strings before git push' },
    });
    assert.deepEqual(await precheck(input, runCheck), { exitCode: 0, stderr: '' });
    assert.deepEqual(calls, []);
  });

  // The tool's name no longer sends every PowerShell call to the parser (ADR 0056).
  it('lets through a PowerShell command that mentions neither git nor gh without reading it', async () => {
    const { calls, runCheck } = fakeCheck({ ok: false, output: '' });
    const command = `bash -c ${Array.from({ length: 3000 }, (_, i) => `"x${i}"`).join(' ')}`;
    assert.match(forbiddenReason(command) ?? '', /too deeply/);
    const input = hookInput(command, '/work/tree', 'PowerShell');
    assert.deepEqual(await precheck(input, runCheck), { exitCode: 0, stderr: '' });
    assert.deepEqual(calls, []);
  });

  it('lets through a tool call without a command when its path spells git', async () => {
    const { calls, runCheck } = fakeCheck({ ok: false, output: '' });
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: {}, cwd: '/home/dev/github' });
    assert.deepEqual(await precheck(input, runCheck), { exitCode: 0, stderr: '' });
    assert.deepEqual(calls, []);
  });
});

describe('precheck when the HEAD check cannot answer', () => {
  // A check that times out also blocks (#42): a hung git must not hold the gate until the hook's
  // own limit, and must not let the push through.
  it('blocks a push with one line, without running the check', async () => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
    const headIsDetached = async (): Promise<boolean> => {
      throw new Error('git symbolic-ref -q HEAD timed out after 10 s');
    };
    // The gate answers; a rejection would end the hook with a crash instead of the reason.
    const result = await precheck(
      hookInput('git push', '/work/tree'),
      runCheck,
      async () => undefined,
      headIsDetached,
    ).catch((error: unknown) => ({ rejected: String(error) }));
    assert.deepEqual(result, {
      exitCode: 2,
      stderr:
        'git push is blocked: could not tell whether HEAD is detached in /work/tree (git symbolic-ref -q HEAD timed out after 10 s).\n',
    });
    assert.deepEqual(calls, []);
  });
});

describe('gitHeadIsDetached deadline', () => {
  it('gives git symbolic-ref a deadline of at most 10 s', async () => {
    const options: (RunOptions | undefined)[] = [];
    const runProcess: RunProcess = async (_file, _args, _cwd, given) => {
      options.push(given);
      return { exitCode: 0, output: 'refs/heads/main\n' };
    };
    await gitHeadIsDetached(runProcess)('/work/tree');
    const timeoutMs = options[0]?.timeoutMs ?? Number.POSITIVE_INFINITY;
    assert.ok(timeoutMs > 0 && timeoutMs <= 10_000, String(timeoutMs));
  });

  for (const [killed, reason] of [
    ['timed-out', /git symbolic-ref -q HEAD timed out after 10 s/],
    ['stopped', /git symbolic-ref -q HEAD was stopped/],
    ['too-much-output', /git symbolic-ref -q HEAD .*output/],
  ] as const) {
    it(`rejects, saying why, when git was killed (${killed})`, async () => {
      const runProcess: RunProcess = async () => ({ exitCode: null, output: '', killed });
      await assert.rejects(gitHeadIsDetached(runProcess)('/work/tree'), reason);
    });
  }
});

describe('precheck on gh pr ready', () => {
  // A pull request whose branch has three commits of its own, c1 to c3; c3 is the head.
  const sha = (name: string): string => name.padEnd(40, '0');
  const summary = (head: string): string =>
    `## Review: \`154-gate-pr-ready\` @ \`${head.slice(0, 7)}\`\n\nBase \`4a672b5\` · 3 commits`;
  const facts = (comments: string[], commits: PullRequestFacts['commits']): PullRequestFacts => ({
    number: 160,
    head: commits.at(-1)?.sha ?? '',
    comments,
    commits,
  });
  const c1 = { sha: sha('c1c1c1c1'), parents: [sha('b0b0b0b0')] };
  const c2 = { sha: sha('c2c2c2c2'), parents: [c1.sha] };
  const c3 = { sha: sha('c3c3c3c3'), parents: [c2.sha] };
  // c2 merged with two later commits of main.
  const m3 = { sha: sha('d3d3d3d3'), parents: [c2.sha, sha('b1b1b1b1')] };
  const m4 = { sha: sha('d4d4d4d4'), parents: [m3.sha, sha('b2b2b2b2')] };

  // A lookup that records what it was asked and answers with the given pull request.
  const fakeLookup = (pullRequest: PullRequestFacts) => {
    const calls: [cwd: string, target: ReadyTarget][] = [];
    const lookupPullRequest: LookupPullRequest = async (cwd, target) => {
      calls.push([cwd, target]);
      return pullRequest;
    };
    return { calls, lookupPullRequest };
  };
  const ready = async (command: string, pullRequest: PullRequestFacts, tool = 'Bash') => {
    const { calls: checks, runCheck } = fakeCheck({ ok: true, output: '' });
    const lookup = fakeLookup(pullRequest);
    const result = await precheck(
      hookInput(command, '/work/tree', tool),
      runCheck,
      async () => undefined,
      async () => false,
      lookup.lookupPullRequest,
    );
    return { result, lookups: lookup.calls, checks };
  };

  it('blocks a pull request without a review summary, naming /brew-review as the remedy', async () => {
    const { result, lookups, checks } = await ready(
      'gh pr ready 160',
      facts(['Looks good to me.'], [c1, c2, c3]),
    );
    assert.equal(result.exitCode, 2);
    assert.match(
      result.stderr,
      /^gh pr ready is blocked: pull request #160 has no \/brew-review summary/,
    );
    assert.match(result.stderr, /run \/brew-review 160/i);
    assert.deepEqual(lookups, [['/work/tree', { pr: '160' }]]);
    assert.deepEqual(checks, []);
  });

  it('blocks a pull request whose summary is for an older head with new work after it', async () => {
    const { result } = await ready('gh pr ready 160', facts([summary(c2.sha)], [c1, c2, c3]));
    assert.equal(result.exitCode, 2);
    assert.match(
      result.stderr,
      /summary on pull request #160 is for c2c2c2c, but the head is c3c3c3c/,
    );
    assert.match(result.stderr, /run \/brew-review 160/i);
  });

  it('allows a pull request whose summary is for the head', async () => {
    const { result, lookups } = await ready(
      'gh pr ready 160',
      facts([summary(c3.sha)], [c1, c2, c3]),
    );
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(lookups, [['/work/tree', { pr: '160' }]]);
  });

  it('allows a pull request whose summary is for an older head followed only by merges', async () => {
    const { result, lookups } = await ready(
      'gh pr ready 160',
      facts([summary(c2.sha)], [c1, c2, m3, m4]),
    );
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.equal(lookups.length, 1);
  });

  it('allows a pull request when a later summary covers the head, though an earlier one does not', async () => {
    const { result, lookups } = await ready(
      'gh pr ready 160',
      facts([summary(c1.sha), summary(c3.sha)], [c1, c2, c3]),
    );
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.equal(lookups.length, 1);
  });

  // Marking ready needs the summary, not the check: a passing check must not be what lets it by.
  for (const [name, pullRequest] of [
    ['for the head', facts([summary(c3.sha)], [c1, c2, c3])],
    ['followed only by merges', facts([summary(c2.sha)], [c1, c2, m3, m4])],
  ] as const) {
    it(`allows a pull request whose summary is ${name} without running the check`, async () => {
      const { result, checks } = await ready('gh pr ready 160', pullRequest);
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.deepEqual(checks, []);
    });
  }

  it('allows a summary whose heading starts a later line of its comment', async () => {
    const { result } = await ready(
      'gh pr ready 160',
      facts([`Replaces the summary above.\n\n${summary(c3.sha)}`], [c1, c2, c3]),
    );
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
  });

  it('does not count a heading quoted in the middle of a line', async () => {
    const { result } = await ready(
      'gh pr ready 160',
      facts([`The template starts with ${summary(c3.sha)}`], [c1, c2, c3]),
    );
    assert.match(result.stderr, /^gh pr ready is blocked: pull request #160 has no/);
  });

  it('allows a summary for the head when GitHub lists too few commits to include it', async () => {
    const { result } = await ready('gh pr ready 160', {
      ...facts([summary(c3.sha)], [c1, c2]),
      head: c3.sha,
    });
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
  });

  it('blocks when the summary names a commit that is not on the pull request', async () => {
    const { result } = await ready(
      'gh pr ready 160',
      facts([summary(sha('e9e9e9e9'))], [c1, c2, c3]),
    );
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /is for e9e9e9e, but the head is c3c3c3c/);
  });

  it('blocks with one line when the pull request cannot be read', async () => {
    const { runCheck } = fakeCheck({ ok: true, output: '' });
    const result = await precheck(
      hookInput('gh pr ready 160', '/work/tree'),
      runCheck,
      async () => undefined,
      async () => false,
      async () => {
        throw new Error('gh pr view exited 1: HTTP 401');
      },
    ).catch((error: unknown) => ({ rejected: String(error) }));
    assert.deepEqual(result, {
      exitCode: 2,
      stderr:
        'gh pr ready is blocked: could not read pull request 160 to find its review summary (gh pr view exited 1: HTTP 401).\n',
    });
  });

  // Plain documentation needs no review summary (#183): *.md in a subfolder of docs/ other than adr/ and design/.
  for (const files of [
    ['docs/milestones/README.md'],
    ['docs/milestones/m0.md'],
    ['Docs/Milestones/M0.MD'],
    ['docs/adr-notes/plan.md'],
    ['docs/milestones/README.md', 'docs/milestones/m0.md'],
    ['docs/milestones/2026/plan.md'],
  ]) {
    it(`allows a pull request of only plain docs without a summary: ${files.join(', ')}`, async () => {
      const { result, lookups, checks } = await ready('gh pr ready 160', {
        ...facts(['Looks good to me.'], [c1, c2, c3]),
        files,
      });
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.deepEqual(lookups, [['/work/tree', { pr: '160' }]]);
      assert.deepEqual(checks, []);
    });
  }

  // ADRs, the top-level docs and docs/design/ (the design and the review's criteria), CLAUDE.md, prompts, root files
  // and anything that is not Markdown in a subfolder of docs/ are reviewed.
  for (const files of [
    ['docs/glossary.md'],
    ['docs/architecture.md'],
    ['docs/brewers-and-recipes.md'],
    ['docs/design/engine/events.md'],
    ['Docs/Design/security.md'],
    ['docs/milestones/README.md', 'docs/design/testing/README.md'],
    ['docs/architecture.md', 'docs/milestones/README.md'],
    ['Docs/Guide.MD'],
    ['docs/adr-overview.md'],
    ['docs/milestones/README.md', 'docs/adr/0001-record-architecture-decisions.md'],
    ['Docs/ADR/0001-record-architecture-decisions.md'],
    ['docs/milestones/README.md', 'CLAUDE.md'],
    ['docs/milestones/README.md', '.claude/skills/brew-review/SKILL.md'],
    ['README.md'],
    ['docs/milestones/notes.txt'],
    ['docs/notes.md.txt'],
    ['docs/milestones/notes.md.txt'],
    ['src/docs/readme.md'],
    ['src/docs/milestones/m0.md'],
    ['docs/adr/sub/notes.md'],
    [],
  ]) {
    it(`blocks a pull request without a summary that changes: ${files.join(', ') || 'nothing'}`, async () => {
      const { result } = await ready('gh pr ready 160', {
        ...facts(['Looks good to me.'], [c1, c2, c3]),
        files,
      });
      assert.match(
        result.stderr,
        /^gh pr ready is blocked: pull request #160 has no \/brew-review summary/,
      );
    });
  }

  it('blocks a pull request without a summary whose file list could not be read', async () => {
    const { result } = await ready('gh pr ready 160', facts(['Looks good to me.'], [c1, c2, c3]));
    assert.match(
      result.stderr,
      /^gh pr ready is blocked: pull request #160 has no \/brew-review summary/,
    );
  });

  it('asks for the current branch’s pull request, and the repository given, as gh would', async () => {
    const pullRequest = facts([summary(c3.sha)], [c1, c2, c3]);
    assert.deepEqual((await ready('gh pr ready', pullRequest)).lookups, [['/work/tree', {}]]);
    assert.deepEqual((await ready('gh -R owner/repo pr ready 160', pullRequest)).lookups, [
      ['/work/tree', { pr: '160', repo: 'owner/repo' }],
    ]);
    assert.deepEqual(
      (await ready('gh pr ready https://github.com/o/r/pull/160 --repo o/r', pullRequest)).lookups,
      [['/work/tree', { pr: 'https://github.com/o/r/pull/160', repo: 'o/r' }]],
    );
  });

  const hidden: [tool: string, command: string][] = [
    ['Bash', 'bash -c "gh pr ready 160"'],
    ['Bash', 'g=gh; $g pr ready 160'],
    ['Bash', 'env GH_PROMPT_DISABLED=1 gh pr ready 160'],
    ['Bash', '$(printf g)h pr ready 160'],
    ['PowerShell', "pwsh -Command 'gh pr ready 160'"],
    ['PowerShell', '& gh.exe pr ready 160'],
    ['PowerShell', "$g = 'gh'; & $g pr ready 160"],
  ];
  for (const [tool, command] of hidden) {
    it(`checks the summary for: ${command} (${tool})`, async () => {
      const { result, lookups } = await ready(command, facts([], [c1, c2, c3]), tool);
      assert.match(result.stderr, /^gh pr ready is blocked: pull request #160 has no/);
      assert.deepEqual(lookups, [['/work/tree', { pr: '160' }]]);
    });
  }

  it('lets gh pr ready --undo through without looking the pull request up', async () => {
    const { result, lookups } = await ready('gh pr ready 160 --undo', facts([], [c1, c2, c3]));
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(lookups, []);
  });

  it('blocks a pull request given by a value computed at run time, without looking it up', async () => {
    const { result, lookups } = await ready(
      'gh pr ready $n',
      facts([summary(c3.sha)], [c1, c2, c3]),
    );
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /gh pr ready .*computed at run time/);
    assert.deepEqual(lookups, []);
  });

  // The lookup runs before the command does, so it would see the head from before the push.
  for (const command of [
    'git push && gh pr ready 160',
    'bash -c "git push origin 154-x; gh pr ready 160"',
  ]) {
    it(`blocks gh pr ready in the same command as a push: ${command}`, async () => {
      const { result, lookups, checks } = await ready(
        command,
        facts([summary(c3.sha)], [c1, c2, c3]),
      );
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /^gh pr ready is blocked .*: run it as a command of its own/);
      assert.deepEqual(lookups, []);
      assert.deepEqual(checks, []);
    });
  }

  // Opening a pull request pushes nothing, so the lookup sees the head it marks ready (ADR 0135).
  it('looks the pull request up when gh pr create is in the same command', async () => {
    const { result, lookups, checks } = await ready(
      'gh pr create --draft && gh pr ready 160',
      facts([summary(c3.sha)], [c1, c2, c3]),
    );
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(lookups, [['/work/tree', { pr: '160' }]]);
    assert.deepEqual(checks, []);
  });

  it('looks up the repository of the last -R, as gh does', async () => {
    const { lookups } = await ready(
      'gh pr ready 160 -R owner/first --repo=owner/last',
      facts([summary(c3.sha)], [c1, c2, c3]),
    );
    assert.deepEqual(lookups, [['/work/tree', { pr: '160', repo: 'owner/last' }]]);
  });

  const ghRepo: [tool: string, command: string][] = [
    ['Bash', 'GH_REPO=owner/other gh pr ready 160'],
    ['Bash', 'export GH_REPO=owner/other; gh pr ready 160'],
    ['Bash', 'env GH_HOST=example.com gh pr ready 160'],
    // A line continuation inside the name (#158).
    ['Bash', 'GH_RE\\\nPO=owner/other gh pr ready 160'],
    ['Bash', 'GH_RE\\\r\nPO=owner/other gh pr ready 160'],
    ['PowerShell', "$env:GH_REPO = 'owner/other'; gh pr ready 160"],
  ];
  for (const [tool, command] of ghRepo) {
    it(`blocks gh pr ready in a command that sets the repository gh uses: ${command}`, async () => {
      const { result, lookups } = await ready(
        command,
        facts([summary(c3.sha)], [c1, c2, c3]),
        tool,
      );
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /GH_REPO or GH_HOST/);
      assert.deepEqual(lookups, []);
    });
  }

  for (const command of [
    "gh api graphql -f query='query { viewer { login } }'",
    "gh api graphql -F owner=o -f query='query($owner: String!) { repositoryOwner(login: $owner) { id } }'",
    'gh api repos/o/r/pulls/160/commits',
  ]) {
    it(`lets a gh api read through without a lookup: ${command}`, async () => {
      const { result, lookups } = await ready(command, facts([], [c1, c2, c3]));
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.deepEqual(lookups, []);
    });
  }

  it('runs the check, not the gh pr ready refusal, for a push in a command that sets GH_REPO', async () => {
    const { result, checks } = await ready('GH_REPO=owner/other git push', facts([], [c1, c2, c3]));
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(checks, ['/work/tree']);
  });

  it('names the current branch when its pull request cannot be read', async () => {
    const { runCheck } = fakeCheck({ ok: true, output: '' });
    const result = await precheck(
      hookInput('gh pr ready', '/work/tree'),
      runCheck,
      async () => undefined,
      async () => false,
      async () => {
        throw new Error('gh pr view exited 1: no pull requests found');
      },
    );
    assert.match(result.stderr, /could not read pull request of the current branch/);
  });

  it('names the newest of several summaries for older heads', async () => {
    const { result } = await ready(
      'gh pr ready 160',
      facts([summary(c1.sha), summary(c2.sha)], [c1, c2, c3]),
    );
    assert.match(result.stderr, /newest \/brew-review summary on pull request #160 is for c2c2c2c/);
  });

  it('blocks an older summary when GitHub lists too few commits to include the head', async () => {
    const { result } = await ready('gh pr ready 160', {
      ...facts([summary(c2.sha)], [c1, c2]),
      head: c3.sha,
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /is for c2c2c2c, but the head is c3c3c3c/);
  });

  it('looks up the repository of -R joined to its value, as gh reads it', async () => {
    const { lookups } = await ready(
      'gh pr ready 160 -Rowner/other',
      facts([summary(c3.sha)], [c1, c2, c3]),
    );
    assert.deepEqual(lookups, [['/work/tree', { pr: '160', repo: 'owner/other' }]]);
  });

  const computedArgs: [tool: string, command: string][] = [
    ['Bash', "opts='-R owner/other'; gh pr ready 160 $opts"],
    ['PowerShell', "$a = @('-R', 'owner/other'); gh pr ready 160 @a"],
  ];
  for (const [tool, command] of computedArgs) {
    it(`blocks gh pr ready with any argument computed at run time: ${command}`, async () => {
      const { result, lookups } = await ready(
        command,
        facts([summary(c3.sha)], [c1, c2, c3]),
        tool,
      );
      assert.match(result.stderr, /gh pr ready .*computed at run time/);
      assert.deepEqual(lookups, []);
    });
  }

  it('blocks gh pr ready when a command it decodes sets GH_REPO', async () => {
    const encoded = Buffer.from("$env:GH_REPO='owner/other'; gh pr ready 160", 'utf16le').toString(
      'base64',
    );
    const { result, lookups } = await ready(
      `pwsh -EncodedCommand ${encoded}`,
      facts([summary(c3.sha)], [c1, c2, c3]),
      'PowerShell',
    );
    assert.match(result.stderr, /GH_REPO or GH_HOST/);
    assert.deepEqual(lookups, []);
  });

  it('names gh pr ready among the plain commands when a command nests too deeply', () => {
    assert.match(forbiddenReason(`${'eval '.repeat(40)}gh pr ready 160`) ?? '', /gh pr ready/);
  });
});

describe('ghPullRequest', () => {
  // A gh that answers each call with the next outcome and records what it was asked.
  const fakeGh = (outcomes: ProcessOutcome[]) => {
    const calls: [file: string, args: string[], cwd: string][] = [];
    const runProcess: RunProcess = async (file, args, cwd) => {
      calls.push([file, args, cwd]);
      return outcomes.shift() ?? { exitCode: null, output: 'no more outcomes' };
    };
    return { calls, runProcess };
  };
  const view = JSON.stringify({
    number: 160,
    url: 'https://github.com/owner/repo/pull/160',
    headRefOid: 'c3',
    comments: [{ body: 'first' }, { body: '## Review: `x` @ `c3`' }],
    files: [
      { path: 'docs/milestones/README.md', changeType: 'MODIFIED' },
      { path: 'CLAUDE.md', changeType: 'MODIFIED' },
    ],
    changedFiles: 2,
  });

  it('reads the pull request with gh pr view and its commits with their parents with gh api', async () => {
    const { calls, runProcess } = fakeGh([
      { exitCode: 0, output: `${view}\n` },
      { exitCode: 0, output: 'c1 b0\nc2 c1\nc3 c2 b1\n' },
    ]);
    const pullRequest = await ghPullRequest(runProcess)('/work/tree', {
      pr: '160',
      repo: 'owner/repo',
    });
    assert.deepEqual(pullRequest, {
      number: 160,
      head: 'c3',
      comments: ['first', '## Review: `x` @ `c3`'],
      files: ['docs/milestones/README.md', 'CLAUDE.md'],
      commits: [
        { sha: 'c1', parents: ['b0'] },
        { sha: 'c2', parents: ['c1'] },
        { sha: 'c3', parents: ['c2', 'b1'] },
      ],
    });
    assert.deepEqual(calls, [
      [
        'gh',
        [
          'pr',
          'view',
          '160',
          '--repo',
          'owner/repo',
          '--json',
          'number,url,headRefOid,comments,files,changedFiles',
        ],
        '/work/tree',
      ],
      [
        'gh',
        [
          'api',
          '--hostname',
          'github.com',
          '--paginate',
          'repos/owner/repo/pulls/160/commits?per_page=100',
          '--jq',
          '.[] | [.sha, .parents[].sha] | join(" ")',
        ],
        '/work/tree',
      ],
    ]);
  });

  it('asks for the current branch’s pull request when none is given', async () => {
    const { calls, runProcess } = fakeGh([
      { exitCode: 0, output: view },
      { exitCode: 0, output: 'c3 c2\n' },
    ]);
    await ghPullRequest(runProcess)('/work/tree', {});
    assert.deepEqual(calls[0]?.[1], [
      'pr',
      'view',
      '--json',
      'number,url,headRefOid,comments,files,changedFiles',
    ]);
  });

  // A list it cannot read, or one cut off, leaves the files out, so the pull request is not exempt.
  for (const [name, fields] of [
    [
      'lists fewer files than it changes',
      { files: [{ path: 'docs/a.md', changeType: 'ADDED' }], changedFiles: 101 },
    ],
    ['has no file list', { files: undefined, changedFiles: 1 }],
    ['has no file count', { changedFiles: undefined }],
    [
      'lists a file without a path among ones with a path',
      {
        files: [{ path: 'docs/a.md', changeType: 'ADDED' }, { name: 'CLAUDE.md' }],
        changedFiles: 1,
      },
    ],
    ['lists a file without a path', { files: [{ name: 'docs/a.md' }], changedFiles: 1 }],
    // GitHub lists a moved file by its new path only, so a reviewed file moved into docs/ would look
    // like plain docs (#187 review).
    [
      'lists a renamed file',
      { files: [{ path: 'docs/claude.md', changeType: 'RENAMED' }], changedFiles: 1 },
    ],
    [
      'lists a copied file',
      { files: [{ path: 'docs/claude.md', changeType: 'COPIED' }], changedFiles: 1 },
    ],
    ['lists a file without a change type', { files: [{ path: 'docs/a.md' }], changedFiles: 1 }],
  ] as const) {
    it(`leaves the files out when gh pr view's answer ${name}`, async () => {
      const { runProcess } = fakeGh([
        { exitCode: 0, output: JSON.stringify({ ...JSON.parse(view), ...fields }) },
        { exitCode: 0, output: 'c3 c2\n' },
      ]);
      const pullRequest = await ghPullRequest(runProcess)('/work/tree', { pr: '160' });
      assert.equal(pullRequest.files, undefined);
      assert.equal(pullRequest.head, 'c3');
    });
  }

  it('reads the paths of added, modified and deleted files', async () => {
    const files = ['ADDED', 'MODIFIED', 'DELETED'].map((changeType, i) => ({
      path: `docs/${i}.md`,
      changeType,
    }));
    const { runProcess } = fakeGh([
      { exitCode: 0, output: JSON.stringify({ ...JSON.parse(view), files, changedFiles: 3 }) },
      { exitCode: 0, output: 'c3 c2\n' },
    ]);
    const pullRequest = await ghPullRequest(runProcess)('/work/tree', { pr: '160' });
    assert.deepEqual(pullRequest.files, ['docs/0.md', 'docs/1.md', 'docs/2.md']);
  });

  it('rejects with what gh said when gh fails', async () => {
    const { runProcess } = fakeGh([{ exitCode: 1, output: 'HTTP 401: Bad credentials' }]);
    await assert.rejects(
      ghPullRequest(runProcess)('/work/tree', { pr: '160' }),
      /gh pr view exited 1: HTTP 401: Bad credentials/,
    );
  });

  it("cuts gh's output to one short line in the rejection", async () => {
    const { runProcess } = fakeGh([
      { exitCode: 1, output: `HTTP 502\n${'<html>'.repeat(2000)}\n` },
    ]);
    const error = await ghPullRequest(runProcess)('/work/tree', { pr: '160' }).catch(
      (rejected: unknown) => rejected,
    );
    const message = error instanceof Error ? error.message : '';
    assert.match(message, /^gh pr view exited 1: HTTP 502 /);
    assert.ok(message.length <= 300 && !message.includes('\n'), message.slice(0, 400));
  });

  it('gives each gh call a deadline of at most 30 s', async () => {
    const options: (RunOptions | undefined)[] = [];
    const outcomes = [
      { exitCode: 0, output: view },
      { exitCode: 0, output: 'c3 c2\n' },
    ];
    const runProcess: RunProcess = async (_file, _args, _cwd, given) => {
      options.push(given);
      return outcomes.shift() ?? { exitCode: null, output: '' };
    };
    await ghPullRequest(runProcess)('/work/tree', { pr: '160' });
    assert.equal(options.length, 2);
    for (const given of options) {
      const timeoutMs = given?.timeoutMs ?? Number.POSITIVE_INFINITY;
      assert.ok(timeoutMs > 0 && timeoutMs <= 30_000, String(timeoutMs));
    }
  });

  it('reads the commits from the host and repository of the pull request URL', async () => {
    const { calls, runProcess } = fakeGh([
      {
        exitCode: 0,
        output: JSON.stringify({
          number: 7,
          url: 'https://ghe.example.com/acme/tool/pull/7',
          headRefOid: 'c3',
          comments: [],
        }),
      },
      { exitCode: 0, output: 'c3 c2\n' },
    ]);
    await ghPullRequest(runProcess)('/work/tree', {
      pr: 'https://ghe.example.com/acme/tool/pull/7',
    });
    assert.deepEqual(calls[1]?.[1].slice(0, 5), [
      'api',
      '--hostname',
      'ghe.example.com',
      '--paginate',
      'repos/acme/tool/pulls/7/commits?per_page=100',
    ]);
  });

  for (const [name, output, reason] of [
    ['is not JSON', 'Welcome to GitHub', /gh pr view did not answer with JSON: Welcome to GitHub/],
    [
      'lacks the head',
      JSON.stringify({ number: 160, url: 'https://github.com/o/r/pull/160', comments: [] }),
      /gh pr view answered without number, url, headRefOid and comments/,
    ],
  ] as const) {
    it(`rejects, saying so, when gh pr view's answer ${name}`, async () => {
      const { runProcess } = fakeGh([{ exitCode: 0, output }]);
      await assert.rejects(ghPullRequest(runProcess)('/work/tree', { pr: '160' }), reason);
    });
  }

  it('rejects with what gh said when the commits cannot be read', async () => {
    const { runProcess } = fakeGh([
      { exitCode: 0, output: view },
      { exitCode: 1, output: 'HTTP 502: Bad Gateway' },
    ]);
    await assert.rejects(
      ghPullRequest(runProcess)('/work/tree', { pr: '160' }),
      /gh api exited 1: HTTP 502: Bad Gateway/,
    );
  });

  it('rejects, saying why, when gh was killed', async () => {
    const { runProcess } = fakeGh([{ exitCode: null, output: '', killed: 'timed-out' }]);
    await assert.rejects(
      ghPullRequest(runProcess)('/work/tree', { pr: '160' }),
      /gh pr view timed out/,
    );
  });
});

describe('precheck on forbidden commands', () => {
  for (const command of [
    'git push --force-with-lease',
    'gh pr merge 30',
    'git push origin --delete old-branch',
    'gh api -X PUT repos/o/r/pulls/30/merge',
  ]) {
    it(`blocks without running the check: ${command}`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
      const result = await precheck(hookInput(command), runCheck);
      assert.equal(result.exitCode, 2);
      assert.equal(result.stderr, `${forbiddenReason(command)}\n`);
      assert.match(result.stderr, /blocked/);
      assert.deepEqual(calls, []);
    });
  }
});

// gh api can merge a pull request as gh pr merge does: a PUT to its merge endpoint (#297).
// GraphQL is not read: the ruleset on main owns merging (ADR 0135).
describe('forbiddenReason on a merge through gh api', () => {
  const blocked = [
    'gh api -X PUT repos/o/r/pulls/30/merge',
    'gh api -XPUT repos/o/r/pulls/30/merge',
    'gh api --method PUT repos/o/r/pulls/30/merge',
    'gh api --method=put repos/o/r/pulls/30/merge',
    'gh api -X put /repos/o/r/pulls/30/merge',
    'gh api -X Put pulls/30/merge',
    'gh api -X PUT /pulls/30/merge',
    'gh api -X PUT repos/{owner}/{repo}/pulls/30/merge',
    'gh api repos/o/r/pulls/30/merge -X PUT -f merge_method=squash',
    'gh api -H "Accept: application/vnd.github+json" --method PUT repos/o/r/pulls/30/merge',
    'gh api -X GET -X PUT repos/o/r/pulls/30/merge',
    'gh api -X $method repos/o/r/pulls/30/merge',
    'gh api -X PUT https://api.github.com/repos/o/r/pulls/30/merge',
    'gh api -X PUT https://ghe.example.com/api/v3/repos/o/r/pulls/30/merge',
    "gh api -X PUT 'repos/o/r/pulls/30/merge?merge_method=squash'",
    'gh api -X PUT "$base/pulls/30/merge"',
    'gh api -iX PUT repos/o/r/pulls/30/merge',
    'gh api -iXPUT repos/o/r/pulls/30/merge',
    'gh api -X=PUT repos/o/r/pulls/30/merge',
    // gh's command group computed at run time may be api.
    'gh $g -X PUT repos/o/r/pulls/30/merge',
    `bash -c "gh api -X PUT repos/o/r/pulls/30/merge"`,
    `pwsh -Command "gh api --method PUT repos/o/r/pulls/30/merge"`,
  ];
  for (const command of blocked) {
    it(`forbids: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /^`gh pr merge` is blocked/);
    });
  }

  const allowed = [
    // A GET only asks whether the pull request is merged.
    'gh api repos/o/r/pulls/30/merge',
    'gh api -X GET repos/o/r/pulls/30/merge',
    'gh api --method=get /repos/o/r/pulls/30/merge',
    'gh api -X PUT -X GET repos/o/r/pulls/30/merge',
    'gh api -X PUT repos/o/r/pulls/30/requested_reviewers',
    'gh api -X PUT repos/o/r/pulls/30/merge/extra',
    'gh api -X PUT repos/o/r/xpulls/30/merge',
    'gh api -X PUT repos/o/r/issues/30/labels -f labels[]=bug',
    'gh api -X $method repos/o/r/pulls/30',
    'gh api -i repos/o/r/pulls/30/merge',
    'gh api https://api.github.com/repos/o/r/pulls/30/merge',
    'gh api repos/o/r/pulls/30',
    'gh api graphql -f query=\'query { repository(owner: "o", name: "r") { pullRequest(number: 30) { merged } } }\'',
    'gh api graphql -f query=\'mutation { disablePullRequestAutoMerge(input: {pullRequestId: "PR_kw1"}) { clientMutationId } }\'',
    "git commit -m 'block gh api -X PUT repos/o/r/pulls/30/merge'",
  ];
  for (const command of allowed) {
    it(`allows: ${command}`, () => {
      assert.equal(forbiddenReason(command), undefined);
    });
  }
});

// An empty or wrong variable makes a recursive delete remove the wrong tree, so its path must be
// written as it is (#281).
describe('forbiddenReason on a recursive delete of a path built from a variable', () => {
  const blocked = [
    // rm with -r, -R or --recursive, alone, in a group or as a prefix GNU rm accepts.
    'rm -rf "$dir"',
    'rm -fr $dir',
    'rm -Rf ${dir}',
    'rm -r -f "$dir/run"',
    'rm --recursive --force "$dir"',
    'rm --rec "$dir"',
    'rm -rfv -- "$dir"',
    'rm -rf "$(pwd)/run"',
    'rm -rf `pwd`/run',
    'rm -rf "$HOME/.cache"',
    // PowerShell's Remove-Item and its aliases, with -Recurse or a prefix of it.
    'Remove-Item -Recurse -Force $p',
    'Remove-Item -Recurse -Force -LiteralPath $p',
    'Remove-Item -Path:$p -Recurse',
    'Remove-Item -Recurse "$env:TEMP\\run"',
    'remove-item -rec $(Get-Location)',
    'rm -Recurse $p',
    'del -Recurse $p',
    'ri -r $p',
    'erase -Recurse $p',
    'rmdir -Recurse $p',
    'rd -Recurse $p',
    // cmd's rd and del with /s and a %variable%.
    'rd /s /q %TEMP%\\run',
    'cmd /c "rmdir /S /Q %X%"',
    'del /s %X%',
    'erase /s %X%',
    // Found in the review of #293: cmd's switches written together, a quoted option in bash, BSD
    // rm's own flags, PowerShell's typographic dashes and a ( ) or @( ) argument.
    'rd /s/q %X%',
    'del /f/s/q %X%',
    'rmdir /Q/S %X%',
    `rm '-rf' "$dir"`,
    'rm "-r" $dir',
    'rm -rfx "$dir"',
    'rm -Prf "$dir"',
    'rm -rW "$dir"',
    // A redirection written apart from its target fails closed: its target reads as a path.
    'rm -rf .foedrum/tmp/281/run 2> "$log"',
    'Remove-Item -Recurse .foedrum/tmp/281/run > $null',
    `Remove-Item ${String.fromCodePoint(0x2013)}Recurse ${String.fromCodePoint(0x2013)}Force $p`,
    `ri ${String.fromCodePoint(0x2014)}r $p`,
    "Remove-Item -Recurse -Force (Join-Path $root 'run')",
    'Remove-Item -Recurse -Path ($dir)',
    'Remove-Item -Recurse -Force (Get-Location)',
    'Remove-Item -Recurse @($p)',
    'rm -Recurse (Resolve-Path ..)',
    // #296: cmd's switches written onto the program's name, which cmd reads as rd /s/q.
    'rd/s/q %X%',
    'del/s %X%',
    'RD/S/Q %X%',
    'rmdir/s %X%',
    'erase/f/s %X%',
    'cmd /c "rd/s/q %X%"',
    // #296: a PowerShell splat, whose table the gate cannot read, may carry Recurse and the path;
    // bash's rm reads @o as a path, so `rm @o` fails closed.
    'Remove-Item @o',
    'Remove-Item -Force @params',
    'ri @o',
    'rm @o',
    // #296: a ( ) argument after an assignment.
    '$null = Remove-Item -Recurse (Join-Path $root run)',
    '$r = rm -Recurse -Force (Get-Location)',
    '. Remove-Item -Recurse (Get-Location)',
    // #296: a pipeline whose earlier stage is computed, into a recursive delete.
    '$p | Remove-Item -Recurse',
    'Get-ChildItem $d | Remove-Item -Recurse',
    '$d | Get-ChildItem | Remove-Item -Recurse -Force',
    '(Get-ChildItem $d) | ri -r',
    // Review of #372: a pipeline goes on after a line that ends in a pipe or before one that starts
    // with it, and through a script block or the call operator in a stage.
    '$p |\nRemove-Item -Recurse',
    '$p |\r\nRemove-Item -Recurse',
    'Get-ChildItem $d\n| Remove-Item -Recurse',
    'Get-ChildItem $d | Where-Object { $_.PSIsContainer } | Remove-Item -Recurse',
    '$p | & Remove-Item -Recurse',
    // Round 2 of that review: a variable that only starts like $_, and a literal delete inside a
    // stage of a pipeline from a computed source, which fails closed.
    '$_d | Remove-Item -Recurse',
    'Get-ChildItem $PSItems | Remove-Item -Recurse',
    '$d | ForEach-Object { Remove-Item -Recurse .foedrum/tmp/x }',
    // A script block in the first stage, and $_ at the head of a pipeline, where it is a source
    // like any variable.
    'Invoke-Command { Get-ChildItem $d } | Remove-Item -Recurse',
    '& { Get-ChildItem $d } | Remove-Item -Recurse',
    '[pscustomobject]@{Path=$d} | Remove-Item -Recurse',
    '$dirs | ForEach-Object {\n  $_ | Remove-Item -Recurse\n}',
    '$dirs | % { Write-Host $_; $_ | Remove-Item -Recurse }',
    '$_ = $root; $_ | Remove-Item -Recurse',
    // Through wrappers, compound commands and other shells.
    'sudo rm -rf "$dir"',
    'cd x && rm -rf "$dir"',
    'for d in a b; do rm -rf "$d"; done',
    'bash -c "rm -rf $dir"',
    'bash -c \'rm -rf "$dir"\'',
    'pwsh -Command "Remove-Item -Recurse $p"',
    "pwsh -c 'Remove-Item -Recurse -Force $p'",
  ];
  for (const command of blocked) {
    it(`blocks: ${command}`, () => {
      assert.equal(
        forbiddenReason(command),
        'A recursive delete of a path built from a variable or a substitution is blocked: an empty or wrong value removes the wrong tree; write the literal path, such as `rm -rf .foedrum/tmp/218/run` (CLAUDE.md).',
      );
    });
  }

  const allowed = [
    'rm -rf .foedrum/tmp/218/run',
    "rm -rf '.foedrum/tmp/my run'",
    'rm -rf .foedrum/tmp/218/*',
    'rm -rf .foedrum/tmp/*/scratch',
    // rm without recursion, whatever the path.
    'rm -f "$file"',
    'rm -f -- "$file"',
    'rm "$file"',
    'rm -fv $(ls *.log)',
    // A single-quoted $ is literal in both shells.
    "rm -rf '$dir'",
    'Remove-Item -Recurse -Force .foedrum/tmp/218/run',
    'Remove-Item -Recurse:$true -Force .foedrum/tmp/218/run',
    'Remove-Item -Force $p',
    'Remove-Item $p',
    // A redirection is no path, and -Recurse:$false does not recurse.
    'Remove-Item -Recurse -Force .foedrum/tmp/281/run 2>$null',
    'rm -rf .foedrum/tmp/281/run 2>"$log"',
    'Remove-Item -Recurse:$false $p',
    // A ( ) that starts a command is a group, not an argument.
    'if (Test-Path .foedrum/tmp/281) { Remove-Item -Recurse .foedrum/tmp/281 }',
    'Get-ChildItem .foedrum/tmp/218 | Remove-Item -Recurse',
    // #296: the same forms with a literal path, without recursion, or after the pipeline ended.
    'rd/s/q .foedrum\\tmp\\218',
    'del/q %X%',
    'Copy-Item @o',
    '$null = Remove-Item -Recurse .foedrum/tmp/218',
    '$null = Remove-Item (Get-Location)',
    '$p | Remove-Item',
    '$p | Write-Output; Get-ChildItem .foedrum/tmp/218 | Remove-Item -Recurse',
    'Test-Path $d || Remove-Item -Recurse .foedrum/tmp/218',
    'Get-ChildItem $d | Write-Output && Remove-Item -Recurse .foedrum/tmp/218',
    'Get-ChildItem $d | Write-Output\nRemove-Item -Recurse .foedrum/tmp/218',
    'if (Test-Path $d) { Get-ChildItem .foedrum/tmp/218 | Remove-Item -Recurse }',
    "Remove-Item -Force '@o'",
    // $_ and $PSItem are the pipeline's own object, which came from a literal path here.
    'Get-ChildItem .foedrum/tmp/218 | Where-Object { $_.PSIsContainer } | Remove-Item -Recurse',
    'Get-ChildItem .foedrum/tmp/218 | Where-Object { $PSItem.Name -ne "keep" } | ri -r',
    // An @ inside a path is no splat.
    'rm -rf .foedrum/tmp/a@b',
    'Remove-Item -Recurse .foedrum/tmp/a@b',
    'rd /s /q .foedrum\\tmp\\218',
    'del %X%',
    // A switch that is not the recursive one, and a quoted word, which PowerShell reads as a value.
    'del /q %X%',
    'rd /q %X%',
    'del /f/q %X%',
    'rm --force "$f"',
    "Remove-Item '-Recurse' $p",
    'echo "rm -rf $dir"',
    'grep -n "rm -rf \\"$dir\\"" CLAUDE.md',
  ];
  for (const command of allowed) {
    it(`allows: ${command}`, () => {
      assert.equal(forbiddenReason(command), undefined);
    });
  }
});

describe('precheck on a recursive delete of a path built from a variable', () => {
  // None of these mention git, gh or the other words of the pre-filter, so it must let them reach
  // the reader (#281).
  const blocked: [command: string, tool: string][] = [
    ['rm -rf "$dir"', 'Bash'],
    ['rm -rf `pwd`/run', 'Bash'],
    ['Remove-Item -Recurse -Force $p', 'PowerShell'],
    ['ri -r $env:TEMP', 'PowerShell'],
    ['cmd /c rd /s /q %X%', 'PowerShell'],
    ['del -Recurse $p', 'PowerShell'],
    ['erase -Recurse $p', 'PowerShell'],
    // The shells drop the quotes that split the name.
    [`r''m -rf "$d"`, 'Bash'],
    // Computed without a $, % or backtick.
    ['Remove-Item -Recurse -Force (Get-Location)', 'PowerShell'],
    // #296's forms.
    ['rd/s/q %X%', 'PowerShell'],
    ['$p | Remove-Item -Recurse', 'PowerShell'],
    // A splat holds no $, %, backtick or ( (review of #372).
    ['Remove-Item @o', 'PowerShell'],
    ['Remove-Item -Force @params', 'PowerShell'],
    ['rm @o', 'Bash'],
  ];
  for (const [command, tool] of blocked) {
    it(`blocks without running the check (${tool}): ${command}`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
      const result = await precheck(hookInput(command, '/work/tree', tool), runCheck);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /write the literal path/);
      assert.deepEqual(calls, []);
    });
  }

  // Bash reads no pipeline into a delete: rm reads no paths from its input (ADR 0138).
  for (const command of [
    'rm -rf .foedrum/tmp/218/run',
    'rm -f "$file"',
    'ls "$d" | xargs rm -rf .foedrum/tmp/218',
    // The pre-filter passes a delete word with an @ to the reader, which lets a path through.
    'rm -rf .foedrum/tmp/a@b',
  ]) {
    it(`lets through: ${command}`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: false, output: '' });
      const result = await precheck(hookInput(command, '/work/tree'), runCheck);
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.deepEqual(calls, []);
    });
  }

  // Too wide to read, so the parser would block them: a pass shows the pre-filter let them through
  // unread, since each has a delete word or a $, but not both.
  for (const string of ['"$x%d"', '"rm%d"']) {
    it(`lets through a command of ${string} strings without reading it`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: false, output: '' });
      const strings = Array.from({ length: 3000 }, (_, i) => string.replace('%d', `${i}`));
      const command = `bash -c ${strings.join(' ')}`;
      assert.match(forbiddenReason(command) ?? '', /too deeply/);
      const result = await precheck(hookInput(command, '/work/tree'), runCheck);
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.deepEqual(calls, []);
    });
  }
});

// npx and its relatives download a package the lockfile did not install, past the dependency
// guard (#175).
describe('precheck on npx and the commands that run a package like it', () => {
  const refusal = (run: string): string =>
    `\`${run}\` would download a package that isn't in package-lock.json. Use the project's tools: \`npm run lint -- --write\` formats with Biome.\n`;
  // node_modules/.bin in the fake checkout holds biome only.
  const fakeBinaries = () => {
    const asked: string[][] = [];
    const binaryInstalled = async (cwd: string, name: string): Promise<boolean> => {
      asked.push([cwd, name]);
      return name === 'biome';
    };
    return { asked, binaryInstalled };
  };
  const gate = async (command: string, tool = 'Bash') => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
    const binaries = fakeBinaries();
    const result = await precheck(
      hookInput(command, '/work/tree', tool),
      runCheck,
      async () => undefined,
      async () => false,
      undefined,
      binaries.binaryInstalled,
    );
    return { result, checks: calls, asked: binaries.asked };
  };

  const refused: [command: string, run: string, tool?: string][] = [
    ['npx prettier --write x.ts', 'npx prettier'],
    ['npx prettier --write x.ts', 'npx prettier', 'PowerShell'],
    ['npx --yes some-pkg', 'npx some-pkg'],
    ['npx -y some-pkg --flag', 'npx some-pkg'],
    ['npm exec prettier -- --write x.ts', 'npm exec prettier'],
    ['npm exec -- prettier --write x.ts', 'npm exec prettier'],
    ['npm x prettier', 'npm x prettier'],
    ['pnpm dlx prettier --write x.ts', 'pnpm dlx prettier'],
    ['yarn dlx prettier --write x.ts', 'yarn dlx prettier'],
    ['bunx prettier --write x.ts', 'bunx prettier'],
    ['bun x prettier --write x.ts', 'bun x prettier'],
    // A package given as an option is downloaded too, whatever the program.
    ['npx -p prettier biome check', 'npx prettier'],
    ['npx --package=prettier biome check', 'npx prettier'],
    ['yarn dlx -p prettier biome', 'yarn dlx prettier'],
    // Through wrappers, other shells and compound commands.
    ['env CI=1 npx prettier --write x.ts', 'npx prettier'],
    ['bash -c "npx prettier --write x.ts"', 'npx prettier'],
    ['git status && npx prettier --write x.ts', 'npx prettier'],
    // pnpm's shorthand for pnpm dlx, and the PowerShell shims npm and pnpm install on Windows.
    ['pnpx prettier --write x.ts', 'pnpx prettier'],
    ['npx.ps1 prettier --write x.ts', 'npx prettier', 'PowerShell'],
    [
      '& "C:\\Users\\dev\\AppData\\Roaming\\npm\\pnpm.ps1" dlx prettier',
      'pnpm dlx prettier',
      'PowerShell',
    ],
  ];
  for (const [command, run, tool = 'Bash'] of refused) {
    it(`refuses in ${tool}: ${command}`, async () => {
      const { result, checks } = await gate(command, tool);
      assert.deepEqual(result, { exitCode: 2, stderr: refusal(run) });
      assert.deepEqual(checks, []);
    });
  }

  // A name that is not a plain binary name never reaches the file system: a version, a scope or a
  // path is not what node_modules/.bin holds, and a name computed at run time may be anything.
  const unnamed: [command: string, run: string][] = [
    ['npx prettier@3 --write x.ts', 'npx prettier@3'],
    ['npx @biomejs/biome check', 'npx @biomejs/biome'],
    ['npx ../../tools/biome check', 'npx ../../tools/biome'],
    ['npx $tool --write x.ts', 'npx $tool'],
    // pnpm dlx, pnpx and yarn dlx always download, whatever node_modules/.bin holds.
    ['pnpm dlx biome check', 'pnpm dlx biome'],
    ['pnpx biome check', 'pnpx biome'],
    ['yarn dlx biome', 'yarn dlx biome'],
    // A -p value is a package name, which node_modules/.bin cannot vouch for.
    ['npx -p biome biome check', 'npx biome'],
    ['npx --package=tsc tsc', 'npx tsc'],
    // Names Windows maps to a device or to another file.
    ['npx nul', 'npx nul'],
    ['npx CON check', 'npx CON'],
    ['npx lpt1.txt', 'npx lpt1.txt'],
    ['npx prn', 'npx prn'],
    ['npx Aux.js', 'npx Aux.js'],
    ['npx com9', 'npx com9'],
    ['npx biome. check', 'npx biome.'],
  ];
  for (const [command, run] of unnamed) {
    it(`refuses without looking: ${command}`, async () => {
      const { result, asked } = await gate(command);
      assert.deepEqual(result, { exitCode: 2, stderr: refusal(run) });
      assert.deepEqual(asked, []);
    });
  }

  for (const command of [
    'npx biome check',
    'npx --yes biome check src',
    'npm exec biome -- check',
    'bunx biome check',
  ]) {
    it(`lets through a binary the lockfile installed: ${command}`, async () => {
      const { result, checks, asked } = await gate(command);
      assert.deepEqual(result, { exitCode: 0, stderr: '' });
      assert.deepEqual(checks, []);
      assert.ok(asked.length > 0);
      assert.ok(asked.every(([cwd, name]) => cwd === '/work/tree' && name === 'biome'));
    });
  }

  // The gate looks in node_modules/.bin around the hook's working directory; after a change of
  // directory npx looks elsewhere and may download a package of the same name.
  const moved: [command: string, tool?: string][] = [
    ['cd ../other && npx biome check'],
    ['pushd ../other && npx biome check'],
    ['bash -c "cd ../other && npx biome check"'],
    ['Set-Location ..\\other; npx biome check', 'PowerShell'],
    ['sl ..\\other; npx biome check', 'PowerShell'],
    // PowerShell's drive and parent functions, and cmd's drive letter.
    ['D:; npx biome check', 'PowerShell'],
    ['cd..; npx biome check', 'PowerShell'],
    ['cd\\; npx biome check', 'PowerShell'],
    ['cmd /c "D: && npx biome check"'],
    // npx's own directory option.
    ['npx --prefix ../other biome check'],
    ['npx --prefix=../other biome check'],
  ];
  for (const [command, tool = 'Bash'] of moved) {
    it(`refuses a package runner after a change of directory in ${tool}: ${command}`, async () => {
      const { result, checks } = await gate(command, tool);
      assert.deepEqual(result, {
        exitCode: 2,
        stderr:
          '`npx biome` is blocked in a command that changes directory: the gate looks for it in node_modules/.bin where the command starts, and npx would look where it runs. Run it as a command of its own, from the folder whose node_modules it uses.\n',
      });
      assert.deepEqual(checks, []);
    });
  }

  // One- and two-character names are binary names too, such as nx.
  for (const name of ['x', 'nx']) {
    it(`looks up a short name: npx ${name}`, async () => {
      const { asked } = await gate(`npx ${name}`);
      assert.deepEqual(asked, [['/work/tree', name]]);
    });
  }

  it('lets through npx without a package', async () => {
    const { result, asked } = await gate('npx --version');
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(asked, []);
  });

  it('still runs the check for a push after an installed binary', async () => {
    const { result, checks } = await gate('npx biome check && git push');
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(checks, ['/work/tree']);
  });

  it('lets through a change of directory without a package runner', async () => {
    const { result } = await gate('cd src && git status');
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
  });

  // Every package counts, not only the first the gate finds.
  for (const command of ['npx biome check && npx prettier --write x.ts']) {
    it(`refuses a download after an installed binary: ${command}`, async () => {
      const { result } = await gate(command);
      assert.deepEqual(result, { exitCode: 2, stderr: refusal('npx prettier') });
    });
  }

  // The refusal comes before the check and the pull request lookup, which the fake would fail.
  for (const command of [
    'npx prettier --write x.ts && git push',
    'npx prettier && gh pr ready 1',
  ]) {
    it(`refuses a download before the check or the lookup: ${command}`, async () => {
      const { result, checks } = await gate(command);
      assert.deepEqual(result, { exitCode: 2, stderr: refusal('npx prettier') });
      assert.deepEqual(checks, []);
    });
  }

  const movedAgain: [command: string, tool: string][] = [
    ['chdir ../other && npx biome check', 'Bash'],
    ['Push-Location ..\\other; npx biome check', 'PowerShell'],
  ];
  for (const [command, tool] of movedAgain) {
    it(`refuses a package runner after ${command.split(' ')[0]}`, async () => {
      const { result } = await gate(command, tool);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /^`npx biome` is blocked in a command that changes directory/);
    });
  }

  it('blocks a force push through a package runner for its own reason', async () => {
    const { result, checks } = await gate('npm exec -- git push -f');
    assert.deepEqual(result, {
      exitCode: 2,
      stderr: `${forbiddenReason('git push -f')}\n`,
    });
    assert.match(result.stderr, /^Force push is blocked/);
    assert.deepEqual(checks, []);
  });

  // npx -c runs a command with the installed binaries on PATH; it downloads nothing itself.
  it('lets through npx -c with a command that runs no package', async () => {
    const { result, asked } = await gate('npx -c "npm run lint"');
    assert.deepEqual(result, { exitCode: 0, stderr: '' });
    assert.deepEqual(asked, []);
  });

  it('refuses npx by default, when no check for binaries is given', async () => {
    const { runCheck } = fakeCheck({ ok: true, output: '' });
    const result = await precheck(hookInput('npx biome check'), runCheck);
    assert.deepEqual(result, { exitCode: 2, stderr: refusal('npx biome') });
  });
});

describe('lockfileBinary', () => {
  const tree = join('/work', 'tree');
  const fakeFiles = (files: string[]) => {
    const asked: string[] = [];
    const read = async (path: string) => (files.includes(path) ? '{}' : undefined);
    const exists = async (path: string) => {
      asked.push(path);
      return files.includes(path);
    };
    return { asked, read, exists };
  };

  it('looks in node_modules/.bin of the nearest folder up with a package.json', async () => {
    const binary = join(tree, 'node_modules', '.bin', 'biome');
    const files = fakeFiles([join(tree, 'package.json'), binary]);
    const installed = lockfileBinary(files.read, files.exists);
    assert.equal(await installed(join(tree, 'src', 'cli'), 'biome'), true);
    assert.equal(await installed(join(tree, 'src', 'cli'), 'prettier'), false);
    assert.deepEqual(files.asked, [binary, join(tree, 'node_modules', '.bin', 'prettier')]);
  });

  it('stops at the nearest package.json, not the outermost', async () => {
    const files = fakeFiles([
      join(tree, 'package.json'),
      join(tree, 'node_modules', '.bin', 'biome'),
      join(tree, 'src', 'package.json'),
    ]);
    const installed = lockfileBinary(files.read, files.exists);
    assert.equal(await installed(join(tree, 'src', 'cli'), 'biome'), false);
    assert.deepEqual(files.asked, [join(tree, 'src', 'node_modules', '.bin', 'biome')]);
  });

  it('answers false outside a package, without looking for the binary', async () => {
    const files = fakeFiles([]);
    assert.equal(await lockfileBinary(files.read, files.exists)(tree, 'biome'), false);
    assert.deepEqual(files.asked, []);
  });
});

describe('npmCheck', () => {
  const execPath = '/usr/local/bin/node';
  const npmCli = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
  // A lookup that finds npm's CLI at npmCli, and one that finds nothing at the given paths.
  const found: FindNpmCli = async () => ({ path: npmCli, tried: [npmCli] });
  const notFound =
    (...tried: string[]): FindNpmCli =>
    async () => ({ path: undefined, tried });

  // A fake process runner that records each call and answers with the given outcome.
  const fakeProcess = (outcome: ProcessOutcome) => {
    const calls: [file: string, args: string[], cwd: string][] = [];
    const runProcess: RunProcess = async (file, args, cwd) => {
      calls.push([file, args, cwd]);
      return outcome;
    };
    return { calls, runProcess };
  };

  it('runs npm run check without tests with this node and the npm CLI found next to it, in the given directory', async () => {
    const { calls, runProcess } = fakeProcess({ exitCode: 0, output: '' });
    const looked: string[] = [];
    const findNpmCli: FindNpmCli = async (path) => {
      looked.push(path);
      return { path: npmCli, tried: [npmCli] };
    };
    await npmCheck(execPath, findNpmCli, runProcess)('/work/tree');
    assert.deepEqual(looked, [execPath]);
    assert.deepEqual(calls, [
      [execPath, [npmCli, 'run', 'check', '--', '--no-tests'], '/work/tree'],
    ]);
  });

  it('passes when npm exits 0, keeping its output', async () => {
    const { runProcess } = fakeProcess({ exitCode: 0, output: 'all green\n' });
    const result = await npmCheck(execPath, found, runProcess)('/work/tree');
    assert.deepEqual(result, { ok: true, output: 'all green\n' });
  });

  it('fails when npm exits non-zero, keeping its output', async () => {
    const { runProcess } = fakeProcess({ exitCode: 1, output: 'not ok 1 - café\n' });
    const result = await npmCheck(execPath, found, runProcess)('/work/tree');
    assert.deepEqual(result, { ok: false, output: 'not ok 1 - café\n' });
  });

  // A branch that has not merged main since ADR 0249 has a check that refuses the argument.
  it("fails with a line to merge origin/main when the tree's check does not know --no-tests", async () => {
    // The error an old check.ts throws: its strict parseArgs knows only --all.
    let refused = '';
    try {
      parseArgs({ args: ['--no-tests'], options: { all: { type: 'boolean' } } });
    } catch (error) {
      refused = String(error);
    }
    const { runProcess } = fakeProcess({ exitCode: 1, output: `${refused}\n` });
    const result = await npmCheck(execPath, found, runProcess)('/work/tree');
    assert.equal(result.ok, false);
    assert.ok(result.output.startsWith(refused), result.output);
    assert.match(
      result.output,
      /\nThis branch's scripts\/check\.ts does not know --no-tests \(ADR 0249\): merge origin\/main and push again\.$/,
    );
  });

  it('adds no merge line to a passing check whose output names the option', async () => {
    const output = "ok 1 - refuses Unknown option '--no-tests'\n";
    const { runProcess } = fakeProcess({ exitCode: 0, output });
    const result = await npmCheck(execPath, found, runProcess)('/work/tree');
    assert.deepEqual(result, { ok: true, output });
  });

  it('fails when npm could not start or was killed', async () => {
    const { runProcess } = fakeProcess({ exitCode: null, output: 'spawn ENOENT' });
    const result = await npmCheck(execPath, found, runProcess)('/work/tree');
    assert.deepEqual(result, { ok: false, output: 'spawn ENOENT' });
  });

  // The gate never lets a command through because it could not find npm (#41).
  it('fails without starting a process when npm CLI is not next to node, naming each path it tried', async () => {
    const { calls, runProcess } = fakeProcess({ exitCode: 0, output: '' });
    const tried = ['/opt/node/lib/node_modules/npm/bin/npm-cli.js', '/elsewhere/npm-cli.js'];
    const result = await npmCheck(execPath, notFound(...tried), runProcess)('/work/tree');
    assert.equal(result.ok, false);
    assert.match(result.output, /npm's CLI was not found next to node/);
    assert.ok(result.output.includes(execPath), result.output);
    for (const path of tried) assert.ok(result.output.includes(path), result.output);
    assert.deepEqual(calls, []);
  });

  // Outside Windows the check leads a process group of its own, which a Ctrl+C on the push or
  // the end of the hook does not reach: the gate passes its stop on and sets a deadline (#12).
  it("gives the check the gate's stop signal and a deadline between the steps' and the hook's", async () => {
    const options: (RunOptions | undefined)[] = [];
    const runProcess: RunProcess = async (_file, _args, _cwd, given) => {
      options.push(given);
      return { exitCode: 0, output: '' };
    };
    const stop = new AbortController();
    await npmCheck(execPath, found, runProcess, stop.signal)('/work/tree');
    assert.equal(options.length, 1);
    assert.equal(options[0]?.signal, stop.signal);
    const timeoutMs = options[0]?.timeoutMs ?? 0;
    // A step's own deadline is 300 s; the hook ends after 600 s.
    assert.ok(timeoutMs > 300_000 && timeoutMs < 600_000, String(timeoutMs));
  });

  for (const [killed, reason] of [
    ['timed-out', /npm run check timed out after \d+ s/],
    ['stopped', /npm run check was stopped/],
  ] as const) {
    it(`fails, saying why, when the check was killed (${killed})`, async () => {
      const { runProcess } = fakeProcess({ exitCode: null, output: '> npm test\n', killed });
      const result = await npmCheck(execPath, found, runProcess)('/work/tree');
      assert.equal(result.ok, false);
      assert.match(result.output, /^> npm test\n/);
      assert.match(result.output, reason);
    });
  }
});

interface HookHandler {
  type?: string;
  if?: string;
  command?: string;
  shell?: string;
  onFailure?: string;
}

interface Settings {
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
  hooks?: { PreToolUse?: { matcher?: string; hooks?: HookHandler[] }[] };
}

const readJson = <T>(path: string): T =>
  (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}) as T;

describe('local gate wiring', () => {
  // The hook runs node on precheck.ts itself, without npm (#41), so no npm script is its entry.
  it('package.json has a check script and no hook entry point', () => {
    const { scripts } = readJson<{ scripts?: Record<string, string> }>(join(root, 'package.json'));
    assert.equal(scripts?.check, 'node scripts/check.ts');
    assert.equal(scripts?.['hook:gate'], undefined);
  });

  // No `if` filter: it only sees the start of a compound command, so `mkdir x && git push`
  // slipped through. precheck.ts decides for every call and exits early for most of them.
  // node runs precheck.ts directly, without npm (#41): npm cost about 0.4 s per call. The
  // command is anchored to the project and fails closed: when node or precheck.ts cannot run, it
  // explains why on stderr and exits 2, even on Claude Code versions without onFailure; precheck's
  // own exit 2 passes through without that message. The shell is pinned to bash so PowerShell
  // never parses `||` or `{ …; }`.
  for (const tool of ['Bash', 'PowerShell']) {
    it(`.claude/settings.json runs the gate before every ${tool} call`, () => {
      const settings = readJson<Settings>(join(root, '.claude', 'settings.json'));
      const handlers = (settings.hooks?.PreToolUse ?? [])
        .filter((group) => group.matcher === tool)
        .flatMap((group) => group.hooks ?? []);
      assert.deepEqual(
        handlers.map((handler) => ({ ...handler, timeout: undefined })),
        [
          {
            type: 'command',
            command:
              // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder Claude Code expands
              'node "${CLAUDE_PROJECT_DIR}/scripts/precheck.ts" || { s=$?; [ "$s" = 2 ] || echo "Foedrum gate could not run (exit $s); command blocked." >&2; exit 2; }',
            shell: 'bash',
            onFailure: 'block',
            timeout: undefined,
          },
        ],
      );
    });
  }
});

describe('.claude/settings.json permissions', () => {
  const permissions = readJson<Settings>(join(root, '.claude', 'settings.json')).permissions;

  it('denies force pushes, merging pull requests and editing .npmrc', () => {
    const deny = permissions?.deny ?? [];
    const required = [
      'Bash(git push --force *)',
      'Bash(git push -f *)',
      'Bash(git push * --force*)',
      'PowerShell(git push --force *)',
      'PowerShell(git push -f *)',
      'PowerShell(git push * --force*)',
      'Bash(gh pr merge *)',
      'PowerShell(gh pr merge *)',
      'Edit(/.npmrc)',
    ];
    assert.deepEqual(
      required.filter((rule) => !deny.includes(rule)),
      [],
    );
  });

  it('has no Write(...) rules, because Edit(...) rules cover every file-editing tool', () => {
    const { allow = [], ask = [], deny = [] } = permissions ?? {};
    assert.deepEqual(
      [...allow, ...ask, ...deny].filter((rule) => rule.startsWith('Write(')),
      [],
    );
  });

  it('updates branches by merging origin/main, never by rebasing', () => {
    const allow = permissions?.allow ?? [];
    assert.ok(allow.includes('Bash(git merge origin/main)'));
    assert.deepEqual(
      allow.filter((rule) => rule.includes('git rebase')),
      [],
    );
  });

  it('denies destructive gh repo commands and allows gh repo view', () => {
    const deny = permissions?.deny ?? [];
    for (const action of ['delete', 'edit', 'rename', 'archive']) {
      assert.ok(deny.includes(`Bash(gh repo ${action} *)`), `deny is missing gh repo ${action}`);
    }
    assert.ok(!deny.includes('Bash(gh repo *)'), 'gh repo * would also deny gh repo view');
    assert.ok((permissions?.allow ?? []).includes('Bash(gh repo view *)'));
  });

  it('allows pushing, opening a pull request and commenting without asking', () => {
    const allow = permissions?.allow ?? [];
    const ask = permissions?.ask ?? [];
    for (const rule of ['git push *', 'gh pr create *', 'gh pr comment *', 'gh issue comment *']) {
      for (const tool of ['Bash', 'PowerShell']) {
        assert.ok(allow.includes(`${tool}(${rule})`), `allow is missing ${tool}(${rule})`);
        assert.ok(!ask.includes(`${tool}(${rule})`), `ask still has ${tool}(${rule})`);
      }
    }
  });

  it('asks before npm install and GitHub API writes, not before every GitHub API call', () => {
    const ask = permissions?.ask ?? [];
    const flags = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'];
    const rules = [
      'npm install *',
      ...flags.flatMap((flag) => [`gh api ${flag}*`, `gh api * ${flag}*`]),
    ];
    for (const rule of rules) {
      for (const tool of ['Bash', 'PowerShell']) {
        assert.ok(ask.includes(`${tool}(${rule})`), `ask is missing ${tool}(${rule})`);
      }
    }
    for (const tool of ['Bash', 'PowerShell']) {
      assert.ok(!ask.includes(`${tool}(gh api *)`), `ask still has ${tool}(gh api *)`);
    }
  });

  it('mirrors every Bash rule for the PowerShell tool', () => {
    for (const list of ['allow', 'ask', 'deny'] as const) {
      const rules = permissions?.[list] ?? [];
      const bash = rules.filter((rule) => rule.startsWith('Bash(')).map((rule) => rule.slice(4));
      const powershell = rules
        .filter((rule) => rule.startsWith('PowerShell('))
        .map((rule) => rule.slice(10));
      assert.ok(bash.length > 0, `${list} has no Bash rules`);
      assert.deepEqual(powershell, bash, `${list}: PowerShell rules do not mirror the Bash rules`);
    }
  });
});
