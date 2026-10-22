// `foedrum doctor`'s facts from a checkout (doctor-main.ts), the wiring main.ts runs, with a fake
// process runner and a fake PATH: the checkout's foedrum.jsonc and recipe files are read, and gh is
// asked about the host foedrum.jsonc names through the runner it is given (ADR 0021, ADR 0073).

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { doctorFromCheckout } from '../../src/cli/doctor-main.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const fakeRunner = () => {
  const calls: { file: string; args: readonly string[] }[] = [];
  const exec: ExecProcess = async (file, args) => {
    calls.push({ file, args });
    const output = args[0] === 'auth' ? 'ghe.example\n  ✓ Logged in to ghe.example\n' : '1.0.0\n';
    return { exitCode: 0, stdout: output, stderr: '', output };
  };
  return { exec, calls };
};

describe('doctorFromCheckout', () => {
  const dir = makeTempDir('doctor-main');
  after(() => dir.remove());
  const config = '{ "repositories": {}, "githubApi": "https://ghe.example/api/v3" }';
  writeFileSync(join(dir.path, 'foedrum.jsonc'), config);
  mkdirSync(join(dir.path, 'recipes'));
  writeFileSync(join(dir.path, 'recipes', 'pale.jsonc'), '{}');

  it("reads the checkout's files, and asks gh about their host through the runner it is given", async () => {
    const { exec, calls } = fakeRunner();
    const facts = await doctorFromCheckout(dir.path, {
      exec,
      resolve: (name) => `/usr/bin/${name}`,
      // Never the user's own list (ADR 0114).
      denylist: () => ({ kind: 'none', path: '/made-up/denylist.txt' }),
    });
    assert.equal(facts.config, config);
    assert.deepEqual(
      facts.brewery?.recipes.map(({ path }) => path),
      ['recipes/pale.jsonc'],
    );
    assert.equal(facts.github?.host, 'ghe.example');
    assert.ok(
      calls.some(
        ({ file, args }) =>
          file === '/usr/bin/gh' && args.join(' ') === 'auth status --hostname ghe.example',
      ),
    );
  });
});
