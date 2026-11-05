// The system map's Go reader (ADR 0320): the module a go.mod publishes, its requires and replaces,
// and what it refuses.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { entryOf, mapLines } from '../../src/engine/system-map.ts';
import { goManifest } from '../../src/formats/go-manifest.ts';

const dependsOn = (body: string, path = 'go.mod') => {
  const read = goManifest.read(path, `module example.com/own\n${body}`);
  return read.kind === 'read' ? read.dependsOn : read;
};

describe('the Go manifest', () => {
  it('a go.mod publishes its module and requires a module another repository publishes', () => {
    const user = [
      '// The application.',
      'module github.com/acme/web',
      '',
      'go 1.24',
      '',
      'require github.com/acme/greet v1.2.0',
      '',
      'require (',
      '\tgolang.org/x/text v0.3.0 // indirect',
      '\tgithub.com/acme/greet/sub/v2 v2.0.1',
      ')',
    ].join('\n');
    assert.deepEqual(goManifest.read('go.mod', user), {
      kind: 'read',
      publishes: ['github.com/acme/web'],
      dependsOn: [
        { name: 'github.com/acme/greet', via: { kind: 'package', version: 'v1.2.0' } },
        { name: 'golang.org/x/text', via: { kind: 'package', version: 'v0.3.0' } },
        { name: 'github.com/acme/greet/sub/v2', via: { kind: 'package', version: 'v2.0.1' } },
      ],
    });
    const library = {
      repo: 'acme/greet',
      entry: entryOf(
        [
          { path: 'go.mod', text: 'module github.com/acme/greet\n' },
          { path: 'sub/go.mod', text: 'module github.com/acme/greet/sub/v2\n' },
        ],
        [],
      ),
    };
    const app = { repo: 'acme/web', entry: entryOf([{ path: 'go.mod', text: user }], []) };
    assert.deepEqual(mapLines(app, [library, app]), [
      'manifests: go.mod (Go)',
      'publishes `github.com/acme/web` (Go)',
      'depends on `github.com/acme/greet` from acme/greet by version `v1.2.0` (Go)',
      'depends on `github.com/acme/greet/sub/v2` from acme/greet by version `v2.0.1` (Go)',
    ]);
  });

  it("a go.mod replace to another repository's git URL links the two", () => {
    const user = [
      'module github.com/acme/web',
      'require golang.org/x/words v1.0.0',
      'replace golang.org/x/words => github.com/acme/words/sub/v2 v2.1.0',
    ].join('\n');
    const app = { repo: 'acme/web', entry: entryOf([{ path: 'go.mod', text: user }], []) };
    assert.deepEqual(mapLines(app, [{ repo: 'acme/words' }, app]).slice(2), [
      'depends on `golang.org/x/words` from acme/words by git ref `v2.1.0` (Go)',
    ]);
  });

  it("a go.mod replace with a local path links the repository its folder names, from the manifest's folder", () => {
    const body =
      'require x.io/a v1.0.0\nreplace (\n\tx.io/a => ../../ladderlib\n\tx.io/b => ../b\n)\n';
    assert.deepEqual(dependsOn(body, 'tools/go.mod'), [
      { name: 'x.io/a', via: { kind: 'project', path: '../ladderlib' } },
      { name: 'x.io/b', via: { kind: 'project', path: 'b' } },
    ]);
    const app = {
      repo: 'acme/web',
      entry: entryOf([{ path: 'go.mod', text: `module x.io/web\n${body}` }], []),
    };
    assert.deepEqual(mapLines(app, [{ repo: 'acme/b' }, app]).slice(2), [
      'depends on `x.io/b` from acme/b by project reference `../b` (Go)',
    ]);
  });

  it('a versioned replace counts only for the version required, and an exact one before a bare one', () => {
    const body = (replaces: string[]) =>
      ['require x.io/a v1.0.0', ...replaces.map((each) => `replace ${each}`)].join('\n');
    const via = (replaces: string[]) => {
      const read = dependsOn(body(replaces));
      return Array.isArray(read) ? read.map((each) => each.via) : read;
    };
    assert.deepEqual(via(['x.io/a v1.0.0 => ./here']), [{ kind: 'project', path: 'here' }]);
    assert.deepEqual(via(['x.io/a v0.9.0 => ./here']), [{ kind: 'package', version: 'v1.0.0' }]);
    assert.deepEqual(via(['x.io/a => ./bare', 'x.io/a v1.0.0 => ./exact']), [
      { kind: 'project', path: 'exact' },
    ]);
    assert.deepEqual(via(['x.io/a => ./bare']), [{ kind: 'project', path: 'bare' }]);
  });

  it('cuts a replacement module to its host, owner and repository for the git URL', () => {
    assert.deepEqual(
      dependsOn(
        [
          'replace x.io/a => github.com/acme/fork/v2 v2.0.0',
          'replace x.io/b => github.com/acme/fork.git/sub v1.0.0',
          'replace x.io/c => gopkg.in/yaml.v3 v3.0.1',
        ].join('\n'),
      ),
      [
        { name: 'x.io/a', via: { kind: 'git', url: 'github.com/acme/fork', ref: 'v2.0.0' } },
        { name: 'x.io/b', via: { kind: 'git', url: 'github.com/acme/fork.git', ref: 'v1.0.0' } },
        { name: 'x.io/c', via: { kind: 'git', url: 'gopkg.in/yaml.v3', ref: 'v3.0.1' } },
      ],
    );
  });

  it('reads quoted paths, comments, a one-line empty block and CRLF, and ignores other directives', () => {
    const read = goManifest.read(
      'go.mod',
      [
        `${String.fromCodePoint(0xfeff)}module "x.io/own" // why`,
        'toolchain go1.24.0',
        'exclude (',
        '\tx.io/never v1.0.0 extra words',
        ')',
        'require ()',
        'require(',
        '  // a whole-line comment',
        '  `x.io/raw` "v1.0.0"',
        ')',
        'replace x.io/raw => "../my lib"',
      ].join('\r\n'),
    );
    assert.deepEqual(read, {
      kind: 'read',
      publishes: ['x.io/own'],
      dependsOn: [{ name: 'x.io/raw', via: { kind: 'project', path: '../my lib' } }],
    });
  });

  it('refuses each malformed form, with a line saying which', () => {
    const cases: [string, string][] = [
      ['go 1.24\n', 'it names no module'],
      ['module\n', 'a module line is not one module path'],
      ['module a b\n', 'a module line is not one module path'],
      ['module x.io/a\nrequire x.io/b\n', 'a require line is not a module and a version'],
      ['module x.io/a\nrequire x.io/b v1 v2\n', 'a require line is not a module and a version'],
      ['module x.io/a\nreplace x.io/b ./c\n', 'a replace line is not old => new'],
      ['module x.io/a\nreplace => ./c\n', 'a replace line is not old => new'],
      ['module x.io/a\nreplace x.io/b v1 v2 => ./c\n', 'a replace line is not old => new'],
      ['module x.io/a\nreplace x.io/b =>\n', 'a replace line is not old => new'],
      ['module x.io/a\nreplace x.io/b => a b c\n', 'a replace line is not old => new'],
      ['module x.io/a\nrequire (\n\tx.io/b v1\n', 'a require block is not closed'],
    ];
    for (const [text, reason] of cases) {
      assert.deepEqual(goManifest.read('go.mod', text), { kind: 'unreadable', reason }, text);
    }
  });

  it('reads a go.mod beside a folder named bin, and none vendored or in testdata', () => {
    for (const path of [
      'go.mod',
      'tools/go.mod',
      'bin/tool/go.mod',
      'obj/go.mod',
      'vendored/go.mod',
    ]) {
      assert.equal(goManifest.matches(path), true, path);
    }
    for (const path of [
      'vendor/github.com/x/go.mod',
      'a/testdata/mod/go.mod',
      'node_modules/x/go.mod',
      'go.sum',
      'notgo.mod',
      'go.mod/README.md',
    ]) {
      assert.equal(goManifest.matches(path), false, path);
    }
  });

  it('refuses a quote that does not close, whichever line and quote it is', () => {
    const reason = 'a line has a quote that does not close';
    for (const text of [
      'module "x.io/a\n',
      'module `x.io/a\n',
      'module x.io/a\nrequire "x.io/b v1.0.0\n',
      'module x.io/a\nreplace x.io/b => "\n',
    ]) {
      assert.deepEqual(goManifest.read('go.mod', text), { kind: 'unreadable', reason }, text);
    }
    assert.equal(goManifest.read('go.mod', 'module x.io/a // not "quoted\n').kind, 'read');
  });
});
