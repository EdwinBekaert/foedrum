import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  type CheckResult,
  forbiddenReason,
  isGatedCommand,
  precheck,
} from '../../scripts/precheck.ts';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'precheck.ts');

const hookInput = (command: string, cwd = root): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
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

const runScript = (
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });

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

  it('blocks when the hook input cannot be read', async () => {
    const { calls, runCheck } = fakeCheck({ ok: true, output: '' });
    const result = await precheck('not json', runCheck);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /hook input/);
    assert.deepEqual(calls, []);
  });
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

  const merges = ['gh pr merge 30', 'gh pr merge --squash --admin', 'git status && gh pr merge 30'];
  for (const command of merges) {
    it(`forbids merging a pull request: ${command}`, () => {
      assert.match(forbiddenReason(command) ?? '', /gh pr merge/);
    });
  }

  const allowed = [
    'git push',
    'git push -u origin 24-local-gate',
    'git push --follow-tags',
    'git push --no-force-with-lease',
    'git push origin --delete old-branch',
    'git push -o ci.skip origin main',
    'git merge origin/main',
    'git commit -m "never force push: use git push -f only in emergencies"',
    'gh pr create --draft',
    'gh pr view 30',
    'echo git push --force',
  ];
  for (const command of allowed) {
    it(`does not forbid: ${command}`, () => {
      assert.equal(forbiddenReason(command), undefined);
    });
  }
});

describe('precheck on forbidden commands', () => {
  for (const command of ['git push --force-with-lease', 'gh pr merge 30']) {
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

describe('scripts/precheck.ts entry point', () => {
  it('exits 0 silently for a command that is not gated', async () => {
    assert.deepEqual(await runScript(hookInput('git status')), { code: 0, stdout: '', stderr: '' });
  });

  it('exits 2 with a reason on stderr for unreadable input', async () => {
    const { code, stdout, stderr } = await runScript('not json');
    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /hook input/);
  });
});

interface HookHandler {
  type?: string;
  if?: string;
  command?: string;
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
    assert.equal(scripts?.check, 'npm run typecheck && npm run lint && npm test');
    assert.equal(scripts?.['hook:gate'], 'node scripts/precheck.ts');
  });

  for (const tool of ['Bash', 'PowerShell']) {
    for (const program of ['git', 'gh']) {
      it(`.claude/settings.json runs the gate before ${tool} ${program} commands`, () => {
        const settings = readJson<Settings>(join(root, '.claude', 'settings.json'));
        const handlers = (settings.hooks?.PreToolUse ?? [])
          .filter((group) => group.matcher === tool)
          .flatMap((group) => group.hooks ?? []);
        const handler = handlers.find((h) => h.if === `${tool}(${program} *)`);
        assert.deepEqual(handler && { ...handler, timeout: undefined }, {
          type: 'command',
          if: `${tool}(${program} *)`,
          command: 'npm run --silent hook:gate',
          onFailure: 'block',
          timeout: undefined,
        });
      });
    }
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
      'Write(/.npmrc)',
    ];
    assert.deepEqual(
      required.filter((rule) => !deny.includes(rule)),
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

  it('asks before pushing or opening a pull request', () => {
    const ask = permissions?.ask ?? [];
    for (const rule of ['git push *', 'gh pr create *']) {
      assert.ok(ask.includes(`Bash(${rule})`), `ask is missing Bash(${rule})`);
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
