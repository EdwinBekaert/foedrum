// The gate's decisions on the hook input, with the check and the process runner injected. The
// hook command and the real npm run in test/integration/precheck.test.ts (ADR 0021).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  type CheckResult,
  type FindNpmCli,
  forbiddenReason,
  ghPullRequest,
  gitHeadIsDetached,
  isDetached,
  isGatedCommand,
  type LookupPullRequest,
  lockfileBinary,
  npmCheck,
  type ProcessOutcome,
  type PullRequestFacts,
  precheck,
  type ReadyTarget,
  type RunProcess,
} from '../../scripts/precheck.ts';
import type { RunOptions } from '../../scripts/process-runner.ts';

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
    'gh pr create --draft --title "Local gate"',
    'gh pr new',
    'git log --oneline -1 && gh pr create --body-file body.md',
    'gh -R owner/repo pr create --draft',
    'gh pr --repo owner/repo create',
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
    'npm run check',
    '',
  ];
  for (const command of ungated) {
    it(`lets through: ${command || '(empty)'}`, () => {
      assert.equal(isGatedCommand(command), false);
    });
  }
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
    const result = await precheck(hookInput('gh pr create --draft'), runCheck);
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
    const result = await precheck(
      hookInput('gh pr create', '/work/tree'),
      runCheck,
      stale.staleReason,
    );
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
    ['a push inside ( … )', 'Bash', '(cd ../foedrum && git push)'],
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

// The bypasses from the independent review of #30 (#42): wrappers, other shells, aliases,
// substitutions, variables and quoted paths. Each case is a force push or a merge in disguise.
describe('forbiddenReason through wrappers, other shells and aliases', () => {
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

  // A git or gh alias hides the push or merge behind another name, so defining one is blocked.
  const aliases = [
    'git config alias.p push && git p -f',
    'git config --global alias.p "push -f"',
    'git config alias.p push',
    "git config alias.p '!git push -f'",
    'git config set alias.p push',
    'git -c alias.p=push p -f',
    'git -c alias.p=push p',
    "gh alias set m 'pr merge'",
    "gh alias set c 'pr create --draft'",
    "gh alias set --shell m 'gh pr merge $1'",
    "bash -c 'git config alias.p push'",
  ];
  for (const command of aliases) {
    it(`forbids defining an alias that pushes, merges or opens a pull request: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /alias/);
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

describe('isGatedCommand through wrappers, other shells and aliases', () => {
  const gated = [
    'command git push',
    'env FOO=1 git push -u origin 42-harden-gate',
    'time git push',
    'bash -c "git push"',
    'pwsh -Command "gh pr create --draft"',
    'cmd /c git push',
    "iex 'git push'",
    '"C:\\Program Files\\Git\\cmd\\git.exe" push',
    "& 'C:\\Program Files\\GitHub CLI\\gh.exe' pr create --draft",
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

  // Plain documentation needs no review summary (#183): *.md in a subfolder of docs/ other than adr/.
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

  // ADRs, the top-level docs (the design and the review's criteria), CLAUDE.md, prompts, root files
  // and anything that is not Markdown in a subfolder of docs/ are reviewed.
  for (const files of [
    ['docs/glossary.md'],
    ['docs/architecture.md'],
    ['docs/brewers-and-recipes.md'],
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

  const api = [
    `gh api graphql -f query='mutation { markPullRequestReadyForReview(input: {pullRequestId: "PR_kw1"}) { clientMutationId } }'`,
    'gh api graphql -F id=PR_kw1 -f query="mutation(\\$id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: \\$id}) { clientMutationId } }"',
  ];
  for (const command of api) {
    it(`blocks marking a pull request ready through gh api: ${command}`, async () => {
      const { result, lookups } = await ready(command, facts([summary(c3.sha)], [c1, c2, c3]));
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /through gh api is blocked: run gh pr ready <n>/);
      assert.deepEqual(lookups, []);
    });
  }

  // The lookup runs before the command does, so it would see the head from before the push.
  for (const command of [
    'git push && gh pr ready 160',
    'gh pr create --draft --fill && gh pr ready',
    'bash -c "git push origin 154-x; gh pr ready 160"',
  ]) {
    it(`blocks gh pr ready in the same command as a push or a new pull request: ${command}`, async () => {
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
    'gh api graphql -F query=@ready.graphql -F id=PR_kw1',
    'gh api graphql --input body.json',
    'gh api graphql -f query="$q"',
  ]) {
    it(`blocks gh api graphql with a query the gate cannot read: ${command}`, async () => {
      const { result } = await ready(command, facts([], [c1, c2, c3]));
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /gh api graphql with a query the gate cannot read/);
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

  for (const command of [
    'gh api -X POST graphql -F query=@ready.graphql -F id=PR_kw1',
    "gh api -H 'Accept: application/json' graphql --input body.json",
    'gh api graphql -Fquery=@ready.graphql',
    'gh api graphql --field=query=@ready.graphql',
    'gh api graphql --raw-field=query="$q"',
  ]) {
    it(`blocks gh api graphql with a query the gate cannot read, in any order: ${command}`, async () => {
      const { result } = await ready(command, facts([], [c1, c2, c3]));
      assert.match(result.stderr, /gh api graphql with a query the gate cannot read/);
    });
  }

  it('names gh pr ready among the plain commands when a command nests too deeply', () => {
    assert.match(forbiddenReason(`${'eval '.repeat(40)}gh pr ready 160`) ?? '', /gh pr ready/);
  });

  it("forbids defining an alias that marks a pull request ready: gh alias set r 'pr ready'", () => {
    assert.match(forbiddenReason("gh alias set r 'pr ready'") ?? '', /alias/);
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
    'rm "$file"',
    'rm -fv $(ls *.log)',
    // A single-quoted $ is literal in both shells.
    "rm -rf '$dir'",
    'Remove-Item -Recurse -Force .foedrum/tmp/218/run',
    'Remove-Item -Recurse:$true -Force .foedrum/tmp/218/run',
    'Remove-Item -Force $p',
    'Remove-Item $p',
    'Get-ChildItem .foedrum/tmp/218 | Remove-Item -Recurse',
    'rd /s /q .foedrum\\tmp\\218',
    'del %X%',
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

  for (const command of ['rm -rf .foedrum/tmp/218/run', 'rm -f "$file"']) {
    it(`lets through: ${command}`, async () => {
      const { calls, runCheck } = fakeCheck({ ok: false, output: '' });
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

  it('runs npm run check with this node and the npm CLI found next to it, in the given directory', async () => {
    const { calls, runProcess } = fakeProcess({ exitCode: 0, output: '' });
    const looked: string[] = [];
    const findNpmCli: FindNpmCli = async (path) => {
      looked.push(path);
      return { path: npmCli, tried: [npmCli] };
    };
    await npmCheck(execPath, findNpmCli, runProcess)('/work/tree');
    assert.deepEqual(looked, [execPath]);
    assert.deepEqual(calls, [[execPath, [npmCli, 'run', 'check'], '/work/tree']]);
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
