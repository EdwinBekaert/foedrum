// The gate's decisions on the hook input, with the check and the process runner injected. The
// hook command and the real npm run in test/integration/precheck.test.ts (ADR 0021).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  type CheckResult,
  forbiddenReason,
  isGatedCommand,
  npmCheck,
  type ProcessOutcome,
  precheck,
  type RunProcess,
} from '../../scripts/precheck.ts';

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
    const input = hookInput('git push').replace('git', '\\u0067it');
    assert.doesNotMatch(input, /git/i);
    const result = await precheck(input, runCheck);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(calls, [root]);
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
      assert.match(forbiddenReason(command) ?? '', /gh pr merge/);
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

  // A fake process runner that records each call and answers with the given outcome.
  const fakeProcess = (outcome: ProcessOutcome) => {
    const calls: [file: string, args: string[], cwd: string][] = [];
    const runProcess: RunProcess = async (file, args, cwd) => {
      calls.push([file, args, cwd]);
      return outcome;
    };
    return { calls, runProcess };
  };

  it('runs npm run check with this node and npm_execpath in the given directory', async () => {
    const { calls, runProcess } = fakeProcess({ exitCode: 0, output: '' });
    await npmCheck({ npm_execpath: npmCli }, execPath, runProcess)('/work/tree');
    assert.deepEqual(calls, [[execPath, [npmCli, 'run', 'check'], '/work/tree']]);
  });

  it('passes when npm exits 0, keeping its output', async () => {
    const { runProcess } = fakeProcess({ exitCode: 0, output: 'all green\n' });
    const result = await npmCheck({ npm_execpath: npmCli }, execPath, runProcess)('/work/tree');
    assert.deepEqual(result, { ok: true, output: 'all green\n' });
  });

  it('fails when npm exits non-zero, keeping its output', async () => {
    const { runProcess } = fakeProcess({ exitCode: 1, output: 'not ok 1 - café\n' });
    const result = await npmCheck({ npm_execpath: npmCli }, execPath, runProcess)('/work/tree');
    assert.deepEqual(result, { ok: false, output: 'not ok 1 - café\n' });
  });

  it('fails when npm could not start or was killed', async () => {
    const { runProcess } = fakeProcess({ exitCode: null, output: 'spawn ENOENT' });
    const result = await npmCheck({ npm_execpath: npmCli }, execPath, runProcess)('/work/tree');
    assert.deepEqual(result, { ok: false, output: 'spawn ENOENT' });
  });

  for (const [name, env] of [
    ['missing', {}],
    ['empty', { npm_execpath: '' }],
  ] as const) {
    it(`fails without starting a process when npm_execpath is ${name}`, async () => {
      const { calls, runProcess } = fakeProcess({ exitCode: 0, output: '' });
      const result = await npmCheck(env, execPath, runProcess)('/work/tree');
      assert.equal(result.ok, false);
      assert.match(result.output, /npm_execpath is not set/);
      assert.deepEqual(calls, []);
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
  it('package.json has a check script and the hook entry point', () => {
    const { scripts } = readJson<{ scripts?: Record<string, string> }>(join(root, 'package.json'));
    assert.equal(scripts?.check, 'node scripts/check.ts');
    assert.equal(scripts?.['hook:gate'], 'node scripts/precheck.ts');
  });

  // No `if` filter: it only sees the start of a compound command, so `mkdir x && git push`
  // slipped through. precheck.ts decides for every call and exits early for most of them.
  // The command is anchored to the project and fails closed: when npm or the hook:gate script
  // cannot run, it explains why on stderr and exits 2, even on Claude Code versions without
  // onFailure. The shell is pinned to bash so PowerShell never parses `||` or `{ …; }`.
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
              'npm run --silent --prefix "${CLAUDE_PROJECT_DIR}" hook:gate || { echo "Foedrum gate could not run (npm failed); command blocked. Run npm run check yourself to see why." >&2; exit 2; }',
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
