// npm run demo (ADR 0097, ADR 0139), as the program: a scratch Brewery whose order is brewed with
// Nip through serve's Cellar, killed mid-attempt and started again, until the batch is on tap with
// one pull request and one status comment on the in-process code host; then a second order brewed
// by foedrum brew, foedrum resume's line for the Cellarman's attempt, and a third order mashed to a
// plan that waits Stuck for its review. Real git and node, no gh, no claude.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEMO_SCRIPT } from '../../scripts/demo/brewer.ts';
import { codeHost, fileJournal } from '../../scripts/demo/code-host.ts';
import {
  BREW_ORDER,
  BREWERY,
  CRASH_LINE,
  ON_TAP_LINE,
  ORDER,
  USER,
} from '../../scripts/demo/core.ts';
import {
  headingOf,
  LOST_LINE,
  STEPS,
  type Step,
  stepLines,
} from '../../scripts/demo/walkthrough.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { type ExecResult, execProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import type { Event } from '../../src/schemas/events.ts';
import { runGit } from '../../src/workspace/git.ts';
import { hangGuardMs } from '../helpers/load.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const root = join(import.meta.dirname, '..', '..');
const demo = join(root, 'scripts', 'demo.ts');

describe('npm run demo', () => {
  let dir: TempDir;
  let scratch: string;
  /** The one run of the demo every test reads: it takes minutes. */
  let result: ExecResult;
  /** Where each step's heading starts in the output. */
  let at: number[];
  /** The output of `step`, from its heading to the next one's. */
  const part = (step: Step['id']): string => {
    const n = STEPS.findIndex(({ id }) => id === step);
    return result.stdout.slice(at[n], at[n + 1]);
  };
  before(async () => {
    dir = makeTempDir('demo');
    scratch = join(dir.path, 'demo');
    const scriptedAttempts = Object.values(DEMO_SCRIPT).reduce((n, turns) => n + turns.length, 0);
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
    result = await execProcess(process.execPath, [demo, '--in', scratch, '--no-pause'], {
      cwd: root,
      env: { ...env, GIT_CONFIG_GLOBAL: noIdentity, GIT_CONFIG_NOSYSTEM: '1' },
      // Only a guard against a hang (ADR 0075): two runs of the demo's recipe, counted by the
      // attempts its script plays in a batch, the tasting loop's second round too (ADR 0193).
      timeoutMs: scriptedAttempts * hangGuardMs,
    });
    at = STEPS.map((_, index) => result.stdout.indexOf(headingOf(index)));
  });
  after(() => removeTree(dir.path));

  it('brews one order with Nip through a crash and a restart, another with foedrum brew, on a machine with no git identity', async () => {
    assert.equal(result.exitCode, 0, result.output);
    assert.ok(result.stdout.includes(CRASH_LINE), result.output);
    assert.ok(result.stdout.includes(ON_TAP_LINE), result.output);

    // The walkthrough's steps, in order, with no pause between them.
    assert.ok(
      at.every((where, n) => where >= 0 && where > (at[n - 1] ?? -1)),
      `headings at ${at.join(', ')}:\n${result.stdout}`,
    );
    // The first Cellar shows status as the batch moves, up to the Gauger's attempt the kill takes.
    assert.match(part('brewing'), /brewing +gauge #1 started/);
    // The restart shows that it found the lost attempt: lost because the killed Cellar stopped, in
    // plain words without its owner or a UTC time (#277), and brewed again.
    assert.match(
      part('restart'),
      /demo: the restart found gauge #1 lost \(the Cellar running it stopped, so its lease ran out\); gauge #2 brews it again/,
    );
    assert.equal(result.stdout.split(LOST_LINE).length, 2, 'the lost attempt is said once');
    // The cause before the effect: the lost attempt, then the status that shows its retry (#277).
    const restart = part('restart');
    const retried = restart.search(/brewing +gauge #2 started/);
    assert.ok(retried >= 0, restart);
    assert.ok(restart.indexOf(LOST_LINE) < retried, restart);
    // The red proof reads the Gauger's test red, the first fix fails green, and the Cellarman's
    // second attempt is told why, with the failed test's own line.
    const checks = part('checks');
    assert.match(checks, /brewing +red #1 started/);
    assert.match(checks, /brewing +green #1 started.*brewing +implement #2 started/s);
    assert.match(
      checks,
      /demo: implement #2 is told why step implement runs again: the failed checks of step green\n +not ok \d+ - greets a stranger when no name is given/,
    );
    // The status comment is shown as its Markdown, without the hidden revision marker: its path a
    // line per round, and its pull request named once (#662).
    const statusComment = part('pull-request');
    // The restarted Cellar's life ends in the step before: on tap, its cleanup and its stop; the
    // pull request's step starts with the pull request (#277).
    const lifeEnd = [ON_TAP_LINE, 'foedrum serve: stopped', 'cleaned batch 1-1'];
    for (const line of lifeEnd) {
      assert.ok(checks.includes(line), `${line} in the checks step:\n${checks}`);
      assert.ok(!statusComment.includes(line), `${line} in the pull request's:\n${statusComment}`);
    }
    // part() starts at the heading, which stepLines opens with a blank line.
    const opening = stepLines(STEPS.findIndex(({ id }) => id === 'pull-request')).length - 1;
    assert.match(
      statusComment.split(/\r?\n/)[opening] ?? '',
      /^demo: pull request #\d+ on demo\/web: /,
      statusComment,
    );
    assert.match(statusComment, /On tap/);
    assert.match(statusComment, /^ +Path: `gauge #1`.*\n +→ `implement #2`.*\n +→ `implement #3`/m);
    assert.equal(
      statusComment.match(/^ +- <https:\/\/github\.com\/demo\/web\/pull\/\d+>/gm)?.length,
      1,
    );
    assert.ok(!result.stdout.includes('<!--'), result.stdout);
    // A cleanup counts the worktrees and branches it removed (#662).
    assert.match(result.stdout, /cleaned batch 1-1: removed \d+ worktrees; deleted \d+ branches; /);
    assert.doesNotMatch(result.stdout, /removed worktree /);
    // On tap: foedrum status shows the batch there, with its pull request.
    assert.match(
      part('on-tap'),
      /\$ foedrum status\n.*on tap +https:\/\/github\.com\/demo\/web\/pull\/\d+/s,
    );
    // foedrum lenses, through the real loader: correctness's finding the round it blocked
    // recorded, fixed; a lens of Nip's the demo's recipe never runs, with no rounds (ADR 0221).
    const report = part('lenses');
    assert.match(
      report,
      /\$ foedrum lenses\n.*diff\/acceptance +defaults\/lenses\/diff\/acceptance\.md\n +no rounds\n/s,
    );
    assert.match(
      report,
      /diff\/correctness +defaults\/lenses\/diff\/correctness\.md\n +2 rounds, 1 finding: 1 major\n +ended: 1 fixed\n/,
    );
    assert.match(report, /diff\/security .*\n +2 rounds, 1 finding: 1 minor\n +ended: 1 open\n/);
    // foedrum brew orders the second issue, routes it by its label, and drives it to on tap.
    const brew = part('brew');
    assert.ok(brew.includes(`$ foedrum brew ${BREW_ORDER.number} --as ${USER}\n`), brew);
    assert.match(brew, /foedrum brew: ordered #2 as batch 2-1/);
    assert.match(brew, /foedrum brew: routed batch 2-1 to the recipe nip-parallel$/m);
    assert.match(
      brew,
      /foedrum brew: batch 2-1 is on tap: https:\/\/github\.com\/demo\/web\/pull\/\d+/,
    );
    // Once (#662).
    assert.doesNotMatch(brew, /batch 2-1 on tap/);
    // foedrum resume names the Cellarman's attempt and prints its line, opening nothing.
    assert.match(
      part('resume'),
      /\$ foedrum resume 1-1 implement#2\n[^$]*foedrum resume 1-1 implement#2/,
    );
    // replay shows the state the fold makes of the batch's events, and only counts them (#662).
    const replay = part('replay');
    assert.match(replay, /Batch 1-1, issue/);
    assert.match(replay, /Events +\d+, left out here: foedrum replay 1-1 lists them/);
    assert.doesNotMatch(replay, /batch\.on_tap/);
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
    // The three lens attempts of a round run side by side, so they may end in any order.
    const lensOutcome = /^(?:correctness|security|test-design)#/;
    const inOrder: string[] = [];
    let round: string[] = [];
    for (const outcome of [...outcomes, '']) {
      if (lensOutcome.test(outcome)) {
        round.push(outcome);
        continue;
      }
      inOrder.push(...round.sort());
      round = [];
      if (outcome !== '') inOrder.push(outcome);
    }
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
      // Round 1: correctness blocks with its finding, and the batch goes back to implement once.
      'correctness#1 failed',
      'security#1 succeeded',
      'test-design#1 succeeded',
      'implement#3 succeeded',
      'fine#3 succeeded',
      'green#3 succeeded',
      // Round 2 approves.
      ...['correctness', 'security', 'test-design'].map((lens) => `${lens}#2 succeeded`),
      'open-pull-request#1 succeeded',
    ]);
    // In each round, the parallel group's three lens attempts all started before any of them
    // ended (ADR 0168).
    const lenses = new Set(['correctness', 'security', 'test-design']);
    const group = events.flatMap((event) =>
      (event.type === 'step.started' || event.type === 'step.finished') &&
      event.batchId === '1-1' &&
      lenses.has(event.stepId)
        ? [event.type]
        : [],
    );
    const started = ['step.started', 'step.started', 'step.started'];
    assert.deepStrictEqual([group.slice(0, 3), group.slice(6, 9)], [started, started]);
    assert.equal(group.length, 12, JSON.stringify(group));
    // While they brewed, foedrum status showed the three of them at once.
    assert.match(
      part('checks'),
      /brewing +correctness #1 started, security #1 started, test-design #1 started/,
    );
    // Correctness's finding sends the batch back to implement, with its out doc as the route
    // input (ADR 0128), and round 2 is told the change since round 1 and that finding marked
    // fixed, by the Cellarman's disposition (ADR 0190, ADR 0191, ADR 0193).
    assert.match(
      part('checks'),
      /demo: implement #3 is told why step implement runs again: the findings of step correctness/,
    );
    const [blocked] = (DEMO_SCRIPT.correctness?.[0]?.tasting?.findings ?? []) as { why?: string }[];
    const [fixed] = (DEMO_SCRIPT.implement?.[2]?.dispositions ?? []) as { why?: string }[];
    assert.ok(
      part('checks').includes(
        // The Cellar's own lines are indented by two spaces, the input's by two more.
        `\n    Round correctness#1:\n    - major in greet.mjs:2: ${blocked?.why}\n      fixed: ${fixed?.why}\n`,
      ),
      part('checks'),
    );
    assert.match(
      part('checks'),
      /demo: correctness #2 is told the change since commit [0-9a-f]{7,}, as \{roundChange\}, and the earlier findings, as \{earlierFindings\}:/,
    );
    assert.match(
      part('checks'),
      /brewing +correctness #2 started, security #2 started, test-design #2 started/,
    );
    // The status comment's path has both rounds, the three lenses side by side in each and a line
    // where the batch went back to implement (#662), each failed attempt with why (#656), and each
    // one's findings show under its own step.
    const comment = host.comments(BREWERY, ORDER.number)[0]?.body ?? '';
    assert.match(comment, /Recipe \*\*nip-parallel\*\*/);
    assert.match(
      comment,
      /`gauge #1` ❌ the attempt was lost → .*`green #1` ❌ the check "test" failed with exit code 1\n→ .*`green #2` ✅ → `correctness #1` ❌ blocked \(findings\) → `security #1` ✅ → `test-design #1` ✅\n→ `implement #3` ✅ → `fine #3` ✅ → `green #3` ✅ → `correctness #2` ✅ → `security #2` ✅ → `test-design #2` ✅ → `open-pull-request #1` ✅/,
    );
    for (const lens of ['security', 'test-design']) {
      assert.match(comment, new RegExp(`^- \`${lens}\`: minor in `, 'm'));
    }
    assert.ok(
      events.some((event) => event.type === 'batch.on_tap' && event.batchId === '2-1'),
      JSON.stringify(events),
    );

    // The Cellarman's third fix, after round 1's finding, is the tip of the bottle branch on the
    // target's remote.
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
    assert.equal(log.stdout.trim(), DEMO_SCRIPT.implement?.[2]?.message);
    // Round 2 is told the change since the commit round 1 reviewed: the one before that fix.
    const reviewed = await runGit(root, [
      '--git-dir',
      join(scratch, 'web.git'),
      'rev-parse',
      `${head}~1`,
    ]);
    assert.equal(reviewed.code, 0, reviewed.stderr);
    assert.ok(
      part('checks').includes(
        `demo: correctness #2 is told the change since commit ${reviewed.stdout.trim()}, as {roundChange}`,
      ),
      part('checks'),
    );
  });

  // Step 12: an issue mashed (ADR 0232): the Innkeeper's question, an answer, and the Brewmaster's
  // plan waiting Stuck for its review (ADR 0275).
  it("step 12 prints the Innkeeper's question with its two choices", () => {
    const mash = part('mash');
    assert.ok(mash.includes('$ foedrum mash 3 --as ann\n'), mash);
    assert.match(mash, /foedrum mash: routed batch 3-1 to the recipe mash-in$/m);
    assert.match(mash, /foedrum mash: batch 3-1 needs input at innkeep:$/m);
    assert.match(
      mash,
      /foedrum mash: {3}1\. Which recipe brews #3\? [^\n]*\(mash, nip-parallel; recommended: mash\)$/m,
    );
  });

  it("after the answer, step 12's foedrum stuck names the plan waiting for review and its next step", () => {
    const mash = part('mash');
    assert.ok(mash.includes('$ foedrum answer 3-1 mash\n'), mash);
    assert.match(
      mash,
      /foedrum brew: batch 3-1 is stuck: the plan of plan #1 is ready for your review; [^\n]*the plan: https:\/\/github\.com\/demo\/brewery\/issues\/3#issuecomment-\d+$/m,
    );
    const stuck = mash.slice(mash.indexOf('$ foedrum stuck\n'));
    assert.ok(stuck.startsWith('$ foedrum stuck\n'), mash);
    assert.match(stuck, /^ +3-1 +[^\n]*the plan of plan #1 is ready for your review(?:;|$)/m);
    assert.match(stuck, /^ {4}next: \S/m);
  });

  it('step 12 prints the plan comment with the link to the full plan, the table, the flowchart and the Next line', () => {
    const mash = part('mash');
    // The plan comment comes after the status comment, which has a Next line of its own.
    const heading = mash.search(/^ +### Foedrum · plan of batch `3-1`$/m);
    assert.ok(heading >= 0, mash);
    const plan = mash.slice(heading);
    assert.match(plan, /^ +Full plan: <https:\/\/github\.com\/demo\/brewery\/[^>]+>$/m);
    assert.match(plan, /^ +\| Sub-order \| Size \| Recipe \| Depends on \| Ready \|$/m);
    assert.match(plan, /^ +```mermaid\n +flowchart LR\n/m);
    assert.match(plan, /^ +s1 -->\|"code"\| s2$/m);
    assert.match(plan, /^ +Next: \S/m);
    // The status comment links the plan comment, the one foedrum brew names, not itself.
    const planUrl = /the plan: (\S+)$/m.exec(mash)?.[1] ?? assert.fail(mash);
    const statusUrl = /status comment: (\S+)$/m.exec(mash)?.[1] ?? assert.fail(mash);
    assert.notEqual(planUrl, statusUrl);
    assert.ok(
      mash.includes(`🔔 **Stuck**: the plan of \`plan\` #1 is ready for your review: <${planUrl}>`),
      mash,
    );
  });

  it("step 12's answer is the demo user's, who mashed the order, not the machine's account", () => {
    const mash = part('mash');
    assert.match(mash, /^ +Recipe \*\*mash\*\*, chosen by ann \(terminal\)$/m);
    assert.match(
      mash,
      /`innkeep`: attempt 1 asked for input, answered by ann \(terminal\): mash$/m,
    );
  });

  it("the walkthrough has twelve steps, step 12's heading among them", () => {
    assert.equal(STEPS.length, 12);
    assert.equal(headingOf(11), 'Step 12 of 12: foedrum mash 3 --as ann');
    assert.ok(result.stdout.includes(`\n${headingOf(11)}\n`), result.stdout);
  });
});
