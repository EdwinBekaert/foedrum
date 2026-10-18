// `foedrum doctor` on the real machine (ADR 0021): the facts main.ts gathers (doctorFromCheckout)
// find the tools through PATH and read their versions through the process runner (npm.cmd through
// cmd.exe on Windows). What a machine has differs, so this checks the report's structure only; the
// report itself is in test/unit/cli.test.ts. gh's login check gets a canned answer, logged in to a
// made-up host only (canned-gh-login.ts): no test asks the real gh for a login (ADR 0073).

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { execProcess } from '../../src/platform/processes.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';
import { cannedGhLogin, doctorHere, MADE_UP_CONFIG, MADE_UP_HOST } from './canned-gh-login.ts';

const VERSION = String.raw`\d+(?:\.\d+)+`;

describe('foedrum doctor on this machine', () => {
  it('reports each tool, the isolation level and an exit code that matches', async () => {
    const dir = makeTempDir('doctor-machine');
    writeFileSync(join(dir.path, 'foedrum.jsonc'), MADE_UP_CONFIG);
    const { exitCode, stdout } = await doctorHere(dir.path).finally(() => dir.remove());
    const lines = stdout.split('\n');
    assert.equal(lines[0], 'Foedrum doctor');
    const row = (name: string): string | undefined =>
      lines.find((line) => line.startsWith(`  ${name} `));
    assert.match(row('node') ?? '', new RegExp(`^  node +${VERSION}$`));
    // CI has npm, git and gh everywhere; npm is npm.cmd on Windows.
    assert.match(row('npm') ?? '', new RegExp(`^  npm +${VERSION} +\\S`));
    assert.match(row('git') ?? '', new RegExp(`^  git +${VERSION} +\\S`));
    const inCi = process.env.CI !== undefined && process.env.CI !== '';
    assert.match(
      row('gh') ?? '',
      new RegExp(`^  gh +(?:${inCi ? '' : 'missing|'}${VERSION} +\\S.*)$`),
    );
    // foedrum.jsonc names the made-up host, whose canned answer is logged in: doctor names no
    // login to make where gh is there.
    if (!/ missing$/.test(row('gh') ?? '')) {
      assert.ok(!lines.some((line) => line.includes('gh auth login')), stdout);
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
      const { exitCode, stdout } = await doctorHere(dir.path);
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

// doctor reads git's own credential settings (ADR 0073): the format the unit tests' fixtures stand
// in for, from the real git, with a global configuration of the test's own and no system one.
// These are about git, so gh's version is canned as well as its login.
describe("foedrum doctor and git's credential helper", () => {
  const advice = async (helpers: string[]): Promise<string[]> => {
    const dir = makeTempDir('doctor-credentials');
    try {
      const global = join(dir.path, 'gitconfig');
      const lines = helpers.map((helper) => `\thelper = ${helper}\n`).join('');
      writeFileSync(global, `[credential "https://${MADE_UP_HOST}"]\n${lines}`);
      writeFileSync(join(dir.path, 'foedrum.jsonc'), MADE_UP_CONFIG);
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: global,
        GIT_CONFIG_NOSYSTEM: '1',
        // The folder is inside Foedrum's own checkout: git must not read its local settings.
        GIT_CEILING_DIRECTORIES: dirname(dir.path),
      };
      const { stdout } = await doctorHere(
        dir.path,
        cannedGhLogin(
          (file, args, options) => execProcess(file, args, { ...options, env }),
          'gh version 2.102.0 (2026-09-30)\n',
        ),
      );
      return stdout
        .split('\n')
        .filter((line) => /credential helper|credentials, not gh/.test(line));
    } finally {
      dir.remove();
    }
  };

  it('is content with the helper gh auth setup-git writes', async () => {
    assert.deepEqual(await advice(['', '!gh auth git-credential']), []);
  });

  it('names the helper git asks first when it is not gh, and when there is none', async () => {
    const fix = `run gh auth setup-git --hostname ${MADE_UP_HOST}, so git pushes with gh's login`;
    assert.deepEqual(await advice(['store', '!gh auth git-credential']), [
      `  git asks store for https://${MADE_UP_HOST} credentials, not gh: ${fix}`,
    ]);
    assert.deepEqual(await advice([]), [
      `  git has no credential helper for https://${MADE_UP_HOST}: ${fix}`,
    ]);
  });
});
