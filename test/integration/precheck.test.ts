// The gate with real processes (ADR 0021): scripts/precheck.ts started by node with a stub npm,
// and the hook command from .claude/settings.json run through bash the way Claude Code runs it.
// The gate's decisions are unit tests in test/unit/precheck.test.ts.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'precheck.ts');
const npmStub = join(root, 'test', 'fixtures', 'npm-cli-stub.ts');

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// The environment without npm's own variables, so a test controls which npm a child sees.
const envWithoutNpm = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key))),
  ...extra,
});

const run = (
  file: string,
  args: string[],
  stdin: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });

const hookInput = (command: string, cwd: string): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd,
  });

describe('scripts/precheck.ts with a stub npm', () => {
  it('blocks a push with exit 2 and npm output intact when npm run check fails', async () => {
    const { code, stdout, stderr } = await run(
      process.execPath,
      [script],
      hookInput('git push', root),
      {
        cwd: root,
        env: envWithoutNpm({ npm_execpath: npmStub }),
      },
    );
    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /npm run check failed/);
    assert.match(stderr, /stub npm: run check/);
    // The stub splits "é" across two writes.
    assert.match(stderr, /café/);
    assert.doesNotMatch(stderr, /�/);
  });
});

describe('the configured hook command', () => {
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as {
    hooks?: { PreToolUse?: { hooks?: { command?: string }[] }[] };
  };
  const hookCommand = settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';
  const runHook = (projectDir: string, cwd: string, stdin: string): Promise<ProcessResult> =>
    run('bash', ['-c', hookCommand], stdin, {
      cwd,
      env: envWithoutNpm({ CLAUDE_PROJECT_DIR: projectDir }),
    });

  const dirs: TempDir[] = [];
  const tempDir = (prefix: string, packageJson?: object): string => {
    const dir = makeTempDir(prefix);
    dirs.push(dir);
    if (packageJson !== undefined) {
      writeFileSync(join(dir.path, 'package.json'), `${JSON.stringify(packageJson)}\n`);
    }
    return dir.path;
  };
  // A gated push whose check runs in a directory where `npm run check` passes at once, so the
  // gate does not recurse into this repository's own check.
  let gatedPush = '';
  before(() => {
    assert.notEqual(hookCommand, '', 'no PreToolUse hook command');
    gatedPush = hookInput(
      'git push',
      tempDir('safe-check', { private: true, scripts: { check: 'node -e ""' } }),
    );
  });
  after(() => {
    for (const dir of dirs) dir.remove();
  });

  it('fails closed: blocks a push with exit 2 when the project has no package.json', async () => {
    const project = tempDir('no-package-json');
    const { code, stderr } = await runHook(project, project, gatedPush);
    assert.equal(code, 2);
    assert.ok(stderr.includes('Foedrum gate could not run (npm failed)'), `stderr: ${stderr}`);
  });

  it("runs the project's gate from a directory with another package.json and lets a passing push through", async () => {
    const elsewhere = tempDir('other-package', { private: true, scripts: {} });
    const { code, stderr } = await runHook(root, elsewhere, gatedPush);
    assert.equal(stderr, '');
    assert.equal(code, 0);
  });
});
