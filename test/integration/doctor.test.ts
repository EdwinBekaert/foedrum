// `foedrum doctor` on the real machine (ADR 0021): the program starts, finds the tools through
// PATH and reads their versions through the process runner (npm.cmd through cmd.exe on Windows).
// What a machine has differs, so this checks the report's structure only; the report itself is
// in test/unit/cli.test.ts. gh runs with an empty configuration of its own, so it has no login
// to check against github.com (ADR 0073).

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execProcess } from '../../src/platform/processes.ts';
import { envWithoutGhLogin } from '../helpers/gh-config.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const main = join(import.meta.dirname, '..', '..', 'src', 'cli', 'main.ts');
const VERSION = String.raw`\d+(?:\.\d+)+`;

describe('foedrum doctor on this machine', () => {
  it('reports each tool, the isolation level and an exit code that matches', async () => {
    const config = makeTempDir('doctor-gh');
    const { exitCode, stdout, stderr } = await execProcess(process.execPath, [main, 'doctor'], {
      cwd: import.meta.dirname,
      env: envWithoutGhLogin(config.path),
      timeoutMs: 60_000,
    }).finally(() => config.remove());
    assert.equal(stderr, '');
    const lines = stdout.split('\n');
    assert.equal(lines[0], 'Foedrum doctor');
    const row = (name: string): string | undefined =>
      lines.find((line) => line.startsWith(`  ${name} `));
    assert.match(row('node') ?? '', new RegExp(`^  node +${VERSION}$`));
    // CI has npm and git everywhere; npm is npm.cmd on Windows.
    assert.match(row('npm') ?? '', new RegExp(`^  npm +${VERSION} +\\S`));
    assert.match(row('git') ?? '', new RegExp(`^  git +${VERSION} +\\S`));
    // CI has gh everywhere too; here it has no login, which is a required problem.
    assert.match(row('gh') ?? '', new RegExp(`^  gh +(?:missing|${VERSION} +\\S.*)$`));
    if (!/ missing$/.test(row('gh') ?? '')) {
      assert.ok(
        lines.includes(
          '  gh is not logged in to github.com (required): run gh auth login --hostname github.com',
        ),
        stdout,
      );
    }
    assert.match(row('claude') ?? '', new RegExp(`^  claude +(?:missing|${VERSION} +\\S.*)$`));
    const linux = process.platform === 'linux';
    assert.equal(row('bwrap') !== undefined, linux);
    assert.equal(row('socat') !== undefined, linux);
    // Where the machine has them, the parser reads a version from what they really print.
    for (const name of ['bwrap', 'socat']) {
      const line = row(name);
      if (line !== undefined && !/ missing$/.test(line)) {
        assert.match(line, new RegExp(`^  ${name} +${VERSION} +\\S`));
      }
    }
    const container = lines.find((line) => line.startsWith('Container: '));
    // A container runtime may be there without answering (docker.exe on the Windows runner, #99),
    // but one that printed a version must have it read.
    if (container !== undefined && !container.startsWith('Container: no ')) {
      assert.match(
        container,
        new RegExp(
          `^Container: (?:podman|docker) (?:${VERSION} at \\S.*; the container level is available|at \\S.* does not answer its version.*; the container level is not available)$`,
        ),
      );
      if (container.includes(' does not answer its version')) {
        assert.doesNotMatch(container, new RegExp(`its version \\(.*${VERSION}`));
      }
    }
    const isolation = lines.find((line) => line.startsWith('Isolation: '));
    const expected = { win32: 'permissions only', darwin: 'sandboxed' }[process.platform as string];
    assert.match(isolation ?? '', /^Isolation: (?:sandboxed|permissions only) \(.+\)$/);
    if (expected !== undefined) assert.ok(isolation?.startsWith(`Isolation: ${expected} (`));
    assert.ok(lines.some((line) => line.startsWith('Container: ')));
    const required = lines.some((line) => / \(required\): /.test(line));
    assert.equal(exitCode, required ? 1 : 0);
  });
});

describe('foedrum doctor in a Brewery', () => {
  it('reads foedrum.jsonc in the working directory and refuses two repositories with one alias', async () => {
    const dir = makeTempDir('doctor-config');
    try {
      const checks = { build: null, typecheck: null, lint: null, format: null, test: null };
      const config = {
        repositories: {
          'acme/web': { checks, alias: 'app' },
          'acme/api': { checks, alias: 'app' },
        },
      };
      writeFileSync(join(dir.path, 'foedrum.jsonc'), JSON.stringify(config));
      const { exitCode, stdout } = await execProcess(process.execPath, [main, 'doctor'], {
        cwd: dir.path,
        env: envWithoutGhLogin(dir.path),
        timeoutMs: 60_000,
      });
      assert.equal(exitCode, 1);
      assert.match(
        stdout,
        /^ {2}foedrum\.jsonc is not valid \(required\): .*The alias app is already the alias of acme\/web/m,
      );
    } finally {
      dir.remove();
    }
  });
});
