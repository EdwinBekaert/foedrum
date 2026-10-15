// `foedrum status` and `replay` as the real program, against real store files (ADR 0021): what
// main.ts wires in that the unit tests replace. The output itself is in test/unit/cli.test.ts.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { execProcess } from '../../src/platform/processes.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const main = join(import.meta.dirname, '..', '..', 'src', 'cli', 'main.ts');

describe('foedrum status and replay on store files', () => {
  let brewery: TempDir;
  let store: string;
  beforeEach(() => {
    brewery = makeTempDir('cli');
    store = join(brewery.path, '.foedrum', 'index.db');
  });
  afterEach(() => brewery.remove());

  const foedrum = (...args: string[]) =>
    execProcess(process.execPath, [main, ...args], { cwd: brewery.path, timeoutMs: 60_000 });

  it('says there is no store, and creates none, in a folder without one', async () => {
    for (const args of [['status'], ['replay', '12-1']]) {
      const { exitCode, stdout, stderr } = await foedrum(...args);
      assert.equal(exitCode, 1);
      assert.equal(stdout, '');
      assert.equal(stderr, `foedrum ${args[0]}: no event store at ${store}\n`);
      assert.equal(existsSync(store), false);
    }
  });

  it('says in one line, and exits 1, when the store is not a database', async () => {
    mkdirSync(join(brewery.path, '.foedrum'));
    writeFileSync(store, 'not a database, but long enough to have a header page\n'.repeat(10));
    const { exitCode, stdout, stderr } = await foedrum('status');
    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /^foedrum: [^\n]+\n$/);
  });
});
