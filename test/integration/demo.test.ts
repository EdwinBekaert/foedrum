// npm run demo (ADR 0097), as the program: a scratch Brewery whose one order is brewed through
// serve's Cellar, killed mid-attempt and started again, until the batch is on tap with one pull
// request and one status comment on the in-process code host. Real git and node, no gh, no claude.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { codeHost, fileJournal } from '../../scripts/demo/code-host.ts';
import { BREWERY, CRASH_LINE, ON_TAP_LINE, ORDER } from '../../scripts/demo/core.ts';
import { headingOf, STEPS } from '../../scripts/demo/walkthrough.ts';
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

  it('takes one order from Ordered to On tap through a crash and a restart, on a machine with no git identity', async () => {
    const scratch = join(dir.path, 'demo');
    // A machine with no git identity of its own, as a CI runner or a fresh clone has: no system
    // configuration, and a global one of the test's own that only stops git from guessing an
    // identity from the user and host names, which it would on a host whose name has a dot.
    const noIdentity = join(dir.path, 'gitconfig');
    writeFileSync(noIdentity, '[user]\n\tuseConfigOnly = true\n');
    // Nor any identity or configuration the host's environment would give git.
    const hostGit =
      /^(?:GIT_AUTHOR_|GIT_COMMITTER_|EMAIL$|GIT_CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS))/i;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !hostGit.test(name)),
    );
    const result = await execProcess(process.execPath, [demo, '--in', scratch, '--no-pause'], {
      cwd: root,
      env: { ...env, GIT_CONFIG_GLOBAL: noIdentity, GIT_CONFIG_NOSYSTEM: '1' },
      // Only a guard against a hang (ADR 0075).
      timeoutMs: hangGuardMs,
    });
    assert.equal(result.exitCode, 0, result.output);
    assert.ok(result.stdout.includes(CRASH_LINE), result.output);
    assert.ok(result.stdout.includes(ON_TAP_LINE), result.output);

    // The walkthrough's steps, in order, with no pause between them.
    const at = STEPS.map((_, index) => result.stdout.indexOf(headingOf(index)));
    assert.ok(
      at.every((where, n) => where >= 0 && where > (at[n - 1] ?? -1)),
      `headings at ${at.join(', ')}:\n${result.stdout}`,
    );
    // The first Cellar shows status as the batch moves, up to the attempt the kill takes.
    assert.match(result.stdout.slice(at[2], at[3]), /brewing +brew #1 started/);
    // The restart shows that it found the lost attempt: lost, and brewed again.
    const restart = result.stdout.slice(at[3], at[4]);
    assert.match(
      restart,
      /demo: the restart found brew #1 lost \(the attempt was lost[^\n]*\); brew #2 brews it again/,
    );
    assert.match(restart, /brewing +brew #2 started/);
    // The status comment is shown as its Markdown, without the hidden revision marker.
    const pullStep = result.stdout.slice(at[4], at[5]);
    assert.match(pullStep, /On tap/);
    assert.ok(!result.stdout.includes('<!--'), result.stdout);
    // On tap: foedrum status shows the batch there, with its pull request.
    assert.match(
      result.stdout.slice(at[5], at[6]),
      /\$ foedrum status\n.*on tap +https:\/\/github\.com\/demo\/web\/pull\/\d+/s,
    );
    // replay shows the batch's events and the state the fold makes of them.
    const replay = result.stdout.slice(at[6]);
    assert.match(replay, /Batch 1-1, issue/);
    assert.match(replay, /batch\.on_tap/);
    assert.match(replay, /lane +on tap/);

    // Exactly one pull request and one status comment, across both lives of the Cellar.
    const host = await codeHost(fileJournal(join(scratch, 'code-host.jsonl')));
    const pulls = host.pulls();
    assert.equal(pulls.length, 1, JSON.stringify(pulls));
    assert.equal(pulls[0]?.title, ORDER.title);
    const comments = host.comments(BREWERY, ORDER.number);
    assert.equal(comments.length, 1);
    // Its last revision shows the batch on tap, with the pull request.
    assert.match(comments[0]?.body ?? '', /On tap/);
    assert.ok(comments[0]?.body.includes(`/demo/web/pull/${pulls[0]?.number}>`), comments[0]?.body);

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
