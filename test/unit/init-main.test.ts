// `foedrum init` on a clone (init-main.ts), the wiring main.ts runs, with a fake process runner, a
// fake PATH and answers piped in: the files land in the clone, GitHub is read through gh, and
// doctor runs there (ADR 0021, ADR 0199).

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { initFromCheckout } from '../../src/cli/init-main.ts';
import type { ExecProcess } from '../../src/platform/processes.ts';
import { BreweryConfig } from '../../src/schemas/brewery-config.ts';
import { readJsonc } from '../../src/schemas/read.ts';
import { fakeFetch } from '../helpers/fake-fetch.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const base64 = (text: string) => Buffer.from(text).toString('base64');

describe('initFromCheckout', () => {
  const dir = makeTempDir('init-main');
  after(() => dir.remove());
  mkdirSync(join(dir.path, '.git'));

  it('asks on the terminal, reads GitHub through gh, writes the files in the clone and runs doctor', async () => {
    const github = fakeFetch([
      { status: 200, body: { login: 'octocat' } },
      { status: 200, body: { default_branch: 'trunk' } },
      {
        status: 200,
        body: { encoding: 'base64', content: base64('{ "scripts": { "test": "node --test" } }') },
      },
      { status: 404, body: { message: 'Not Found' } },
    ]);
    const gh = ghOver(github.fetch);
    const tools: string[] = [];
    // gh api through the fake GitHub; doctor's tools answer a version.
    const exec: ExecProcess = async (file, args, options) => {
      if (args[0] === 'api') return gh.exec(file, args, options);
      tools.push(`${file} ${args.join(' ')}`);
      return { exitCode: 0, stdout: '1.0.0\n', stderr: '', output: '1.0.0\n' };
    };
    let shown = '';
    const result = await initFromCheckout(dir.path, {
      exec,
      resolve: (name) => `/usr/bin/${name}`,
      // Never the user's own list (ADR 0114).
      denylist: () => ({ kind: 'none', path: '/made-up/denylist.txt' }),
      terminal: {
        input: Readable.from(['\n', 'acme/web\n', '\n']),
        output: {
          write: (text: string) => {
            shown += text;
          },
        },
      },
    });
    assert.ok(shown.includes('Brewery repository (owner/name) [octocat/foedrum-brewery]: '), shown);
    assert.ok(shown.includes('Read acme/web: base trunk, checks from package.json\n'), shown);
    assert.ok(shown.includes('Wrote foedrum.jsonc\n'), shown);
    const config = readJsonc(readFileSync(join(dir.path, 'foedrum.jsonc'), 'utf8'), BreweryConfig);
    assert.ok(config.valid);
    assert.equal(config.value.repositories['acme/web']?.checks.test, 'npm test');
    assert.equal(readFileSync(join(dir.path, '.gitignore'), 'utf8'), '.foedrum/\n');
    assert.match(
      readFileSync(join(dir.path, '.claude', 'settings.json'), 'utf8'),
      /"foedrum@foedrum": true/,
    );
    // doctor ran in the clone, through the same runner.
    assert.ok(tools.length > 0);
    assert.ok(shown.includes('claude plugin install foedrum@foedrum --scope project\n'), shown);
    assert.equal(result.stderr, '');
  });
});
