// npm run demo (ADR 0097), as the program: a scratch Brewery whose one order is brewed through
// serve's Cellar, killed mid-attempt and started again, until the batch is on tap with one pull
// request and one status comment on the in-process code host. Real git and node, no gh, no claude.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { codeHost, fileJournal } from '../../scripts/demo/code-host.ts';
import { BREWERY, CRASH_LINE, ON_TAP_LINE, ORDER } from '../../scripts/demo/core.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { execProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { runGit } from '../../src/workspace/git.ts';
import { hangGuardMs } from '../helpers/load.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const root = join(import.meta.dirname, '..', '..');
const demo = join(root, 'scripts', 'demo.ts');

describe('npm run demo', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('demo');
  });
  afterEach(() => removeTree(dir.path));

  it('takes one order from Ordered to On tap through a crash and a restart', async () => {
    const scratch = join(dir.path, 'demo');
    const result = await execProcess(process.execPath, [demo, '--in', scratch], {
      cwd: root,
      // Only a guard against a hang (ADR 0075).
      timeoutMs: hangGuardMs,
    });
    assert.equal(result.exitCode, 0, result.output);
    assert.ok(result.stdout.includes(CRASH_LINE), result.output);
    assert.ok(result.stdout.includes(ON_TAP_LINE), result.output);

    // Exactly one pull request and one status comment, across both lives of the Cellar.
    const host = await codeHost(fileJournal(join(scratch, 'code-host.jsonl')));
    const pulls = host.pulls();
    assert.equal(pulls.length, 1, JSON.stringify(pulls));
    assert.equal(pulls[0]?.title, ORDER.title);
    assert.equal(host.comments(BREWERY, ORDER.number).length, 1);

    // The first attempt was lost with the Cellar, the second one brewed, and the batch is on tap.
    const store = openSqliteEventStore(join(scratch, 'brewery', '.foedrum', 'index.db'));
    let events: { type: string; attempt?: number; outcome?: { kind: string; reason?: string } }[];
    try {
      events = store.eventsAfter(0).map(({ event }) => event as (typeof events)[number]);
    } finally {
      store.close();
    }
    const brews = events.filter((event) => event.type === 'step.finished');
    assert.match(brews[0]?.outcome?.reason ?? '', /the attempt was lost/, JSON.stringify(brews));
    assert.deepStrictEqual(
      brews.slice(1).map(({ attempt, outcome }) => [attempt, outcome?.kind]),
      [
        [2, 'succeeded'],
        [1, 'succeeded'],
      ],
    );
    assert.ok(
      events.some((event) => event.type === 'batch.on_tap'),
      JSON.stringify(events),
    );

    // The brewer's commit is on the bottle branch of the target repository's remote.
    const head = pulls[0]?.head ?? '';
    const log = await runGit(root, [
      '--git-dir',
      join(scratch, 'web.git'),
      'log',
      '-1',
      '--format=%s',
      head,
    ]);
    assert.equal(log.code, 0, log.stderr);
    assert.match(log.stdout, /greeting/i);
  });
});
