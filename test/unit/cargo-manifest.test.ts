// The system map's Cargo reader (ADR 0320): the crate a Cargo.toml publishes, each dependency's
// source, and what it refuses.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { entryOf, mapLines } from '../../src/engine/system-map.ts';
import { cargoManifest } from '../../src/formats/cargo-manifest.ts';

const dependsOn = (toml: string, path = 'Cargo.toml') => {
  const read = cargoManifest.read(path, toml);
  return read.kind === 'read' ? read.dependsOn : read;
};

describe('the Cargo manifest', () => {
  it('a Cargo manifest publishes its crate and depends on a crate from another repository by git ref', () => {
    const user = [
      '[package]',
      'name = "ladder-web"',
      'description = """',
      '[dependencies]',
      'not-a-dependency = "1"',
      '"""',
      '[dependencies]',
      'greet = { git = "https://github.com/acme/ladderlib.git", tag = "v1.1.0", features = ["fr"] }',
      'left-pad = "1.2"',
    ].join('\n');
    assert.deepEqual(cargoManifest.read('Cargo.toml', user), {
      kind: 'read',
      publishes: ['ladder-web'],
      dependsOn: [
        {
          name: 'greet',
          via: { kind: 'git', url: 'https://github.com/acme/ladderlib.git', ref: 'v1.1.0' },
        },
        { name: 'left-pad', via: { kind: 'package', version: '1.2' } },
      ],
    });
    const library = {
      repo: 'acme/ladderlib',
      entry: entryOf([{ path: 'Cargo.toml', text: '[package]\nname = "greet"\n' }], []),
    };
    const app = { repo: 'acme/web', entry: entryOf([{ path: 'Cargo.toml', text: user }], []) };
    assert.deepEqual(mapLines(app, [library, app]), [
      'manifests: Cargo.toml (Cargo)',
      'publishes `ladder-web` (Cargo)',
      'depends on `greet` from acme/ladderlib by git ref `v1.1.0` (Cargo)',
    ]);
  });

  it("a Cargo workspace lists each member's crate", () => {
    const entry = entryOf(
      [
        {
          path: 'Cargo.toml',
          text: '[workspace]\nmembers = ["crates/*"]\n[workspace.dependencies]\ngreet = { git = "https://github.com/acme/ladderlib", rev = "abc123" }\n',
        },
        {
          path: 'crates/a/Cargo.toml',
          text: '[package]\nname = "a"\n[dependencies]\ngreet = { workspace = true }\n',
        },
        {
          path: 'crates/b/Cargo.toml',
          text: '[package]\nname = "b"\n[dependencies]\ngreet.workspace = true\n',
        },
      ],
      [],
    );
    assert.deepEqual(
      entry.publishes.map(({ name }) => name),
      ['a', 'b'],
    );
    // A member that inherits names no source: the root's entry gives the one link.
    assert.deepEqual(entry.dependsOn, [
      {
        name: 'greet',
        ecosystem: 'Cargo',
        via: { kind: 'git', url: 'https://github.com/acme/ladderlib', ref: 'abc123' },
      },
    ]);
  });

  it('an unreadable Cargo table is reported, not skipped', () => {
    const entry = entryOf(
      [
        { path: 'Cargo.toml', text: '[package]\nname = "a"\n[dependencies]\ngreet = 12\n' },
        { path: 'b/Cargo.toml', text: '[package\nname = "b"\n' },
      ],
      [],
    );
    assert.deepEqual(entry.publishes, []);
    assert.deepEqual(entry.unreadable, [
      { path: 'Cargo.toml', reason: 'its dependency greet is neither a version nor a table' },
      { path: 'b/Cargo.toml', reason: 'not TOML: an unclosed table header on line 1' },
    ]);
  });

  it("refuses a dependency key outside Cargo's schema, naming the key", () => {
    assert.deepEqual(dependsOn('[dependencies]\ngreet = { version = "1", frob = true }\n'), {
      kind: 'unreadable',
      reason: "its dependency greet has the key frob, which Cargo's schema does not name",
    });
    assert.deepEqual(dependsOn('[dependencies.greet]\nversion = "1"\nfeatures.x = "y"\n'), {
      kind: 'unreadable',
      reason: "its dependency greet has the key features.x, which Cargo's schema does not name",
    });
  });

  it("reads every key of Cargo's schema without refusing it", () => {
    const keys = [
      'artifact = "bin"',
      'base = "b"',
      'builtin = true',
      'branch = "main"',
      'default-features = false',
      'default_features = false',
      'features = ["a"]',
      'lib = true',
      'optional = true',
      'public = true',
      'registry = "r"',
      'registry-index = "https://r"',
      'rev = "abc"',
      'tag = "v1"',
      'target = "x"',
      'version = "1"',
    ];
    for (const key of keys) {
      const read = cargoManifest.read('Cargo.toml', `[dependencies]\ngreet = { ${key} }\n`);
      assert.equal(read.kind, 'read', key);
    }
  });

  it('refuses a source key that is no string, and a package name that is none', () => {
    for (const key of ['version', 'git', 'tag', 'rev', 'branch', 'path', 'package']) {
      assert.deepEqual(
        dependsOn(`[dependencies]\ngreet = { ${key} = 1 }\n`),
        { kind: 'unreadable', reason: `its dependency greet has a ${key} that is not a string` },
        key,
      );
    }
    assert.deepEqual(cargoManifest.read('Cargo.toml', '[package]\nname = 1\n'), {
      kind: 'unreadable',
      reason: 'its package name is not a string',
    });
  });

  it('reads each table and form a dependency comes in', () => {
    const toml = [
      '[dependencies]',
      'plain = "1"',
      'table = { version = "2" }',
      'dotted.version = "3"',
      'bare = { features = ["x"] }',
      'empty = {}',
      '[dev-dependencies]',
      'dev = "4"',
      '[build-dependencies]',
      'build = "5"',
      "[target.'cfg(unix)'.dependencies]",
      'unix = "6"',
      "[target.'cfg(unix)'.dev-dependencies]",
      'unix-dev = "7"',
      '[dependencies.header]',
      'version = "8"',
      '[workspace.dependencies]',
      'shared = "9"',
      '[features]',
      'not-one = ["a"]',
      '[patch.crates-io]',
      'nor-this = { git = "https://github.com/acme/x" }',
      '[target.x.other]',
      'nor-that = "1"',
    ].join('\n');
    assert.deepEqual(dependsOn(toml), [
      { name: 'plain', via: { kind: 'package', version: '1' } },
      { name: 'table', via: { kind: 'package', version: '2' } },
      { name: 'dotted', via: { kind: 'package', version: '3' } },
      { name: 'bare', via: { kind: 'package' } },
      { name: 'empty', via: { kind: 'package' } },
      { name: 'dev', via: { kind: 'package', version: '4' } },
      { name: 'build', via: { kind: 'package', version: '5' } },
      { name: 'unix', via: { kind: 'package', version: '6' } },
      { name: 'unix-dev', via: { kind: 'package', version: '7' } },
      { name: 'header', via: { kind: 'package', version: '8' } },
      { name: 'shared', via: { kind: 'package', version: '9' } },
    ]);
  });

  it("reads a git source with its ref, a path from the manifest's folder, and a renamed package", () => {
    const toml = [
      '[dependencies]',
      'a = { git = "https://github.com/acme/a", tag = "t" }',
      'b = { git = "https://github.com/acme/b", rev = "r" }',
      'c = { git = "https://github.com/acme/c", branch = "m" }',
      'd = { git = "https://github.com/acme/d" }',
      'e = { path = "../../../ladderlib", version = "1" }',
      'f = { path = "..\\\\sibling" }',
      'alias = { package = "real-name", version = "2" }',
    ].join('\n');
    assert.deepEqual(dependsOn(toml, 'crates/web/Cargo.toml'), [
      { name: 'a', via: { kind: 'git', url: 'https://github.com/acme/a', ref: 't' } },
      { name: 'b', via: { kind: 'git', url: 'https://github.com/acme/b', ref: 'r' } },
      { name: 'c', via: { kind: 'git', url: 'https://github.com/acme/c', ref: 'm' } },
      { name: 'd', via: { kind: 'git', url: 'https://github.com/acme/d' } },
      { name: 'e', via: { kind: 'project', path: '../ladderlib' } },
      { name: 'f', via: { kind: 'project', path: 'crates/sibling' } },
      { name: 'real-name', via: { kind: 'package', version: '2' } },
    ]);
  });

  it('a path out of the repository links the repository it names, and a renamed crate its publisher', () => {
    const library = {
      repo: 'acme/words',
      entry: entryOf([{ path: 'Cargo.toml', text: '[package]\nname = "real-name"\n' }], []),
    };
    const toml =
      '[dependencies]\ngreet = { path = "../ladderlib" }\nalias = { package = "real-name", version = "2" }\n';
    const app = { repo: 'acme/web', entry: entryOf([{ path: 'Cargo.toml', text: toml }], []) };
    assert.deepEqual(mapLines(app, [{ repo: 'acme/ladderlib' }, library, app]).slice(1), [
      'depends on `greet` from acme/ladderlib by project reference `../ladderlib` (Cargo)',
      'depends on `real-name` from acme/words by version `2` (Cargo)',
    ]);
  });

  it('gives one dependency once when two tables name it the same, and both when they differ', () => {
    const toml =
      '[dependencies]\ngreet = "1"\nwords = "1"\n[dev-dependencies]\ngreet = { version = "1", features = ["x"] }\nwords = "2"\n';
    assert.deepEqual(dependsOn(toml), [
      { name: 'greet', via: { kind: 'package', version: '1' } },
      { name: 'words', via: { kind: 'package', version: '1' } },
      { name: 'words', via: { kind: 'package', version: '2' } },
    ]);
  });

  it('a manifest without a package publishes nothing, and an inherited dependency gives no line', () => {
    assert.deepEqual(cargoManifest.read('Cargo.toml', '[workspace]\nmembers = ["a"]\n'), {
      kind: 'read',
      publishes: [],
      dependsOn: [],
    });
    assert.deepEqual(dependsOn('[dependencies.greet]\nworkspace = true\n'), []);
  });

  it('reads a real folder named target, and no vendored or built manifest', () => {
    for (const path of [
      'Cargo.toml',
      'crates/a/Cargo.toml',
      'crates/target/Cargo.toml',
      'target/Cargo.toml',
      'bin/tool/Cargo.toml',
      'obj/Cargo.toml',
      'vendored/Cargo.toml',
    ]) {
      assert.equal(cargoManifest.matches(path), true, path);
    }
    for (const path of [
      'vendor/x/Cargo.toml',
      'a/vendor/Cargo.toml',
      'node_modules/x/Cargo.toml',
      'target/package/x-1.0/Cargo.toml',
      'rust/target/debug/x/Cargo.toml',
      'cargo.toml',
      'NotCargo.toml',
      'Cargo.toml/README.md',
    ]) {
      assert.equal(cargoManifest.matches(path), false, path);
    }
  });
});
