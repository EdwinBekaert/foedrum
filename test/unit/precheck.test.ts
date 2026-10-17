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
  gitHeadIsDetached,
  isDetached,
  isGatedCommand,
  npmCheck,
  type ProcessOutcome,
  precheck,
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
