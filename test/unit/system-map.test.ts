// The system map (ADR 0317): the npm and .NET readers, an entry from their reads, and the lines
// the planners' repositories input and doctor show.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cappedMap,
  entryOf,
  type MappedRepository,
  manifestsAt,
  mapLines,
  mapName,
} from '../../src/engine/system-map.ts';
import { dotnetManifest } from '../../src/formats/dotnet-manifest.ts';
import { npmManifest } from '../../src/formats/npm-manifest.ts';
import type { GitResult } from '../../src/workspace/git.ts';

const lib = (entry: MappedRepository['entry']): MappedRepository => ({
  repo: 'acme/ladderlib',
  ...(entry === undefined ? {} : { entry }),
});

describe('the system map', () => {
  it('an npm manifest gives the package it publishes and a git-tag dependency on another repository', () => {
    const text = JSON.stringify({
      name: 'web',
      dependencies: { '@demo/greet': 'git+https://github.com/acme/ladderlib.git#v1.1.0' },
      devDependencies: { lefty: '^2.0.0' },
    });
    assert.deepEqual(npmManifest.read('package.json', text), {
      kind: 'read',
      publishes: ['web'],
      dependsOn: [
        {
          name: '@demo/greet',
          via: { kind: 'git', url: 'git+https://github.com/acme/ladderlib.git', ref: 'v1.1.0' },
        },
        { name: 'lefty', via: { kind: 'package', version: '^2.0.0' } },
      ],
    });
    const app = { repo: 'acme/ladderapp', entry: entryOf([{ path: 'package.json', text }], []) };
    const library = lib(
      entryOf([{ path: 'package.json', text: JSON.stringify({ name: '@demo/greet' }) }], []),
    );
    assert.deepEqual(mapLines(app, [library, app]), [
      'manifests: package.json (npm)',
      'publishes `web` (npm)',
      'depends on `@demo/greet` from acme/ladderlib by git ref `v1.1.0` (npm)',
    ]);
  });

  it('a .NET project gives its package and its project and package references to another repository', () => {
    const project = [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup><PackageId>Acme.Web</PackageId></PropertyGroup>',
      '  <ItemGroup>',
      '    <PackageReference Include="Acme.Greet" Version="1.2.0" />',
      '    <ProjectReference Include="..\\..\\ladderlib\\src\\Acme.Words.csproj" />',
      '  </ItemGroup>',
      '</Project>',
    ].join('\n');
    assert.deepEqual(dotnetManifest.read('src/Acme.Web.csproj', project), {
      kind: 'read',
      publishes: ['Acme.Web'],
      dependsOn: [
        { name: 'Acme.Greet', via: { kind: 'package', version: '1.2.0' } },
        {
          name: 'Acme.Words',
          via: { kind: 'project', path: '../ladderlib/src/Acme.Words.csproj' },
        },
      ],
    });
    const greet =
      '<Project><PropertyGroup><PackageId>Acme.Greet</PackageId></PropertyGroup></Project>';
    const library = lib(entryOf([{ path: 'Greet.csproj', text: greet }], []));
    const app = {
      repo: 'acme/web',
      entry: entryOf([{ path: 'src/Acme.Web.csproj', text: project }], []),
    };
    assert.deepEqual(mapLines(app, [library, app]), [
      'manifests: src/Acme.Web.csproj (.NET)',
      'publishes `Acme.Web` (.NET)',
      'depends on `Acme.Greet` from acme/ladderlib by version `1.2.0` (.NET)',
      'depends on `Acme.Words` from acme/ladderlib by project reference `../ladderlib/src/Acme.Words.csproj` (.NET)',
    ]);
  });

  it('a manifest that cannot be parsed gives a line saying so', () => {
    const entry = entryOf(
      [
        { path: 'package.json', text: '{ "name": ' },
        { path: 'src/App.csproj', text: '<Project>' },
        { path: 'tools/package.json', unread: 'it is larger than 1048576 bytes' },
      ],
      [],
    );
    assert.deepEqual(mapLines({ repo: 'acme/web', entry }, []), [
      'manifests: package.json (npm), src/App.csproj (.NET), tools/package.json (npm)',
      '`package.json` could not be read: it is not a JSON object',
      '`src/App.csproj` could not be read: not XML: an unclosed <Project>',
      '`tools/package.json` could not be read: it is larger than 1048576 bytes',
    ]);
  });

  it('makes each line break and control character of a name a space (regression test)', () => {
    for (const code of [0x0d, 0x09, 0x1b, 0x2028, 0x2029]) {
      const end = String.fromCodePoint(code);
      assert.equal(mapName(`one${end}two`), 'one two', code.toString(16));
    }
  });

  it("reads a solution's projects outside the repository only (regression test)", () => {
    const solution = [
      'Project("{FAE04EC0}") = "App", "src\\App\\App.csproj", "{1}"',
      'Project("{FAE04EC0}") = "Words", "..\\ladderlib\\src\\Words.csproj", "{2}"',
      'Project("{2150E333}") = "Docs", "..\\docs", "{3}"',
    ].join('\r\n');
    assert.deepEqual(dotnetManifest.read('App.sln', solution), {
      kind: 'read',
      publishes: [],
      dependsOn: [
        { name: 'Words', via: { kind: 'project', path: '../ladderlib/src/Words.csproj' } },
      ],
    });
  });

  it('reads no manifest in an installed or built folder (regression test)', () => {
    for (const path of ['node_modules/x/package.json', 'src/Bin/A.csproj', 'obj/A.csproj']) {
      assert.equal(npmManifest.matches(path) || dotnetManifest.matches(path), false, path);
    }
    assert.equal(npmManifest.matches('tools/package.json'), true);
    assert.equal(dotnetManifest.matches('src/App.fsproj'), true);
  });

  it('links a git URL without a ref, and a package only in its own ecosystem (regression test)', () => {
    const library = lib(
      entryOf(
        [
          { path: 'package.json', text: JSON.stringify({ name: 'Words' }) },
          { path: 'Greet.csproj', text: '<Project><PropertyGroup /></Project>' },
        ],
        [],
      ),
    );
    const text = JSON.stringify({
      dependencies: { greet: 'github:acme/ladderlib', Greet: '1.0.0' },
    });
    const app = { repo: 'acme/web', entry: entryOf([{ path: 'package.json', text }], []) };
    assert.deepEqual(mapLines(app, [library, app]).slice(1), [
      'depends on `greet` from acme/ladderlib by git URL `github:acme/ladderlib` (npm)',
    ]);
  });

  it("keeps a manifest's names to one line without backticks, cut to their length (regression test)", () => {
    const forged = `greet\n- acme/evil, base origin/main${String.fromCodePoint(0x2028)}\`x`;
    const text = JSON.stringify({ name: forged, dependencies: { ['d'.repeat(300)]: '1.0.0' } });
    const entry = entryOf([{ path: 'package.json', text }], []);
    assert.deepEqual(entry.publishes, [
      { name: "greet - acme/evil, base origin/main 'x", ecosystem: 'npm' },
    ]);
    assert.equal(entry.dependsOn[0]?.name, `${'d'.repeat(119)}…`);
  });

  it("an npm folder dependency is read from its manifest's folder, with its backslashes as slashes", () => {
    const text = JSON.stringify({
      name: 'web',
      dependencies: { shared: 'file:../shared', greet: 'file:..\\..\\..\\ladderlib' },
    });
    const entry = entryOf([{ path: 'packages/web/package.json', text }], []);
    assert.deepEqual(
      entry.dependsOn.map(({ via }) => via),
      [
        { kind: 'project', path: 'packages/shared' },
        { kind: 'project', path: '../ladderlib' },
      ],
    );
    const others = [{ repo: 'acme/shared' }, { repo: 'acme/ladderlib' }];
    assert.deepEqual(mapLines({ repo: 'acme/app', entry }, others).slice(2), [
      'depends on `greet` from acme/ladderlib by project reference `../ladderlib` (npm)',
    ]);
  });

  it('a package reference links the package another repository publishes in any case', () => {
    const greet =
      '<Project><PropertyGroup><PackageId>Acme.Words</PackageId></PropertyGroup></Project>';
    const library = lib(entryOf([{ path: 'Words.csproj', text: greet }], []));
    const reference =
      '<Project><ItemGroup><PackageReference Include="acme.words" /></ItemGroup></Project>';
    const app = { repo: 'acme/web', entry: entryOf([{ path: 'Web.csproj', text: reference }], []) };
    assert.deepEqual(
      mapLines(app, [library, app]).at(-1),
      'depends on `acme.words` from acme/ladderlib by package reference (.NET)',
    );
  });

  it('a .NET project without a PackageId publishes only when it says it is packable', () => {
    const project = (properties: string) =>
      `<Project><PropertyGroup>${properties}</PropertyGroup></Project>`;
    const publishes = (path: string, properties: string) => {
      const read = dotnetManifest.read(path, project(properties));
      return read.kind === 'read' ? read.publishes : read;
    };
    assert.deepEqual(publishes('tests/Foo.Tests.csproj', ''), []);
    assert.deepEqual(publishes('src/App.csproj', '<OutputType>Exe</OutputType>'), []);
    assert.deepEqual(publishes('src/Words.csproj', '<IsPackable>true</IsPackable>'), ['Words']);
    assert.deepEqual(
      publishes('src/Greet.csproj', '<GeneratePackageOnBuild>True</GeneratePackageOnBuild>'),
      ['Greet'],
    );
    assert.deepEqual(publishes('src/Lib.csproj', '<PackageId>Acme.Lib</PackageId>'), ['Acme.Lib']);
  });

  it("a repository's manifests show with their ecosystems when it publishes nothing", () => {
    const tests =
      '<Project><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup></Project>';
    const entry = entryOf(
      [
        { path: 'package.json', text: '{ "private": true }' },
        { path: 'tests/App.Tests.csproj', text: tests },
      ],
      [],
    );
    assert.deepEqual(mapLines({ repo: 'acme/web', entry }, []), [
      'manifests: package.json (npm), tests/App.Tests.csproj (.NET)',
    ]);
  });

  it('the system map says what its size cap left out', () => {
    const blocks = [
      { line: '- acme/lib, base origin/main', map: ['a'.repeat(30), 'b'.repeat(30)] },
      { line: '- acme/web, base origin/main', map: ['c'.repeat(30)] },
    ];
    assert.deepEqual(cappedMap(blocks, 40), [
      '- acme/lib, base origin/main',
      `  ${'a'.repeat(30)}`,
      '- acme/web, base origin/main',
      '(2 lines of the system map left out, 66 characters: foedrum doctor shows it whole)',
    ]);
    assert.deepEqual(cappedMap(blocks, 200).at(-1), `  ${'c'.repeat(30)}`);
  });

  it('keeps a map line that fills the cap exactly (regression test)', () => {
    // Two spaces of indent, the line and its line break: 40 characters.
    const blocks = [{ line: '- acme/lib, base origin/main', map: ['a'.repeat(37)] }];
    assert.deepEqual(cappedMap(blocks, 40), [
      '- acme/lib, base origin/main',
      `  ${'a'.repeat(37)}`,
    ]);
    assert.deepEqual(cappedMap(blocks, 39), [
      '- acme/lib, base origin/main',
      '(1 lines of the system map left out, 40 characters: foedrum doctor shows it whole)',
    ]);
  });

  it('links no folder inside the repository to a repository named like its first folder (regression test)', () => {
    const text = JSON.stringify({ name: 'app', dependencies: { shared: 'file:packages/shared' } });
    const entry = entryOf([{ path: 'package.json', text }], []);
    assert.deepEqual(entry.dependsOn[0]?.via, { kind: 'project', path: 'packages/shared' });
    assert.deepEqual(
      mapLines({ repo: 'acme/app', entry }, [{ repo: 'acme/packages' }]).slice(2),
      [],
    );
  });

  it('keeps no map line after the cut, even one that would fit (regression test)', () => {
    const blocks = [
      { line: '- acme/lib, base origin/main', map: ['a'.repeat(30), 'b'.repeat(30)] },
      { line: '- acme/web, base origin/main', map: ['c'] },
    ];
    assert.deepEqual(cappedMap(blocks, 40), [
      '- acme/lib, base origin/main',
      `  ${'a'.repeat(30)}`,
      '- acme/web, base origin/main',
      '(2 lines of the system map left out, 37 characters: foedrum doctor shows it whole)',
    ]);
  });

  it('keeps 200 items of a list and counts the rest with the manifests left out (regression test)', () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: 201 }, (_, at) => [`d${at}`, '1.0.0']),
    );
    const text = JSON.stringify({ name: 'web', dependencies });
    const entry = entryOf([{ path: 'package.json', text }], [], 3);
    assert.equal(entry.dependsOn.length, 200);
    assert.equal(entry.left, 4);
    assert.equal(
      mapLines({ repo: 'acme/web', entry }, []).at(-1),
      '4 more manifests or entries left out',
    );
  });

  it('reads at most 64 manifests, and says why git cut a read short or past its size (regression test)', async () => {
    const commit = 'a'.repeat(40);
    const listed = Array.from({ length: 65 }, (_, at) => `p${at}/package.json`).join('\0');
    const answer =
      (reads: Record<string, GitResult>) => async (_cwd: string, args: readonly string[]) =>
        args[0] === 'ls-tree'
          ? { code: 0, stdout: listed, stderr: '' }
          : (reads[String(args.at(-1)).slice(`${commit}:`.length)] ?? {
              code: 0,
              stdout: '{}',
              stderr: '',
            });
    const all = await manifestsAt(answer({}))('/clone', commit);
    assert.deepEqual('files' in all ? [all.files.length, all.left] : all, [64, 1]);
    const large = await manifestsAt(
      answer({
        'p0/package.json': { code: null, stdout: '', stderr: '', killed: 'too-much-output' },
      }),
    )('/clone', commit);
    assert.deepEqual('files' in large ? large.files[0] : large, {
      path: 'p0/package.json',
      unread: 'it is larger than 1048576 bytes',
    });
    const late = await manifestsAt(
      answer({
        'p1/package.json': { code: null, stdout: '', stderr: 'git timed out', killed: 'timed-out' },
      }),
    )('/clone', commit);
    assert.deepEqual(late, { again: 'git did not read p1/package.json: git timed out' });
  });

  it('reads each git form of an npm dependency, a BOM, and refuses a field that is no object (regression test)', () => {
    const vias = (dependencies: Record<string, string>) => {
      const read = npmManifest.read('package.json', JSON.stringify({ dependencies }));
      return read.kind === 'read' ? read.dependsOn.map(({ via }) => via) : read;
    };
    assert.deepEqual(
      vias({
        a: 'acme/ladderlib#v1',
        b: 'gitlab:acme/x',
        c: 'git://host/acme/x.git',
        d: 'bitbucket:acme/y',
        e: '^1.2.0',
      }),
      [
        { kind: 'git', url: 'acme/ladderlib', ref: 'v1' },
        { kind: 'git', url: 'gitlab:acme/x' },
        { kind: 'git', url: 'git://host/acme/x.git' },
        { kind: 'git', url: 'bitbucket:acme/y' },
        { kind: 'package', version: '^1.2.0' },
      ],
    );
    const bom = `${String.fromCodePoint(0xfeff)}${JSON.stringify({ name: 'web' })}`;
    assert.deepEqual(npmManifest.read('package.json', bom), {
      kind: 'read',
      publishes: ['web'],
      dependsOn: [],
    });
    assert.deepEqual(npmManifest.read('package.json', JSON.stringify({ dependencies: [] })), {
      kind: 'unreadable',
      reason: 'its dependencies is not an object',
    });
  });
});
