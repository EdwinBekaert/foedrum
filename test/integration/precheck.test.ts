// The gate with real processes (ADR 0021): scripts/precheck.ts started by node, running the npm
// installed with that node (#41), and the hook command from .claude/settings.json run through
// bash the way Claude Code runs it.
// The gate's decisions are unit tests in test/unit/precheck.test.ts.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { findNpmCli } from '../../src/platform/executables.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const root = join(import.meta.dirname, '..', '..');
const script = join(root, 'scripts', 'precheck.ts');
const npmStub = join(root, 'test', 'fixtures', 'npm-cli-stub.ts');

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// The folder makeTempDir creates its folders in.
const testsDir = join(root, '.foedrum', 'tmp', 'tests');

// The environment without npm's own variables, so a test controls which npm a child sees. git
// stops at the tests folder, so a hook run in a test folder never sees this checkout's state,
// such as a detached HEAD in CI or in a review's scratch tree.
const envWithoutNpm = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key))),
  GIT_CEILING_DIRECTORIES: testsDir,
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

describe('scripts/precheck.ts started by node', () => {
  // The check script runs the npm stub, which writes its arguments and a split "é" and exits 3.
  it('blocks a push with exit 2 and npm output intact when npm run check fails', async () => {
    const pushFrom = makeTempDir('push-from');
    try {
      const check = `node ${JSON.stringify(npmStub)} run check`;
      writeFileSync(
        join(pushFrom.path, 'package.json'),
        `${JSON.stringify({ private: true, scripts: { check } })}
`,
      );
      const { code, stdout, stderr } = await run(
        process.execPath,
        [script],
        hookInput('git push', pushFrom.path),
        { cwd: root, env: envWithoutNpm() },
      );
      assert.equal(code, 2);
      assert.equal(stdout, '');
      assert.match(stderr, /npm run check failed/);
      assert.match(stderr, /stub npm: run check/);
      // The stub splits "é" across two writes.
      assert.match(stderr, /café/);
      assert.doesNotMatch(stderr, /�/);
    } finally {
      pushFrom.remove();
    }
  });

  // The hook runs before every Bash and PowerShell call, so a call that does not name git or gh
  // must cost no more than node and this one file (#41).
  it('loads no other module for a call that does not name git or gh', async () => {
    const recordLoads = `import { registerHooks } from 'node:module';
      registerHooks({ load(url, context, next) {
        if (url.startsWith('file:')) process.stderr.write('loaded ' + url + '\\n');
        return next(url, context);
      } });`;
    const { code, stderr } = await run(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(recordLoads)}`, script],
      hookInput('ls -la src', root),
      { cwd: root, env: envWithoutNpm() },
    );
    assert.equal(code, 0);
    assert.deepEqual(stderr.trim().split(/\r?\n/), [`loaded ${pathToFileURL(script).href}`]);
  });

  it('blocks a push from a checkout whose node_modules is out of date, before npm runs', async () => {
    const project = makeTempDir('stale-project');
    try {
      writeFileSync(join(project.path, 'package.json'), '{"private":true}\n');
      const packages = { '': {}, 'node_modules/zod': { version: '4.6.5', integrity: 'sha512-z' } };
      writeFileSync(join(project.path, 'package-lock.json'), JSON.stringify({ packages }));
      const { code, stderr } = await run(
        process.execPath,
        [script],
        hookInput('git push', project.path),
        { cwd: root, env: envWithoutNpm() },
      );
      assert.equal(code, 2);
      assert.equal(
        stderr,
        'node_modules is out of date with package-lock.json (node_modules/.package-lock.json is missing); run npm ci\n',
      );
    } finally {
      project.remove();
    }
  });

  it('blocks a push from a checkout whose HEAD is detached, asking real git', async () => {
    const project = makeTempDir('detached-head');
    try {
      const git = (args: string[]) =>
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
          cwd: project.path,
          stdio: 'ignore',
        });
      git(['init', '-q', '-b', 'main']);
      git(['commit', '-q', '--allow-empty', '-m', 'Initial commit']);
      git(['checkout', '-q', '--detach']);
      const { code, stderr } = await run(
        process.execPath,
        [script],
        hookInput('git push', project.path),
        { cwd: root, env: envWithoutNpm() },
      );
      assert.equal(code, 2);
      assert.match(stderr, /^git push is blocked: HEAD is detached in .*detached-head-/);
      assert.doesNotMatch(stderr, /stub npm/);
    } finally {
      // A real repository: removeTree clears git's read-only objects and retries busy files.
      await removeTree(project.path);
    }
  });

  it('lets npx run a binary in node_modules/.bin of the package around cwd, and no other', async () => {
    const project = makeTempDir('npx-binaries');
    try {
      writeFileSync(join(project.path, 'package.json'), '{"private":true}\n');
      mkdirSync(join(project.path, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(project.path, 'node_modules', '.bin', 'biome'), '');
      mkdirSync(join(project.path, 'src'));
      const gate = (command: string) =>
        run(process.execPath, [script], hookInput(command, join(project.path, 'src')), {
          cwd: root,
          env: envWithoutNpm(),
        });
      assert.deepEqual(await gate('npx biome check'), { code: 0, stdout: '', stderr: '' });
      const refused = await gate('npx prettier --write x.ts');
      assert.equal(refused.code, 2);
      assert.match(refused.stderr, /^`npx prettier` would download a package/);
    } finally {
      project.remove();
    }
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

  it('fails closed: blocks a push with exit 2 when the project has no scripts/precheck.ts', async () => {
    const project = tempDir('fail-closed', { private: true, scripts: {} });
    const { code, stderr } = await runHook(project, project, gatedPush);
    assert.equal(code, 2);
    assert.ok(stderr.includes('Foedrum gate could not run (exit 1)'), `stderr: ${stderr}`);
  });

  it('lets a call that does not name git or gh through', async () => {
    const { code, stdout, stderr } = await runHook(root, root, hookInput('ls -la src', root));
    assert.deepEqual({ code, stdout, stderr }, { code: 0, stdout: '', stderr: '' });
  });

  it("passes precheck's own block through without saying the gate could not run", async () => {
    const { code, stderr } = await runHook(root, root, hookInput('git push --force', root));
    assert.equal(code, 2);
    assert.match(stderr, /^Force push is blocked/);
    assert.doesNotMatch(stderr, /could not run/);
  });

  // npm_execpath points at the stub, which fails any check: the gate runs the npm installed with
  // its node instead, without npm around it (#41).
  it("runs the project's gate from a directory with another package.json and lets a passing push through", async () => {
    const elsewhere = tempDir('other-package', { private: true, scripts: {} });
    const { code, stderr } = await run('bash', ['-c', hookCommand], gatedPush, {
      cwd: elsewhere,
      env: envWithoutNpm({ CLAUDE_PROJECT_DIR: root, npm_execpath: npmStub }),
    });
    assert.equal(stderr, '');
    assert.equal(code, 0);
  });
});

// The real install, so the result depends on how node was installed on the machine (#41).
describe('findNpmCli on this machine', () => {
  // CI runs this on Windows, macOS and Linux, with the node and npm that setup-node installs.
  it('finds the npm installed with this node', () => {
    const { path, tried } = findNpmCli(process.execPath);
    assert.ok(path !== undefined, `tried ${tried.join(', ')}`);
    assert.match(path, /npm-cli\.js$/);
  });
});
