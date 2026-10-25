// npm run demo (ADR 0097, ADR 0139), as the program: a scratch Brewery whose order is brewed with
// Nip through serve's Cellar, killed mid-attempt and started again, until the batch is on tap with
// one pull request and one status comment on the in-process code host; then a second order brewed
// by foedrum brew, and foedrum resume's line for the Cellarman's attempt. Real git and node, no
// gh, no claude.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { codeHost, fileJournal } from '../../scripts/demo/code-host.ts';
import {
  BREW_ORDER,
  BREWERY,
  CRASH_LINE,
  ON_TAP_LINE,
  ORDER,
  USER,
} from '../../scripts/demo/core.ts';
import { headingOf, LOST_LINE, STEPS, type Step } from '../../scripts/demo/walkthrough.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { execProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import type { Event } from '../../src/schemas/events.ts';
import { runGit } from '../../src/workspace/git.ts';
import { hangGuardMs } from '../helpers/load.ts';
import { NIP_SCRIPT } from '../helpers/nip-fixture.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const root = join(import.meta.dirname, '..', '..');
const demo = join(root, 'scripts', 'demo.ts');

describe('npm run demo', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('demo');
  });
  afterEach(() => removeTree(dir.path));

  it('brews one order with Nip through a crash and a restart, another with foedrum brew, on a machine with no git identity', async () => {
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
      // Only a guard against a hang (ADR 0075): two runs of the demo's recipe.
      timeoutMs: 10 * hangGuardMs,
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
    const part = (step: Step['id']): string => {
      const n = STEPS.findIndex(({ id }) => id === step);
      return result.stdout.slice(at[n], at[n + 1]);
    };
    // The first Cellar shows status as the batch moves, up to the Gauger's attempt the kill takes.
    assert.match(part('brewing'), /brewing +gauge #1 started/);
    // The restart shows that it found the lost attempt: lost, and brewed again.
    assert.match(
      part('restart'),
      /demo: the restart found gauge #1 lost \(the attempt was lost[^\n]*\); gauge #2 brews it again/,
    );
    assert.equal(result.stdout.split(LOST_LINE).length, 2, 'the lost attempt is said once');
    // The red proof reads the Gauger's test red, the first fix fails green, and the Cellarman's
    // second attempt is told why, with the failed test's own line.
    const checks = part('checks');
    assert.match(checks, /brewing +red #1 started/);
    assert.match(checks, /brewing +green #1 started.*brewing +implement #2 started/s);
    assert.match(
      checks,
      /demo: implement #2 is told why step implement runs again: the failed checks of step green\n +not ok \d+ - greets a stranger when no name is given/,
    );
    // The status comment is shown as its Markdown, without the hidden revision marker.
    assert.match(part('pull-request'), /On tap/);
    assert.ok(!result.stdout.includes('<!--'), result.stdout);
    // On tap: foedrum status shows the batch there, with its pull request.
    assert.match(
      part('on-tap'),
      /\$ foedrum status\n.*on tap +https:\/\/github\.com\/demo\/web\/pull\/\d+/s,
    );
    // foedrum brew orders the second issue, routes it by its label, and drives it to on tap.
    const brew = part('brew');
    assert.ok(brew.includes(`$ foedrum brew ${BREW_ORDER.number} --as ${USER}\n`), brew);
    assert.match(brew, /foedrum brew: ordered #2 as batch 2-1/);
    assert.match(brew, /foedrum brew: routed batch 2-1 to the recipe nip-parallel$/m);
    assert.match(
      brew,
      /foedrum brew: batch 2-1 is on tap: https:\/\/github\.com\/demo\/web\/pull\/\d+/,
    );
    // foedrum resume names the Cellarman's attempt and prints its line, opening nothing.
    assert.match(
      part('resume'),
      /\$ foedrum resume 1-1 implement#2\n[^$]*foedrum resume 1-1 implement#2/,
    );
    // replay shows the batch's events and the state the fold makes of them.
    const replay = part('replay');
    assert.match(replay, /Batch 1-1, issue/);
    assert.match(replay, /batch\.on_tap/);
    assert.match(replay, /lane +on tap/);

    // One pull request and one status comment per order, across both lives of the Cellar.
    const host = await codeHost(fileJournal(join(scratch, 'code-host.jsonl')));
    const pulls = host.pulls();
    assert.deepStrictEqual(
      pulls.map(({ title }) => title),
      [ORDER.title, BREW_ORDER.title],
    );
    for (const order of [ORDER, BREW_ORDER]) {
      const comments = host.comments(BREWERY, order.number);
      assert.equal(comments.length, 1, JSON.stringify(comments));
      // Its last revision shows the batch on tap, with the pull request.
      assert.match(comments[0]?.body ?? '', /On tap/);
    }
    assert.ok(
      host.comments(BREWERY, ORDER.number)[0]?.body.includes(`/demo/web/pull/${pulls[0]?.number}>`),
    );

    // Nip's steps in order: the Gauger's first attempt lost with the Cellar, its second brewed,
    // the red proof red, the first fix failing green, the second passing, and the pull request.
    const store = openSqliteEventStore(join(scratch, 'brewery', '.foedrum', 'index.db'));
    let events: Event[];
    try {
      events = store.eventsAfter(0).map(({ event }) => event);
    } finally {
      store.close();
    }
    const outcomes = events.flatMap((event) =>
      event.type === 'step.finished' && event.batchId === '1-1'
        ? [`${event.stepId}#${event.attempt} ${event.outcome.kind}`]
        : [],
    );
    // The three lens attempts run side by side, so they may end in any order.
    const lensOutcome = /^(?:correctness|security|test-design)#/;
    const firstLens = outcomes.findIndex((outcome) => lensOutcome.test(outcome));
    const inOrder = [
      ...outcomes.slice(0, firstLens),
      ...outcomes.slice(firstLens, firstLens + 3).sort(),
      ...outcomes.slice(firstLens + 3),
    ];
    assert.deepStrictEqual(inOrder, [
      'gauge#1 failed',
      'gauge#2 succeeded',
      'red#1 succeeded',
      'implement#1 succeeded',
      'fine#1 succeeded',
      'green#1 failed',
      'implement#2 succeeded',
      'fine#2 succeeded',
      'green#2 succeeded',
      ...['correctness', 'security', 'test-design'].map((lens) => `${lens}#1 succeeded`),
      'open-pull-request#1 succeeded',
    ]);
    // The parallel group's three lens attempts all started before any of them ended (ADR 0168).
    const lenses = new Set(['correctness', 'security', 'test-design']);
    const group = events.flatMap((event) =>
      (event.type === 'step.started' || event.type === 'step.finished') &&
      event.batchId === '1-1' &&
      lenses.has(event.stepId)
        ? [event.type]
        : [],
    );
    assert.deepStrictEqual(group.slice(0, 3), ['step.started', 'step.started', 'step.started']);
    assert.equal(group.length, 6, JSON.stringify(group));
    // While they brewed, foedrum status showed the three of them at once.
    assert.match(
      part('checks'),
      /brewing +correctness #1 started, security #1 started, test-design #1 started/,
    );
    // The status comment's path line has the three side by side, and each one's findings show
    // under its own step.
    const comment = host.comments(BREWERY, ORDER.number)[0]?.body ?? '';
    assert.match(comment, /Recipe \*\*nip-parallel\*\*/);
    assert.match(
      comment,
      /`green #2` ✅ → `correctness #1` ✅ → `security #1` ✅ → `test-design #1` ✅ → `open-pull-request #1` ✅/,
    );
    for (const lens of lenses) assert.match(comment, new RegExp(`^- \`${lens}\`: minor in `, 'm'));
    assert.ok(
      events.some((event) => event.type === 'batch.on_tap' && event.batchId === '2-1'),
      JSON.stringify(events),
    );

    // The Cellarman's second fix is the tip of the bottle branch on the target's remote.
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
    assert.equal(log.stdout.trim(), NIP_SCRIPT.implement?.[1]?.message);
  });
});
