// The system map (ADR 0317): the npm and .NET readers, an entry from their reads, and the lines
// the planners' repositories input and doctor show.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cappedMap,
  entryOf,
  type MappedRepository,
  mapLines,
} from '../../src/engine/system-map.ts';
import { dotnetManifest } from '../../src/formats/dotnet-manifest.ts';
import { npmManifest } from '../../src/formats/npm-manifest.ts';

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
});
