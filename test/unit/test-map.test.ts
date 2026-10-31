// The test map (ADR 0274): its schema read from JSONC, where it is kept, the effective map of a
// step, and the report paths it names in a worktree.

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  addedUnmeasured,
  areaOf,
  breweryMapPath,
  type EffectiveModule,
  effectiveMap,
  readTestMap,
  reportPaths,
  testMaps,
} from '../../src/checks/test-map.ts';
import type { TestMap, TestMapModule } from '../../src/schemas/test-map.ts';
import type { Git } from '../../src/workspace/git.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

// ADR 0274's sketch: a Node module, a .NET solution of two test projects, a Rust crate.
const example = `{
  // Derived from the manifests; confirmed in the pull request that carries it.
  "derivedFrom": {
    "globs": ["**/package.json", "**/*.sln", "**/*.csproj", "**/Cargo.toml"],
    "paths": ["web/package.json", "svc/Billing.sln", "svc/src/Billing/Billing.csproj",
              "svc/test/Billing.Tests/Billing.Tests.csproj", "svc/test/Billing.Api.Tests/Billing.Api.Tests.csproj",
              "engine/Cargo.toml"]
  },
  "modules": [
    {
      "name": "web",
      "code": ["web/src/**"],
      "tests": { "paths": ["web/test/**"] },
      "testReport": { "format": "junit", "path": "web/test-results.xml" },
      "coverage": { "format": "lcov", "path": "web/coverage/lcov.info" }
    },
    {
      "name": "billing",
      "code": ["svc/src/**"],
      "tests": {
        "projects": [
          { "path": "svc/test/Billing.Tests" },
          { "path": "svc/test/Billing.Api.Tests" }
        ]
      },
      "testReport": { "format": "trx", "path": "svc/test/*/TestResults" },
      "coverage": { "format": "cobertura", "path": "svc/test/*/TestResults" }
    },
    {
      "name": "engine",
      "code": ["engine/src/**"],
      "tests": { "inline": true },
      "testReport": { "format": "junit", "path": "engine/target/nextest/junit.xml" },
      "coverage": { "format": "lcov", "path": "engine/lcov.info" }
    }
  ]
}
`;

const web: TestMapModule = {
  name: 'web',
  code: ['web/src/**'],
  tests: { paths: ['web/test/**'] },
  testReport: { format: 'junit', path: 'web/test-results.xml' },
  coverage: { format: 'lcov', path: 'web/coverage/lcov.info' },
};
const billing: TestMapModule = {
  name: 'billing',
  code: ['svc/src/**'],
  tests: { projects: [{ path: 'svc/test/Billing.Tests' }] },
  testReport: { format: 'trx', path: 'svc/test/*/TestResults' },
  coverage: { format: 'cobertura', path: 'svc/test/*/TestResults' },
};
const mapOf = (...modules: TestMapModule[]): TestMap => ({
  derivedFrom: { globs: ['**/package.json'], paths: ['web/package.json'] },
  modules,
});
const noFiles = { atBase: [], deleted: [] };
const names = (modules: readonly EffectiveModule[]) =>
  modules.map(({ module, added }) => [module.name, added]);

describe('readTestMap (ADR 0274)', () => {
  it('reads a test map with a Node module, a .NET solution of two test projects and a Rust crate with inline tests', () => {
    const read = readTestMap(example);
    assert.equal(read.kind, 'map');
    if (read.kind !== 'map') return;
    assert.deepEqual(
      read.map.modules.map(({ name, tests, coverage }) => [name, tests, coverage]),
      [
        ['web', { paths: ['web/test/**'] }, { format: 'lcov', path: 'web/coverage/lcov.info' }],
        [
          'billing',
          {
            projects: [{ path: 'svc/test/Billing.Tests' }, { path: 'svc/test/Billing.Api.Tests' }],
          },
          { format: 'cobertura', path: 'svc/test/*/TestResults' },
        ],
        ['engine', { inline: true }, { format: 'lcov', path: 'engine/lcov.info' }],
      ],
    );
    assert.deepEqual(read.map.derivedFrom.globs, [
      '**/package.json',
      '**/*.sln',
      '**/*.csproj',
      '**/Cargo.toml',
    ]);
  });

  it('refuses a test map that holds a command', () => {
    const withCommand = example.replace('"name": "web",', '"name": "web", "command": "npm test",');
    const read = readTestMap(withCommand);
    assert.equal(read.kind, 'unreadable');
    assert.match(read.kind === 'unreadable' ? read.reason : '', /command/);
    const withRun = example.replace(
      '"tests": { "inline": true }',
      '"tests": { "inline": true, "run": "cargo nextest run" }',
    );
    assert.equal(readTestMap(withRun).kind, 'unreadable');
  });

  it('reads a map that does not parse as a reason, not as no map', () => {
    const cut = readTestMap(example.slice(0, 200));
    assert.equal(cut.kind, 'unreadable');
    // A glob that leads out of the repository is no path git names.
    const outside = readTestMap(example.replace('"web/src/**"', '"../web/src/**"'));
    assert.equal(outside.kind, 'unreadable');
    assert.match(outside.kind === 'unreadable' ? outside.reason : '', /path glob relative/);
    // A folder pattern across folders would match without bound.
    const deep = readTestMap(example.replace('"web/test-results.xml"', '"web/**/results.xml"'));
    assert.equal(deep.kind, 'unreadable');
  });
});

describe('readTestMap: report paths a reader matches at once (ADR 0274)', () => {
  it('refuses a report path with any wildcard but a star, or one longer than 256 characters', () => {
    const at = (path: string) =>
      readTestMap(example.replace('"web/test-results.xml"', JSON.stringify(path))).kind;
    assert.equal(at('web/test-*.xml'), 'map');
    for (const path of [
      'web/test-results?.xml',
      'web/[t]est-results.xml',
      'web/{a,b}/test-results.xml',
      'web/+(a|b).xml',
      'web/@(a).xml',
      'web/!(a).xml',
      `web/${'a'.repeat(250)}.xml`,
    ]) {
      assert.equal(at(path), 'unreadable', path);
    }
  });
});

describe('readTestMap: module names (review of #715)', () => {
  it('refuses a module name that starts with a dot or a dash, or holds a space or a line break: regression test', () => {
    const named = (name: string) =>
      readTestMap(example.replace('"name": "web"', `"name": ${JSON.stringify(name)}`)).kind;
    assert.equal(named('web.app_2-x'), 'map');
    for (const name of ['.web', '-web', 'web app', 'web\napp', '']) {
      assert.equal(named(name), 'unreadable', JSON.stringify(name));
    }
  });
});

describe('testMaps: where a map is kept (ADR 0018, ADR 0274)', () => {
  const blob = 'c'.repeat(40);
  const commit = 'd'.repeat(40);
  /** git in the clone: the map's entry at `commit`, and its blob's `text`. */
  const gitWith = (
    text: string | undefined,
    entry = `100644 blob ${blob}\t.foedrum/test-map.jsonc`,
  ) => {
    const calls: string[] = [];
    const git: Git = (cwd, args) => {
      calls.push(`${args.join(' ')} in ${cwd}`);
      if (args[0] === 'ls-tree') {
        const stdout = text === undefined ? '' : `${entry}\0`;
        return Promise.resolve({ code: 0, stdout, stderr: '' });
      }
      return Promise.resolve({ code: 0, stdout: text ?? '', stderr: '' });
    };
    return { git, calls };
  };
  const sources = (git: Git, keptIn: 'repo' | 'brewery', brewery?: string) =>
    testMaps({
      git,
      clone: (repo) => join('/work', repo, 'clone.git'),
      keptIn: () => keptIn,
      brewery: (repo) => (repo === 'Acme/Web' ? brewery : undefined),
    });

  it('reads the map at a commit of the clone, by its tree entry and its blob', async () => {
    const { git, calls } = gitWith(example);
    const read = await sources(git, 'repo')('Acme/Web', commit);
    assert.equal(read.kind, 'map');
    const clone = join('/work', 'Acme/Web', 'clone.git');
    assert.deepEqual(calls, [
      `ls-tree -z ${commit} -- .foedrum/test-map.jsonc in ${clone}`,
      `cat-file blob ${blob} in ${clone}`,
    ]);
    assert.deepEqual(await sources(gitWith(undefined).git, 'repo')('Acme/Web', commit), {
      kind: 'none',
    });
  });

  it("reads a test map from the Brewery when the repository's testMap is brewery", async () => {
    const other = example.replace('"name": "engine"', '"name": "crate"');
    const { git, calls } = gitWith(other);
    const read = await sources(git, 'brewery', example)('Acme/Web', commit);
    assert.equal(read.kind, 'map');
    assert.deepEqual(read.kind === 'map' ? read.map.modules.map(({ name }) => name) : [], [
      'web',
      'billing',
      'engine',
    ]);
    // The repository's own map is not read at all.
    assert.deepEqual(calls, []);
    assert.equal(breweryMapPath('Acme/Web'), 'test-maps/acme/web.jsonc');
    assert.deepEqual(await sources(git, 'brewery')('Acme/Other', commit), { kind: 'none' });
  });

  it('reads a map the clone holds as a link, or one git cannot read, as a reason', async () => {
    const link = gitWith(example, `120000 blob ${blob}\t.foedrum/test-map.jsonc`);
    assert.equal((await sources(link.git, 'repo')('Acme/Web', commit)).kind, 'unreadable');
    const failing: Git = () =>
      Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: bad object\n' });
    const read = await sources(failing, 'repo')('Acme/Web', commit);
    assert.deepEqual(read, {
      kind: 'unreadable',
      reason: 'git could not read it: fatal: bad object',
    });
    const broken = gitWith('{ "modules": [');
    assert.equal((await sources(broken.git, 'repo')('Acme/Web', commit)).kind, 'unreadable');
  });
});

describe('effectiveMap: the base governs what it lists (ADR 0274)', () => {
  it("the base's map governs a module the batch's map narrows", () => {
    const narrowed: TestMapModule = { ...web, code: ['web/src/new/**'], coverage: 'none' };
    const modules = effectiveMap(mapOf(web), mapOf(narrowed), noFiles, false);
    assert.deepEqual(names(modules), [['web', false]]);
    assert.deepEqual(modules[0]?.module.coverage, web.coverage);
    assert.deepEqual(areaOf(modules, 'web/src/old.ts', false), { module: 'web', area: 'code' });
    // A batch that removes the module keeps it as well.
    assert.deepEqual(names(effectiveMap(mapOf(web), mapOf(billing), noFiles, false)), [
      ['web', false],
      ['billing', true],
    ]);
  });

  it("a batch's map may add a module the base's map does not list", () => {
    const tools: TestMapModule = {
      ...web,
      name: 'tools',
      code: ['tools/**', 'web/src/**'],
      tests: { inline: true },
    };
    const modules = effectiveMap(mapOf(web), mapOf(web, tools), noFiles, false);
    assert.deepEqual(names(modules), [
      ['web', false],
      ['tools', true],
    ]);
    assert.deepEqual(areaOf(modules, 'tools/gen.ts', false), { module: 'tools', area: 'code' });
    // A path in both a base area and an added one is read by the base's entry.
    assert.deepEqual(areaOf(modules, 'web/src/app.ts', false), { module: 'web', area: 'code' });
    assert.deepEqual(areaOf(modules, 'web/test/app.test.ts', false), {
      module: 'web',
      area: 'tests',
    });
    assert.equal(areaOf(modules, 'README.md', false), undefined);
    // With no map on the base, every module is the batch's.
    assert.deepEqual(names(effectiveMap(undefined, mapOf(web), noFiles, false)), [['web', true]]);
  });

  it('a base module drops out only when the batch deletes every file under its areas', () => {
    const atBase = ['svc/src/Invoice.cs', 'svc/test/Billing.Tests/InvoiceTests.cs', 'README.md'];
    const some = { atBase, deleted: ['svc/src/Invoice.cs', 'README.md'] };
    assert.deepEqual(names(effectiveMap(mapOf(web, billing), mapOf(web), some, false)), [
      ['web', false],
      ['billing', false],
    ]);
    const every = {
      atBase,
      deleted: ['svc/src/Invoice.cs', 'svc/test/Billing.Tests/InvoiceTests.cs'],
    };
    assert.deepEqual(names(effectiveMap(mapOf(web, billing), mapOf(web), every, false)), [
      ['web', false],
    ]);
    // A module with no file at the base had nothing to delete: it stays.
    assert.deepEqual(
      names(effectiveMap(mapOf(web), undefined, { atBase, deleted: atBase }, false)),
      [['web', false]],
    );
  });

  it('folds case only where the file system does not tell case apart', () => {
    const modules = effectiveMap(mapOf(web), undefined, noFiles, false);
    assert.equal(areaOf(modules, 'Web/Src/app.ts', false), undefined);
    assert.deepEqual(areaOf(modules, 'Web/Src/app.ts', true), { module: 'web', area: 'code' });
    const every = { atBase: ['web/src/a.ts'], deleted: ['WEB/src/a.ts'] };
    assert.deepEqual(names(effectiveMap(mapOf(web), undefined, every, false)), [['web', false]]);
    assert.deepEqual(names(effectiveMap(mapOf(web), undefined, every, true)), []);
  });
});

describe('addedUnmeasured: the modules a batch adds with coverage none (ADR 0274)', () => {
  it('names a module only the batch lists with coverage none, never a base module it sets so', () => {
    const tools: TestMapModule = { ...web, name: 'tools', code: ['tools/**'], coverage: 'none' };
    const base = { kind: 'map' as const, map: mapOf(web) };
    const batch = {
      kind: 'map' as const,
      map: mapOf({ ...web, coverage: 'none' }, tools, billing),
    };
    assert.deepEqual(addedUnmeasured(base, batch), ['tools']);
    assert.deepEqual(addedUnmeasured({ kind: 'none' }, batch), ['web', 'tools']);
    assert.deepEqual(addedUnmeasured(base, { kind: 'none' }), []);
    assert.deepEqual(addedUnmeasured(base, { kind: 'unreadable', reason: 'x' }), []);
  });
});

describe('reportPaths: a report path in the worktree (ADR 0274)', () => {
  it('finds a file, and each folder a folder pattern matches', () => {
    const dir = makeTempDir('test-map');
    try {
      const worktree = join(dir.path, 'worktree');
      for (const project of ['Billing.Tests', 'Billing.Api.Tests', 'Billing.Testsuite']) {
        mkdirSync(join(worktree, 'svc', 'test', project, 'TestResults'), { recursive: true });
      }
      mkdirSync(join(worktree, 'web'), { recursive: true });
      writeFileSync(join(worktree, 'web', 'test-results.xml'), '<testsuites/>');
      assert.deepEqual(reportPaths('web/test-results.xml', worktree), {
        paths: [join(worktree, 'web', 'test-results.xml')],
      });
      const found = reportPaths('svc/test/*.Tests/TestResults', worktree);
      assert.deepEqual('paths' in found ? [...found.paths].sort() : found, [
        join(worktree, 'svc', 'test', 'Billing.Api.Tests', 'TestResults'),
        join(worktree, 'svc', 'test', 'Billing.Tests', 'TestResults'),
      ]);
      assert.deepEqual(reportPaths('web/missing.xml', worktree), { paths: [] });
    } finally {
      dir.remove();
    }
  });

  it('reads only a star as a wildcard in a report path, every other character as itself', () => {
    const dir = makeTempDir('test-map');
    try {
      const worktree = join(dir.path, 'worktree');
      for (const name of ['a1', 'a[1]', 'b-Tests', 'Tests']) {
        mkdirSync(join(worktree, 'out', name), { recursive: true });
      }
      assert.deepEqual(reportPaths('out/a[1]', worktree), {
        paths: [join(worktree, 'out', 'a[1]')],
      });
      const found = reportPaths('out/*Tests', worktree);
      assert.deepEqual('paths' in found ? [...found.paths].sort() : found, [
        join(worktree, 'out', 'Tests'),
        join(worktree, 'out', 'b-Tests'),
      ]);
      assert.deepEqual(reportPaths('out/*-*s', worktree), {
        paths: [join(worktree, 'out', 'b-Tests')],
      });
    } finally {
      dir.remove();
    }
  });

  it('refuses a report folder pattern that leads out of the worktree', () => {
    const dir = makeTempDir('test-map');
    try {
      const worktree = join(dir.path, 'worktree');
      // A sibling whose name starts with the worktree's.
      const outside = join(dir.path, 'worktree-other');
      mkdirSync(join(outside, 'Billing.Tests', 'TestResults'), { recursive: true });
      mkdirSync(join(worktree, 'svc'), { recursive: true });
      // A junction needs no privilege on Windows, and is a link elsewhere.
      symlinkSync(outside, join(worktree, 'svc', 'test'), 'junction');
      const refused = reportPaths('svc/test/*/TestResults', worktree);
      assert.ok('refused' in refused);
      assert.match(refused.refused, /svc\/test\/\*\/TestResults leads out of the worktree/);
    } finally {
      dir.remove();
    }
  });

  it('refuses a folder pattern that matches more folders than it reads', () => {
    const dir = makeTempDir('test-map');
    try {
      const worktree = join(dir.path, 'worktree');
      for (let n = 0; n < 65; n += 1)
        mkdirSync(join(worktree, 'test', `P${n}`), { recursive: true });
      const refused = reportPaths('test/*', worktree);
      assert.deepEqual(refused, { refused: 'test/* matches more than 64 paths' });
    } finally {
      dir.remove();
    }
  });
});
