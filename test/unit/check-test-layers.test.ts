import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  checkTestLayer,
  checkTestLayers,
  REAL_GH_EXCEPTIONS,
  realGhFindings,
  realGhProblems,
} from '../../scripts/check-test-layers.ts';

// Source files that are scanned, never run (see the README in the folder).
const fixtures = join(import.meta.dirname, '..', 'fixtures', 'test-layers');
const clean = join(fixtures, 'clean');
const spawning = join(fixtures, 'spawning');
// A test/ folder in miniature: every subfolder but unit/ has a file that imports child_process.
const testDir = join(fixtures, 'test-dir');

const none: ReadonlyMap<string, string> = new Map();

const spawningFiles = [
  'bare-specifier.test.ts',
  'dynamic-import.test.ts',
  'helpers/re-export.ts',
  'named-import.test.ts',
  'nested/side-effect.test.mts',
  'require.test.cjs',
];

describe('checkTestLayer', () => {
  it('reports nothing for a folder whose files do not import child_process', () => {
    assert.deepEqual(checkTestLayer(clean, none), []);
  });

  it('reports every source file that imports child_process, in any form and folder', () => {
    const problems = checkTestLayer(spawning, none);
    assert.deepEqual(
      problems.map(({ file }) => file),
      spawningFiles,
    );
    for (const { problem } of problems) {
      assert.match(problem, /imports child_process/);
      assert.match(problem, /test\/integration\//);
    }
  });

  it('leaves out the files on the exception list', () => {
    const exceptions = new Map([
      ['require.test.cjs', 'a reason'],
      ['nested/side-effect.test.mts', 'another reason'],
    ]);
    assert.deepEqual(
      checkTestLayer(spawning, exceptions).map(({ file }) => file),
      spawningFiles.filter((file) => !exceptions.has(file)),
    );
  });

  it('reports an exception for a file that does not import child_process or does not exist', () => {
    const exceptions = new Map([
      ['pure.test.ts', 'no longer needed'],
      ['gone.test.ts', 'file was moved'],
    ]);
    const stale = checkTestLayer(spawning, exceptions).filter(({ file }) => exceptions.has(file));
    assert.deepEqual(
      stale.map(({ file }) => file),
      ['gone.test.ts', 'pure.test.ts'],
    );
    for (const { problem } of stale) {
      assert.match(problem, /exception list.*does not import child_process/);
    }
  });
});

describe('checkTestLayers', () => {
  it('reports imports in property/, chaos/ and helpers/, relative to the test folder', () => {
    const problems = checkTestLayers(testDir, none);
    assert.deepEqual(
      problems.map(({ file }) => file),
      ['chaos/spawns.test.ts', 'helpers/real-runner.ts', 'property/spawns.test.ts'],
    );
    for (const { problem } of problems) assert.match(problem, /imports child_process/);
  });

  it('leaves out exceptions and reports stale ones, by path relative to the test folder', () => {
    const exceptions = new Map([
      ['helpers/real-runner.ts', 'a reason'],
      ['unit/pure.test.ts', 'no longer needed'],
    ]);
    assert.deepEqual(
      checkTestLayers(testDir, exceptions).map(({ file, problem }) => [
        file,
        /exception list/.test(problem),
      ]),
      [
        ['chaos/spawns.test.ts', false],
        ['property/spawns.test.ts', false],
        ['unit/pure.test.ts', true],
      ],
    );
  });
});

// The real process runner starts processes without the file importing child_process (#12).
describe('checkTestLayer and the real process runner', () => {
  const runner = join(fixtures, 'runner');
  const runnerFiles = [
    'dynamic-import.test.ts',
    'exec-import.test.ts',
    'helpers/re-export.ts',
    'helpers/star-re-export.ts',
    'named-import.test.ts',
    'namespace.test.ts',
    'require.test.cjs',
    'script-runner.test.ts',
  ];

  it('reports every file that imports spawnProcess or execProcess, in any form and folder', () => {
    const problems = checkTestLayer(runner, none);
    assert.deepEqual(
      problems.map(({ file }) => file),
      runnerFiles,
    );
    for (const { problem } of problems) {
      assert.match(problem, /imports the real process runner/);
      assert.match(problem, /fake/);
      assert.match(problem, /test\/integration\//);
    }
  });

  it('reports a file that imports streamProcess, the runner for long streams', () => {
    const problems = checkTestLayer(join(fixtures, 'stream-runner'), none);
    assert.deepEqual(
      problems.map(({ file }) => file),
      ['stream-import.test.ts'],
    );
    assert.match(problems[0]?.problem ?? '', /imports the real process runner/);
  });

  it('leaves out files that import only types, the runner with a fake spawner or other helpers', () => {
    assert.deepEqual(checkTestLayer(join(runner, 'clean'), none), []);
  });

  it('reports an exception for a file that imports neither child_process nor the runner', () => {
    const exceptions = new Map([['clean/fake-spawner.test.ts', 'no longer needed']]);
    const stale = checkTestLayer(runner, exceptions).filter(({ file }) => exceptions.has(file));
    assert.equal(stale.length, 1);
    assert.match(stale[0]?.problem ?? '', /exception list/);
  });

  it('leaves out the files on the exception list, which are then not stale', () => {
    const exceptions = new Map([['namespace.test.ts', 'a reason']]);
    assert.deepEqual(
      checkTestLayer(runner, exceptions).map(({ file }) => file),
      runnerFiles.filter((file) => file !== 'namespace.test.ts'),
    );
  });
});

// An integration test that can start the real gh, with whatever login the machine has (#220).
describe('realGhFindings', () => {
  const lines = (source: string) => realGhFindings(source).map(({ line }) => line);
  const problemOf = (source: string) => realGhFindings(source)[0]?.problem ?? '';

  it('reports a spawn of gh in any form, by its line', () => {
    const source = [
      "await execProcess('gh', ['auth', 'status'], { timeoutMs: 1000 });",
      'spawnSync("gh", ["--version"]);',
      "execFileSync('gh', args);",
      "execSync('gh auth status');",
      "await guarded('gh', ['api', 'user']);",
      "await spawnProcess('gh.exe', ['auth', 'token']);",
      'const stream = streamProcess(`gh`, args);',
      "spawn('gh', []);",
      "exec('gh api user');",
      "execFile('gh', args);",
      "await spawnProcess('gh.cmd', args);",
    ].join('\n');
    assert.deepEqual(lines(source), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.match(problemOf(source), /starts gh/);
    assert.match(problemOf(source), /GH_CONFIG_DIR/);
  });

  it('accepts a spawn of gh with a configuration of its own in the call, and other uses of the name', () => {
    const source = [
      "await execProcess('gh', ['auth', 'login'], {",
      '  env: { ...env, GH_CONFIG_DIR: configDir },',
      '});',
      "const found = resolveExecutable('gh');",
      "const row = at('gh');",
      "const isGh = name === 'gh';",
      "execSync('gh auth status', { env: { ...env, GH_CONFIG_DIR: configDir } });",
    ].join('\n');
    assert.deepEqual(realGhFindings(source), []);
  });

  it('reports doctorFromCheckout, serveFromCheckout and cliFromCheckout without an injected runner', () => {
    const source = [
      'await doctorFromCheckout(cwd);',
      'await serveFromCheckout(dir.path, { resolve });',
      "serve: async () => (await import('./serve-main.ts')).serveFromCheckout(cwd),",
      "await cliFromCheckout(['status'], cwd);",
      'await doctorFromCheckout(',
      '  cwd,',
      ');',
    ].join('\n');
    assert.deepEqual(lines(source), [1, 2, 3, 4, 5]);
    assert.match(problemOf(source), /doctorFromCheckout/);
    assert.match(problemOf(source), /exec/);
  });

  it('accepts those calls with an injected runner, also over several lines', () => {
    const source = [
      'await doctorFromCheckout(cwd, { exec, resolve });',
      'await serveFromCheckout(dir.path, {',
      '  exec: cannedGhLogin(),',
      '  resolve: resolveWithMadeUpGh,',
      '});',
      "await cliFromCheckout(['status'], cwd, { exec: cannedGhLogin(), resolve });",
    ].join('\n');
    assert.deepEqual(realGhFindings(source), []);
  });

  it('reports src/cli/main.ts run as a program or imported', () => {
    const source = [
      "const main = join(import.meta.dirname, '..', '..', 'src', 'cli', 'main.ts');",
      "await execProcess(process.execPath, ['src/cli/main.ts', 'doctor']);",
      "await import('../../src/cli/main.ts');",
    ].join('\n');
    assert.deepEqual(lines(source), [1, 2, 3]);
    assert.match(problemOf(source), /src\/cli\/main\.ts/);
    assert.match(problemOf(source), /cliFromCheckout/);
  });

  it('ignores what comments say', () => {
    const source = [
      '// the facts main.ts gathers (doctorFromCheckout(cwd)) and',
      "// execProcess('gh', ['auth', 'status']), never run.",
      "/* spawnSync('gh', []); serveFromCheckout(cwd); 'src/cli/main.ts' */",
      "const url = 'http://example.test/gh'; // execProcess('gh', [])",
    ].join('\n');
    assert.deepEqual(realGhFindings(source), []);
  });
});

describe('realGhProblems', () => {
  const sources = new Map([
    ['integration/doctor.test.ts', "await doctorFromCheckout(cwd);\nawait execProcess('gh', []);"],
    ['integration/fine.test.ts', 'await doctorFromCheckout(cwd, { exec, resolve });'],
    ['helpers/brewery.ts', "\n\nconst main = 'src/cli/main.ts';"],
    ['integration/serve.test.ts', "await execProcess(process.execPath, ['src/cli/main.ts']);"],
  ]);

  it('reports every finding by file and line, sorted', () => {
    assert.deepEqual(
      realGhProblems(sources, none).map(({ file, line }) => [file, line]),
      [
        ['helpers/brewery.ts', 3],
        ['integration/doctor.test.ts', 1],
        ['integration/doctor.test.ts', 2],
        ['integration/serve.test.ts', 1],
      ],
    );
  });

  it('leaves out a file on the exception list, and reports an exception whose file has no finding', () => {
    const exceptions = new Map([
      ['integration/serve.test.ts', 'the opt-in end-to-end serve test'],
      ['integration/fine.test.ts', 'no longer needed'],
      ['integration/gone.test.ts', 'file was moved'],
    ]);
    const problems = realGhProblems(sources, exceptions);
    assert.deepEqual(
      problems.map(({ file, line }) => [file, line]),
      [
        ['helpers/brewery.ts', 3],
        ['integration/doctor.test.ts', 1],
        ['integration/doctor.test.ts', 2],
        ['integration/fine.test.ts', undefined],
        ['integration/gone.test.ts', undefined],
      ],
    );
    for (const { problem } of problems.filter(({ line }) => line === undefined)) {
      assert.match(problem, /exception list.*real gh/);
    }
  });

  it('allows only the opt-in end-to-end serve test, with its reason', () => {
    assert.deepEqual([...REAL_GH_EXCEPTIONS.keys()], ['integration/serve.test.ts']);
    assert.match(REAL_GH_EXCEPTIONS.get('integration/serve.test.ts') ?? '', /fake GitHub/);
  });
});

describe('realGhFindings reads templates and regular expressions as code does', () => {
  it('reports a call inside a template’s ${…}, but not one in its text', () => {
    const source = [
      'const a = `${await doctorFromCheckout(cwd)}`;',
      "const b = `doctorFromCheckout(cwd) and execProcess('gh', [])`;",
      'const c = `${x} ${`${serveFromCheckout(cwd)}`}`;',
    ].join('\n');
    assert.deepEqual(
      realGhFindings(source).map(({ line }) => line),
      [1, 3],
    );
  });

  it('reads a regular expression with a quote in it as one, so a call after it on the line counts', () => {
    const source = [
      "const quote = /['\"]/; await execProcess('gh', ['auth', 'status']);",
      'const slash = /[/]/.test(x); await doctorFromCheckout(cwd);',
      'const half = total / 2; const ratio = a / b; await serveFromCheckout(dir);',
    ].join('\n');
    assert.deepEqual(
      realGhFindings(source).map(({ line }) => line),
      [1, 2, 3],
    );
  });

  it('reads a regular expression after a keyword as one, and a division after a name as one', () => {
    const source = [
      "if (ok) return /'/.test(x) && execProcess('gh', ['auth', 'status']);",
      'const kind = typeof /"/; await doctorFromCheckout(cwd);',
      "const quotient = total / 2, other = returned / 4; await execProcess('gh', []);",
    ].join('\n');
    assert.deepEqual(
      realGhFindings(source).map(({ line }) => line),
      [1, 2, 3],
    );
  });
});

// Naming the configuration or the runner is not enough when the call hands over the real one.
describe('realGhFindings and what an injected value really is', () => {
  it('reports a spawn of gh whose GH_CONFIG_DIR is the machine’s own or none', () => {
    const source = [
      "execProcess('gh', ['auth', 'status'], { env: { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR } });",
      "execProcess('gh', ['auth', 'status'], { env: { ...env, GH_CONFIG_DIR: undefined } });",
      "execProcess('gh', ['auth', 'status'], { env: { GH_CONFIG_DIR: process.env['GH_CONFIG_DIR'] } });",
    ].join('\n');
    assert.deepEqual(
      realGhFindings(source).map(({ line }) => line),
      [1, 2, 3],
    );
  });

  it('reports doctorFromCheckout, serveFromCheckout and cliFromCheckout given the real runner', () => {
    const source = [
      'await doctorFromCheckout(cwd, { exec: execProcess, resolve });',
      'await serveFromCheckout(cwd, { resolve, exec: spawnProcess });',
      "await cliFromCheckout(['doctor'], cwd, { exec: streamProcess });",
      'await doctorFromCheckout(cwd, { exec: cannedGhLogin(execProcess), resolve });',
    ].join('\n');
    assert.deepEqual(
      realGhFindings(source).map(({ line }) => line),
      [1, 2, 3],
    );
  });

  it('reports src/cli/main.ts written with escaped Windows separators', () => {
    assert.deepEqual(
      realGhFindings("const main = 'src\\\\cli\\\\main.ts';").map(({ line }) => line),
      [1],
    );
  });
});
