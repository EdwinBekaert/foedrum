// The gate with real processes (ADR 0021): scripts/precheck.ts started by node, running the npm
// installed with that node (#41), and the hook command from .claude/settings.json run through
// bash the way Claude Code runs it.
// The gate's decisions are unit tests in test/unit/precheck.test.ts.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
// such as a detached HEAD in CI or in a review's scratch tree. The denylist is a fixture without
// entries, so no test reads the user's own (ADR 0114).
const envWithoutNpm = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key))),
  GIT_CEILING_DIRECTORIES: testsDir,
  FOEDRUM_DENYLIST: join(root, 'test', 'fixtures', 'denylist', 'empty.txt'),
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
        { cwd: root, env: envWithoutNpm({ CLAUDE_PROJECT_DIR: pushFrom.path }) },
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
        { cwd: root, env: envWithoutNpm({ CLAUDE_PROJECT_DIR: project.path }) },
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
        { cwd: root, env: envWithoutNpm({ CLAUDE_PROJECT_DIR: project.path }) },
      );
      assert.equal(code, 2);
      assert.match(stderr, /^git push is blocked: HEAD is detached in .*detached-head-/);
      assert.doesNotMatch(stderr, /stub npm/);
    } finally {
      // A real repository: removeTree clears git's read-only objects and retries busy files.
      await removeTree(project.path);
    }
  });

  // git's configuration files, read by real git before the push (ADR 0246): a mirror remote, then
  // a push refspec that deletes.
  it("blocks a push that git's configuration makes mirror or delete, asking real git", async () => {
    const project = makeTempDir('configured-push');
    try {
      const git = (args: string[]) =>
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
          cwd: project.path,
          stdio: 'ignore',
        });
      git(['init', '-q', '-b', 'main']);
      git(['commit', '-q', '--allow-empty', '-m', 'Initial commit']);
      const gate = () =>
        run(process.execPath, [script], hookInput('git push', project.path), {
          cwd: root,
          env: envWithoutNpm({ CLAUDE_PROJECT_DIR: project.path }),
        });
      git(['config', 'remote.origin.mirror', 'true']);
      const mirrored = await gate();
      assert.equal(mirrored.code, 2);
      assert.match(
        mirrored.stderr,
        /^git push is blocked: git's configuration makes it delete, force or mirror remote refs \(remote\.origin\.mirror true\)/,
      );
      git(['config', '--unset', 'remote.origin.mirror']);
      git(['config', 'remote.origin.push', ':refs/heads/x']);
      const deleting = await gate();
      assert.equal(deleting.code, 2);
      assert.match(deleting.stderr, /\(remote\.origin\.push :refs\/heads\/x\)/);
    } finally {
      await removeTree(project.path);
    }
  });

  // The commits no remote-tracking ref has, read by real git (ADR 0114): the word in the commit the
  // remote already has does not count.
  it('blocks a push whose commits hold a word on the denylist, naming the place only', async () => {
    const project = makeTempDir('denied-push');
    try {
      const git = (args: string[]) =>
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
          cwd: project.path,
          stdio: 'ignore',
        });
      git(['init', '-q', '-b', 'main']);
      writeFileSync(join(project.path, 'a.md'), 'examplecorp, already on the remote\n');
      git(['add', 'a.md']);
      git(['commit', '-q', '-m', 'Initial commit']);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      writeFileSync(join(project.path, 'notes.md'), 'one\nWe ship to ExampleCorp\n');
      git(['add', 'notes.md']);
      git(['commit', '-q', '-m', 'Add notes']);
      const list = `${project.path}-list.txt`;
      const gate = async (words: string) => {
        writeFileSync(list, words);
        return run(process.execPath, [script], hookInput('git push', project.path), {
          cwd: root,
          env: envWithoutNpm({ FOEDRUM_DENYLIST: list, CLAUDE_PROJECT_DIR: project.path }),
        });
      };
      const denied = await gate('# clients\nexamplecorp\n');
      assert.equal(denied.code, 2);
      assert.match(
        denied.stderr,
        /^git push is blocked: it would send a word on your denylist \(ADR 0114\), at commit [0-9a-f]{7} notes\.md:2\. /,
      );
      assert.doesNotMatch(denied.stderr, /example ?corp/i);
      // A word only in the commit the remote has passes on to the rest of the gate.
      assert.doesNotMatch((await gate('remote\n')).stderr, /denylist/);
    } finally {
      await removeTree(project.path);
      rmSync(`${project.path}-list.txt`, { force: true });
    }
  });

  // What gh would post, its body file read from the hook's working directory by the real reader
  // (ADR 0132); gh pr comment runs no check, so the hook starts nothing.
  it('blocks a body file that holds a word on the denylist, naming the file and line', async () => {
    const project = makeTempDir('denied-body');
    const list = `${project.path}-list.txt`;
    try {
      writeFileSync(list, '# clients\nexamplecorp\n');
      const gate = async (body: string) => {
        writeFileSync(join(project.path, 'body.md'), body);
        return run(
          process.execPath,
          [script],
          hookInput('gh pr comment 5 --body-file body.md', project.path),
          { cwd: root, env: envWithoutNpm({ FOEDRUM_DENYLIST: list }) },
        );
      };
      const denied = await gate('Thanks\nfor ExampleCorp\n');
      assert.equal(denied.code, 2);
      assert.match(
        denied.stderr,
        /^gh pr comment is blocked: it would send a word on your denylist \(ADR 0114\), at gh pr comment --body-file body\.md:2\. /,
      );
      assert.doesNotMatch(denied.stderr, /example ?corp/i);
      assert.deepEqual(await gate('Thanks\n'), { code: 0, stdout: '', stderr: '' });
    } finally {
      await removeTree(project.path);
      rmSync(list, { force: true });
    }
  });

  // What real git prints for messages, authors and a merge's conflict resolution, and a commit
  // another remote has, read against the remote the push goes to (ADR 0114).
  it('finds a word in a message, an author, a merge and a commit another remote has', async () => {
    const project = makeTempDir('denied-merge');
    const list = `${project.path}-list.txt`;
    try {
      const git = (args: string[]): string =>
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
          cwd: project.path,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      const write = (text: string) => writeFileSync(join(project.path, 'a.md'), text);
      git(['init', '-q', '-b', 'main']);
      write('base\n');
      git(['add', 'a.md']);
      git(['commit', '-q', '-m', 'Initial commit']);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      git(['checkout', '-q', '-b', 'side']);
      write('side for examplecorp\n');
      git(['commit', '-q', '-am', 'Side']);
      const side = git(['rev-parse', 'HEAD']).trim();
      // A private mirror has the side commit; the push to origin still sends it.
      git(['update-ref', 'refs/remotes/work/side', 'HEAD']);
      git(['checkout', '-q', 'main']);
      write('main\n');
      git(['commit', '-q', '-am', 'Tidy\n\nFor Acme Widget, see the notes']);
      const tidy = git(['rev-parse', 'HEAD']).trim();
      git([
        'commit',
        '-q',
        '--allow-empty',
        '--author',
        'AcmeWidget Bot <bot@example.com>',
        '-m',
        'Empty',
      ]);
      const empty = git(['rev-parse', 'HEAD']).trim();
      try {
        git(['merge', '-q', 'side']);
      } catch {
        // The conflict is the point: its resolution is a line the merge adds of its own.
      }
      write('resolved for ExampleCorp\n');
      git(['add', 'a.md']);
      git(['commit', '-q', '--no-edit']);
      const merge = git(['rev-parse', 'HEAD']).trim();
      writeFileSync(list, 'examplecorp\nacmewidget\n');
      const { code, stderr } = await run(
        process.execPath,
        [script],
        hookInput('git push', project.path),
        {
          cwd: root,
          env: envWithoutNpm({ FOEDRUM_DENYLIST: list, CLAUDE_PROJECT_DIR: project.path }),
        },
      );
      assert.equal(code, 2, stderr);
      for (const place of [
        `commit ${tidy.slice(0, 7)} message line 3`,
        `commit ${empty.slice(0, 7)} author`,
        `commit ${side.slice(0, 7)} a.md:1`,
        `commit ${merge.slice(0, 7)} a.md:1`,
      ]) {
        assert.ok(stderr.includes(place), `${place} in ${stderr}`);
      }
      assert.doesNotMatch(stderr, /example ?corp|acme ?widget/i);
    } finally {
      await removeTree(project.path);
      rmSync(list, { force: true });
    }
  });

  // The remote the command names reaches the scan through the real wiring (ADR 0114): origin has
  // the word's commit, public does not, and a URL or a computed remote has no tracking refs.
  it('reads against the remote the push names, and blocks one it cannot name', async () => {
    const project = makeTempDir('denied-remote');
    const list = `${project.path}-list.txt`;
    try {
      const git = (args: string[]): string =>
        execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
          cwd: project.path,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      git(['init', '-q', '-b', 'main']);
      git(['commit', '-q', '--allow-empty', '-m', 'Initial commit']);
      git(['update-ref', 'refs/remotes/public/main', 'HEAD']);
      writeFileSync(join(project.path, 'notes.md'), 'We ship to ExampleCorp\n');
      git(['add', 'notes.md']);
      git(['commit', '-q', '-m', 'Add notes']);
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      writeFileSync(list, 'examplecorp\n');
      const gate = (command: string) =>
        run(process.execPath, [script], hookInput(command, project.path), {
          cwd: root,
          env: envWithoutNpm({ FOEDRUM_DENYLIST: list, CLAUDE_PROJECT_DIR: project.path }),
        });
      const toPublic = await gate('git push public HEAD');
      assert.equal(toPublic.code, 2);
      assert.match(toPublic.stderr, /^git push is blocked: it would send a word .* notes\.md:1\. /);
      for (const command of ['git push https://example.invalid/x.git HEAD', 'git push "$r" HEAD']) {
        const blocked = await gate(command);
        assert.equal(blocked.code, 2);
        assert.match(blocked.stderr, /^git push is blocked: its remote is .*name the remote/);
      }
      // A branch name the refspec creates reaches the scan too (ADR 0246).
      const named = await gate('git push origin HEAD:refs/heads/examplecorp-x');
      assert.equal(named.code, 2);
      assert.match(named.stderr, /^git push is blocked: it would send a word .* at branch name\. /);
      assert.doesNotMatch(named.stderr, /example ?corp/i);
      // origin has the commit: the push to it passes on to the rest of the gate.
      assert.doesNotMatch((await gate('git push origin HEAD')).stderr, /denylist/);
    } finally {
      await removeTree(project.path);
      rmSync(list, { force: true });
    }
  });

  // A push from another directory runs that tree's check only inside CLAUDE_PROJECT_DIR (#132).
  it('runs the check of a pushed tree inside the project, and nothing outside it', async () => {
    const folder = makeTempDir('pushed-tree');
    try {
      const project = join(folder.path, 'project');
      // Each tree's check names its tree, so the output says where the check ran.
      for (const [dir, name] of [
        [project, 'project'],
        [join(project, 'wt'), 'wt'],
        [join(folder.path, 'other'), 'other'],
      ] as const) {
        mkdirSync(dir, { recursive: true });
        const check = `node ${JSON.stringify(npmStub)} run check ${name}`;
        writeFileSync(
          join(dir, 'package.json'),
          `${JSON.stringify({ private: true, scripts: { check } })}\n`,
        );
      }
      const { CLAUDE_PROJECT_DIR: _, ...env } = envWithoutNpm();
      const gate = (command: string, projectDir?: string) =>
        run(process.execPath, [script], hookInput(command, project), {
          cwd: root,
          env: projectDir === undefined ? env : { ...env, CLAUDE_PROJECT_DIR: projectDir },
        });
      for (const [command, name] of [
        ['git -C wt push', 'wt'],
        // The project's own folder is inside it.
        ['git -C . push', 'project'],
      ] as const) {
        const inside = await gate(command, project);
        assert.equal(inside.code, 2);
        assert.match(inside.stderr, new RegExp(`stub npm: run check ${name}\\b`));
      }
      for (const [command, projectDir] of [
        ['git -C ../other push', project],
        ['git -C wt push', undefined],
        // A CLAUDE_PROJECT_DIR that is not absolute tells the gate nothing.
        ['git -C wt push', 'project'],
      ] as const) {
        const blocked = await gate(command, projectDir);
        assert.equal(blocked.code, 2);
        assert.match(blocked.stderr, /^git push is blocked: it runs in .*, outside the project/);
        assert.doesNotMatch(blocked.stderr, /stub npm/);
      }
    } finally {
      folder.remove();
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
  // A gated push whose check runs in a directory where `npm run check -- --no-tests` passes at
  // once, so the gate does not recurse into this repository's own check. The check fails unless
  // npm hands the gate's `--no-tests` through to it (ADR 0249); the trailing `--` keeps node
  // from reading it as its own option. The push starts in the project the hook runs for (ADR
  // 0246), which links this checkout's scripts so the hook finds precheck.
  let gatedPush = '';
  let gatedProject = '';
  before(() => {
    assert.notEqual(hookCommand, '', 'no PreToolUse hook command');
    const check = `node -e "process.exit(process.argv.includes('--no-tests') ? 0 : 1)" --`;
    gatedProject = tempDir('safe-check', { private: true, scripts: { check } });
    symlinkSync(join(root, 'scripts'), join(gatedProject, 'scripts'), 'junction');
    gatedPush = hookInput('git push', gatedProject);
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
      env: envWithoutNpm({ CLAUDE_PROJECT_DIR: gatedProject, npm_execpath: npmStub }),
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
