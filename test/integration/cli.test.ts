// `foedrum status` and `replay` as the real program, against real store files (ADR 0021): what
// main.ts wires in that the unit tests replace. The output itself is in test/unit/cli.test.ts.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
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

  it('refuses a store at an older schema version in one line, and leaves it as it was', async () => {
    mkdirSync(join(brewery.path, '.foedrum'));
    const writer = openSqliteEventStore(store);
    writer.withTransaction((tx) =>
      tx.append({ type: 'batch.ordered', batchId: '12-1', order: { issue: 12 } }),
    );
    writer.close();
    const db = new DatabaseSync(store);
    // What schema version 1 left: no pushed table. An older Cellar may still run on it.
    db.exec('PRAGMA journal_mode = DELETE; DROP TABLE pushed; PRAGMA user_version = 1');
    db.close();
    const { exitCode, stdout, stderr } = await foedrum('status');
    assert.equal(exitCode, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /^foedrum: [^\n]*schema version 1[^\n]*\n$/);
    const after = new DatabaseSync(store, { readOnly: true });
    assert.deepEqual(
      {
        ...after.prepare('PRAGMA user_version').get(),
        ...after.prepare('PRAGMA journal_mode').get(),
      },
      { user_version: 1, journal_mode: 'delete' },
    );
    after.close();
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
