// `foedrum doctor`'s system map (ADR 0317): each repository read in its clone at its base with fake
// git, and the report that shows it whole, with the commit it was read at.

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { diagnose, formatDiagnosis } from '../../src/cli/doctor.ts';
import { readDoctorMap } from '../../src/cli/doctor-map.ts';
import { linux } from '../helpers/doctor-facts.ts';

const cwd = join('/brewery');
const home = join('/home', 'ann');
const libClone = resolve('/clones', 'ladderlib');
const appClone = resolve('/clones', 'ladderapp');
const tip = 'e'.repeat(40);

const checks = { build: null, typecheck: null, lint: null, format: null, test: null };

const files: Record<string, string> = {
  [join(cwd, 'foedrum.jsonc')]: JSON.stringify({
    brewery: 'acme/brewery',
    repositories: {
      'acme/ladderlib': {
        checks,
        description: 'the greet library; tags a release on every merge',
      },
      'acme/ladderapp': { checks },
      'acme/docs': { checks, source: 'managed' },
    },
  }),
  [join(cwd, '.foedrum', 'local.jsonc')]: JSON.stringify({
    clones: { 'acme/ladderlib': libClone, 'acme/ladderapp': appClone },
  }),
};

const manifests: Record<string, string> = {
  [libClone]: JSON.stringify({ name: '@demo/greet', version: '1.0.0' }),
  [appClone]: JSON.stringify({
    name: 'web',
    private: true,
    dependencies: { '@demo/greet': '1.0.0' },
  }),
};

const git = async (cwd: string, args: readonly string[]) => {
  if (args[0] === 'rev-parse') return { code: 0, stdout: `${tip}\n`, stderr: '' };
  if (args[0] === 'ls-tree' && args.includes('--name-only')) {
    return { code: 0, stdout: 'package.json\0', stderr: '' };
  }
  // The test map: none at the base.
  if (args[0] === 'ls-tree') return { code: 0, stdout: '', stderr: '' };
  return { code: 0, stdout: manifests[cwd] ?? '', stderr: '' };
};

describe('foedrum doctor: the system map (ADR 0317)', () => {
  it('foedrum doctor shows the system map', async () => {
    const systemMap = await readDoctorMap({
      git,
      home,
      cwd,
      readFile: (path) => files[path],
      exists: (path) => path === libClone || path === appClone,
    });
    const report = formatDiagnosis(diagnose({ ...linux(), systemMap }));
    const shown = report.slice(report.indexOf('System map'));
    assert.match(
      shown,
      /^System map \(the planners' repositories input\):\n- acme\/ladderlib, base origin\/main at e{12}\n {2}the greet library; tags a release on every merge\n {2}manifests: package\.json \(npm\)\n {2}publishes `@demo\/greet` \(npm\)\n- acme\/ladderapp, base origin\/main at e{12}\n {2}manifests: package\.json \(npm\)\n {2}publishes `web` \(npm\)\n {2}depends on `@demo\/greet` from acme\/ladderlib by version `1\.0\.0` \(npm\)\n- acme\/docs, base origin\/main: not read, it has no clone here yet\n\n/,
    );
    assert.doesNotMatch(formatDiagnosis(diagnose(linux())), /System map/);
  });

  it('foedrum doctor names the link of a Rust library and its user, and of a Go module and its user', async () => {
    const clones = ['rustlib', 'rustapp', 'golib', 'goapp'];
    const manifest: Record<string, { path: string; text: string }> = {
      rustlib: { path: 'Cargo.toml', text: '[package]\nname = "greet"\n' },
      rustapp: {
        path: 'Cargo.toml',
        text: '[package]\nname = "greeter"\n[dependencies]\ngreet = { git = "https://github.com/acme/rustlib", tag = "v1.1.0" }\n',
      },
      golib: { path: 'go.mod', text: 'module github.com/acme/golib\n' },
      goapp: {
        path: 'go.mod',
        text: 'module github.com/acme/goapp\nrequire github.com/acme/golib v1.2.0\n',
      },
    };
    const at = (name: string) => resolve('/clones', name);
    const breweryFiles: Record<string, string> = {
      [join(cwd, 'foedrum.jsonc')]: JSON.stringify({
        brewery: 'acme/brewery',
        repositories: Object.fromEntries(clones.map((name) => [`acme/${name}`, { checks }])),
      }),
      [join(cwd, '.foedrum', 'local.jsonc')]: JSON.stringify({
        clones: Object.fromEntries(clones.map((name) => [`acme/${name}`, at(name)])),
      }),
    };
    const fourGit = async (clone: string, args: readonly string[]) => {
      const own = manifest[clones.find((name) => at(name) === clone) ?? ''];
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${tip}\n`, stderr: '' };
      if (args[0] === 'ls-tree') {
        const listing = args.includes('--name-only') ? `${own?.path}\0` : '';
        return { code: 0, stdout: listing, stderr: '' };
      }
      return { code: 0, stdout: own?.text ?? '', stderr: '' };
    };
    const systemMap = await readDoctorMap({
      git: fourGit,
      home,
      cwd,
      readFile: (path) => breweryFiles[path],
      exists: () => true,
    });
    const report = formatDiagnosis(diagnose({ ...linux(), systemMap }));
    const shown = report.slice(report.indexOf('System map')).split('\n');
    for (const line of [
      '  publishes `greet` (Cargo)',
      '  depends on `greet` from acme/rustlib by git ref `v1.1.0` (Cargo)',
      '  publishes `github.com/acme/golib` (Go)',
      '  depends on `github.com/acme/golib` from acme/golib by version `v1.2.0` (Go)',
    ]) {
      assert.ok(shown.includes(line), `${line}\n${shown.join('\n')}`);
    }
  });

  it("says why git could not resolve a clone's base, and reads the other clones when git throws", async () => {
    const failing = async (at: string, args: readonly string[]) => {
      if (at === libClone && args[0] === 'rev-parse') {
        return {
          code: null,
          stdout: '',
          stderr: 'git timed out after 10000 ms',
          killed: 'timed-out' as const,
        };
      }
      if (at === appClone) throw new Error('git could not start');
      return git(at, args);
    };
    const read = await readDoctorMap({
      git: failing,
      home,
      cwd,
      readFile: (path) => files[path],
      exists: (path) => path === libClone || path === appClone,
    }).then(
      (systemMap) =>
        systemMap.map(({ repo, read }) => [repo, 'unread' in read ? read.unread : 'read']),
      (error: unknown) => [['the map', String(error)]],
    );
    assert.deepEqual(read, [
      ['acme/ladderlib', 'git could not resolve origin/main: git timed out after 10000 ms'],
      ['acme/ladderapp', 'git could not start'],
      ['acme/docs', 'it has no clone here yet'],
    ]);
  });

  it("says why a clone's base or files could not be read (regression test)", async () => {
    const failing = async (at: string, args: readonly string[]) => {
      if (at === libClone && args[0] === 'rev-parse') {
        return { code: 128, stdout: '', stderr: 'fatal: Needed a single revision\n' };
      }
      if (at === appClone && args[0] === 'ls-tree') {
        return { code: 128, stdout: '', stderr: 'fatal: not a tree object\n' };
      }
      return git(at, args);
    };
    const systemMap = await readDoctorMap({
      git: failing,
      home,
      cwd,
      readFile: (path) => files[path],
      exists: (path) => path === libClone || path === appClone,
    });
    assert.deepEqual(
      systemMap.map(({ repo, read }) => [repo, 'unread' in read ? read.unread : 'read']),
      [
        ['acme/ladderlib', 'its clone has no origin/main'],
        ['acme/ladderapp', `git could not list ${tip}: fatal: not a tree object`],
        ['acme/docs', 'it has no clone here yet'],
      ],
    );
  });
});
