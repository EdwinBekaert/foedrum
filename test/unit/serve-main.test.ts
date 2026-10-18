// `foedrum serve` from a checkout (serve-main.ts) with a fake process runner and a fake PATH: the
// facts it gathers at its start, gh's login among them, come through the runner it is given, so no
// test asks the real gh for a login (ADR 0021, ADR 0073).

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { serveFromCheckout } from '../../src/cli/serve-main.ts';
import type { ExecProcess, ExecResult } from '../../src/platform/processes.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const answer = (stdout: string, exitCode = 0, stderr = ''): ExecResult => ({
  exitCode,
  stdout,
  stderr,
  output: `${stdout}${stderr}`,
});

// What each program answers: its version, gh's login check as gh 2.102.0 prints a missing login,
// and git's credential listing with nothing in it.
const fakeRunner = () => {
  const calls: { file: string; args: readonly string[] }[] = [];
  const exec: ExecProcess = async (file, args) => {
    calls.push({ file, args });
    if (args[0] === 'auth') {
      return answer(
        '',
        1,
        'You are not logged into any GitHub hosts. To log in, run: gh auth login\n',
      );
    }
    if (args[0] === 'config') return answer('', 1);
    if (file.endsWith('gh')) return answer('gh version 2.102.0 (2026-09-30)\n');
    return answer(`${file} version 2.56.0\n`);
  };
  return { exec, calls };
};

describe('serveFromCheckout', () => {
  const dir = makeTempDir('serve-main');
  const ghe = makeTempDir('serve-main-ghe');
  after(() => {
    dir.remove();
    ghe.remove();
  });

  it('asks gh about the host its own foedrum.jsonc names', async () => {
    writeFileSync(
      join(ghe.path, 'foedrum.jsonc'),
      '{ "repositories": {}, "githubApi": "https://ghe.example/api/v3" }',
    );
    const { exec, calls } = fakeRunner();
    const result = await serveFromCheckout(ghe.path, {
      exec,
      resolve: (name) => `/usr/bin/${name}`,
    });
    assert.ok(
      result.stderr
        .split('\n')
        .includes(
          'foedrum serve: gh is not logged in to ghe.example: run gh auth login --hostname ghe.example',
        ),
      result.stderr,
    );
    assert.ok(calls.some(({ args }) => args.join(' ') === 'auth status --hostname ghe.example'));
  });

  it('asks gh for its login through the runner it is given, and refuses without one', async () => {
    const { exec, calls } = fakeRunner();
    const result = await serveFromCheckout(dir.path, {
      exec,
      resolve: (name) => `/usr/bin/${name}`,
    });
    assert.equal(result.exitCode, 1);
    assert.ok(
      result.stderr
        .split('\n')
        .includes(
          'foedrum serve: gh is not logged in to github.com: run gh auth login --hostname github.com',
        ),
      result.stderr,
    );
    assert.ok(
      calls.some(
        ({ file, args }) =>
          file === '/usr/bin/gh' && args.join(' ') === 'auth status --hostname github.com',
      ),
    );
  });
});
