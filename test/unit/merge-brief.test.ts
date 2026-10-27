// The merge brief on a ready pull request (ADR 0225): the command log is the real one on a store in
// memory, a batch brews through a fake recipe to On tap, the intake's records are issued as it
// issues them, and a fake code host takes the comments (ADR 0021).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { effectMarker } from '../../src/engine/claim-effects.ts';
import { type CommandLog, createCommandLog } from '../../src/engine/command-log.ts';
import type { Ending } from '../../src/engine/decide.ts';
import type { DriverEffects } from '../../src/engine/driver.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { readyOf } from '../../src/engine/merge-brief.ts';
import { type MergeBriefHost, mergeBriefEffects } from '../../src/engine/merge-brief-post.ts';
import { pullRequestKey, pushKey } from '../../src/engine/pull-request.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { type StatusComments, statusEffects } from '../../src/engine/status-comment.ts';
import type { GravityReading, HeadCheck } from '../../src/schemas/events.ts';
import type { TastingFinding } from '../../src/schemas/out-doc.ts';
import type { PushResult, SensitiveFiles } from '../../src/schemas/store.ts';
import { fakeRecipe, fakeRecipes } from '../helpers/fake-recipes.ts';

const url = 'https://github.com/acme/web/pull/12';
const now = new Date('2026-10-26T09:00:00.000Z');
const head = 'a'.repeat(40);
const fixed = 'f'.repeat(40);
const tip = 'c'.repeat(40);
const tasted = 'd'.repeat(40);
const OPEN = 'open';
const taste = { taste: ['correctness', 'acceptance'] };
const recipes = fakeRecipes({
  nip: fakeRecipe({
    steps: ['gauge', 'red', 'implement', 'green', 'taste', OPEN],
    groups: taste,
    actions: { [OPEN]: 'openPullRequest' },
    routes: { [OPEN]: { pull_request: 'implement' } },
    pullRequests: [],
  }),
  // Nip without a test-first label: no Gauger and no red proof.
  skippy: fakeRecipe({
    steps: ['gauge', 'red', 'implement', 'green', 'taste', OPEN],
    groups: taste,
    actions: { [OPEN]: 'openPullRequest' },
    routes: { [OPEN]: { pull_request: 'implement' } },
    skips: { gauge: 'recipe.testFirst', red: 'recipe.testFirst' },
    pullRequests: [],
  }),
  // One blocking Taster in a line, whose findings go back to implement once.
  lined: fakeRecipe({
    steps: ['implement', 'taste', OPEN],
    actions: { [OPEN]: 'openPullRequest' },
    routes: { taste: { findings: 'implement' }, [OPEN]: { pull_request: 'implement' } },
    maxRounds: 1,
    pullRequests: [],
  }),
  // A blocking Taster with no round left: its findings make the batch Stuck at once.
  strict: fakeRecipe({
    steps: ['implement', 'taste', OPEN],
    actions: { [OPEN]: 'openPullRequest' },
    routes: { taste: { findings: 'implement' } },
    maxRounds: 0,
    pullRequests: [],
  }),
  // A fix round that goes back to a step after the tasting.
  late: fakeRecipe({
    steps: ['implement', 'taste', 'fix', OPEN],
    actions: { [OPEN]: 'openPullRequest' },
    routes: { [OPEN]: { pull_request: 'fix' } },
    pullRequests: [],
  }),
  // No Taster at all.
  bare: fakeRecipe({
    steps: ['implement', OPEN],
    actions: { [OPEN]: 'openPullRequest' },
    pullRequests: [],
  }),
});
const redProof = (recipe: string) => (recipe === 'nip' || recipe === 'skippy' ? 'red' : undefined);

const done: Ending = {
  kind: 'succeeded',
  output: { status: 'done', summary: 'Done', assumptions: [] },
};
const tasting = (findings: TastingFinding[] = [], riskLeft?: string[]): Ending => ({
  kind: 'succeeded',
  // Through JSON, as the event log keeps it: a finding's optional fields are left out.
  output: JSON.parse(
    JSON.stringify({
      status: 'done',
      summary: 'Tasted',
      assumptions: [],
      verdict: findings.some(
        ({ severity, introduced }) =>
          introduced && (severity === 'blocker' || severity === 'major'),
      )
        ? 'changes'
        : 'approve',
      findings,
      ...(riskLeft === undefined ? {} : { riskLeft }),
    }),
  ),
});
const passed = (name: string, link?: string): HeadCheck => ({
  name,
  kind: 'check_run',
  conclusion: 'success',
  ...(link === undefined ? {} : { url: link }),
});
const failed = (name: string): HeadCheck => ({ name, kind: 'check_run', conclusion: 'failure' });
const build = 'https://github.com/acme/web/actions/runs/1';
const redReading: GravityReading = {
  result: 'exited',
  check: 'test',
  command: 'npm test',
  exitCode: 1,
  tail: '1 failing',
};
const greenReadings: GravityReading[] = [
  { result: 'exited', check: 'build', command: 'npm run build', exitCode: 0, tail: '' },
  { result: 'skipped', check: 'format' },
];

/**
 * A code host of one pull request, its title `title`, that keeps the comments made on it and the
 * ids of those it hid as outdated.
 */
const fakeHost = (title = 'Add a --json flag') => {
  const comments: { id: number; body: string; hidden?: boolean }[] = [];
  const hides: number[] = [];
  let made = 0;
  const host: MergeBriefHost = {
    find: async (_repo, _number, marker) => comments.find(({ body }) => body.endsWith(marker)),
    create: async (_repo, _number, body) => {
      made++;
      comments.push({ id: made, body });
      return made;
    },
    title: async () => title,
    hidden: async (_repo, id) => {
      const comment = comments.find((each) => each.id === id);
      if (comment === undefined) return 'gone';
      return comment.hidden === true ? 'hidden' : 'shown';
    },
    hide: async (_repo, id) => {
      const comment = comments.find((each) => each.id === id);
      if (comment === undefined) return 'gone';
      hides.push(id);
      comment.hidden = true;
      return 'hidden';
    },
  };
  return { host, comments, hides };
};

describe('the merge brief (ADR 0225)', () => {
  let store: EventStore;
  let log: CommandLog;

  beforeEach(() => {
    store = openSqliteEventStore(':memory:');
    log = createCommandLog({ store, recipes });
  });
  afterEach(() => store.close());

  const accept = (command: Parameters<CommandLog['issue']>[0]): void => {
    const decision = log.issue(command, now);
    assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
  };
  const ledger = (key: Parameters<typeof effectKey.encode>[0], result: unknown): void =>
    accept({
      kind: 'record',
      event: { type: 'effect.applied', key: effectKey.encode(key), result },
    });
  /** The scheduled attempt of `stepId`, started (in a worktree at `commit`) and ended with `ending`. */
  const run = (
    stepId: string,
    ending: Ending = done,
    { readings, commit }: { readings?: GravityReading[]; commit?: string } = {},
    batchId = 'web-7',
  ): void => {
    const attempts = log.state().batches.get(batchId)?.steps.get(stepId)?.attempts;
    const attempt = Math.max(...(attempts?.keys() ?? []));
    assert.equal(attempts?.get(attempt)?.phase, 'scheduled', `${stepId} is scheduled`);
    const ref = { batchId, stepId, attempt };
    const worktree =
      commit === undefined
        ? {}
        : { worktree: { repo: 'acme/web', path: `/w/${stepId}`, branch: stepId, commit } };
    accept({ kind: 'record', event: { type: 'step.started', ...ref, ...worktree } });
    accept({ kind: 'finish', ...ref, ending, ...(readings === undefined ? {} : { readings }) });
  };
  /** The action's scheduled attempt: the push of `round` recorded, and the pull request opened. */
  const open = (round = 1, commit = head, sensitive?: SensitiveFiles, batchId = 'web-7'): void => {
    const pushed: PushResult = {
      branch: 'foedrum/web-7/acme.web',
      commit,
      from: 'start',
      ...(sensitive === undefined ? {} : { sensitive }),
    };
    const attempts = log.state().batches.get(batchId)?.steps.get(OPEN)?.attempts;
    const attempt = Math.max(...(attempts?.keys() ?? []));
    accept({ kind: 'record', event: { type: 'step.started', batchId, stepId: OPEN, attempt } });
    ledger(pushKey(batchId, round), pushed);
    if (round === 1) ledger(pullRequestKey(batchId), url);
    accept({ kind: 'finish', batchId, stepId: OPEN, attempt, ending: done });
  };
  const order = (recipe: string, batchId = 'web-7', issue = 7): void => {
    accept({ kind: 'order', batchId, order: { issue } });
    accept({ kind: 'route', batchId, recipe, reason: 'label', source: 'label' });
  };
  /** Nip's steps after the Gauger and the red proof, to On tap. */
  const nipFromImplement = (
    round = 1,
    commit = head,
    tastes: { correctness?: Ending; acceptance?: Ending } = {},
    sensitive?: SensitiveFiles,
  ): void => {
    run('implement');
    run('green', done, { readings: greenReadings });
    run('correctness', tastes.correctness ?? tasting(), { commit });
    run('acceptance', tastes.acceptance ?? tasting(), { commit });
    open(round, commit, sensitive);
  };
  /** A batch of Nip brewed to On tap, its pull request opened on `head`. */
  const nip = (
    tastes: { correctness?: Ending; acceptance?: Ending } = {},
    sensitive?: SensitiveFiles,
  ): void => {
    order('nip');
    run('gauge');
    run('red', done, { readings: [redReading] });
    nipFromImplement(1, head, tastes, sensitive);
  };
  const finished = (checks: HeadCheck[], on = head, more?: number, batchId = 'web-7'): void =>
    accept({
      kind: 'record',
      event: {
        type: 'pull_request.checks_finished',
        batchId,
        pullRequest: url,
        head: on,
        checks,
        ...(more === undefined ? {} : { more }),
      },
    });
  const pending = (on = head, batchId = 'web-7'): void =>
    accept({
      kind: 'record',
      event: {
        type: 'pull_request.checks_pending',
        batchId,
        pullRequest: url,
        head: on,
        since: now.toISOString(),
      },
    });
  const baseChecked = (found: {
    conflicts?: string[];
    failed?: GravityReading;
    unchecked?: string;
    branchMoved?: string;
  }): void =>
    accept({
      kind: 'record',
      event: {
        type: 'pull_request.base_checked',
        batchId: 'web-7',
        pullRequest: url,
        branch: 'main',
        tip,
        ...found,
      },
    });
  const batch = (batchId = 'web-7') => {
    const found = log.state().batches.get(batchId);
    assert.ok(found);
    return found;
  };
  const effectsOf = (host: MergeBriefHost): DriverEffects =>
    mergeBriefEffects({ host, recipes, redProof });
  /** What a driver does with each due brief: found, else posted; then recorded in the ledger. */
  const post = async (effects: DriverEffects, batchId = 'web-7'): Promise<string[]> => {
    const keys = effects.due(log.state(), batchId);
    for (const key of keys) {
      const encoded = effectKey.encode(key);
      const found = await effects.target.find(encoded);
      const result = found === undefined ? await effects.target.apply(encoded) : found.result;
      accept({ kind: 'record', event: { type: 'effect.applied', key: encoded, result } });
    }
    return keys.map(({ effect }) => effect);
  };
  /** The one brief posted now, by its text. */
  const brief = async (): Promise<string> => {
    const { host, comments } = fakeHost();
    assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1']);
    const [comment] = comments;
    assert.ok(comment);
    return comment.body;
  };

  describe('when it is posted', () => {
    it('posts one brief once every check on the pushed head passed, and never again for it', async () => {
      nip();
      const { host, comments } = fakeHost();
      const effects = effectsOf(host);
      assert.deepStrictEqual(await post(effects), []);
      finished([passed('ci/build', build), passed('ci/lint')]);
      assert.deepStrictEqual(await post(effects), ['brief.1']);
      assert.deepStrictEqual(await post(effects), []);
      assert.equal(comments.length, 1);
      const [comment] = comments;
      assert.ok(comment);
      const marker = effectMarker(effectKey.encode({ batchId: 'web-7', effect: 'brief.1' }));
      const digest = readyOf(log.state(), batch())?.digest;
      assert.ok(
        comment.body.endsWith(`\n\n<!-- foedrum:brief ${url} ${head} ${digest} -->\n${marker}`),
      );
      assert.ok(comment.body.startsWith('### Merge? Add a --json flag @ `aaaaaaaa`\n'));
      assert.match(comment.body, /\*\*Ready to merge\.\*\*/);
      assert.match(comment.body, /waits for whoever merges/);
      assert.deepStrictEqual(
        log.state().effects.get(effectKey.encode({ batchId: 'web-7', effect: 'brief.1' })),
        {
          comment: 1,
          pullRequest: url,
          head,
          digest: readyOf(log.state(), batch())?.digest,
        },
      );
    });

    it('posts nothing while a check runs or failed, or on a head the batch did not push', async () => {
      nip();
      const effects = effectsOf(fakeHost().host);
      pending();
      assert.deepStrictEqual(await post(effects), []);
      finished([failed('ci/test'), passed('ci/build')]);
      assert.deepStrictEqual(await post(effects), []);
      // A person pushed: GitHub's head is not the batch's push.
      finished([passed('ci/build')], fixed);
      assert.deepStrictEqual(await post(effects), []);
      assert.equal(readyOf(log.state(), batch()), undefined);
    });

    it('posts nothing once the pull request ended', async () => {
      nip();
      finished([passed('ci/build')]);
      accept({
        kind: 'record',
        event: { type: 'pull_request.ended', batchId: 'web-7', pullRequest: url, state: 'merged' },
      });
      assert.deepStrictEqual(await post(effectsOf(fakeHost().host)), []);
    });

    it('posts nothing while its base check found a conflict or a failing check on the merged tree', async () => {
      nip();
      finished([passed('ci/build')]);
      baseChecked({ conflicts: ['src/a.ts'] });
      assert.deepStrictEqual(await post(effectsOf(fakeHost().host)), []);
      baseChecked({ failed: { ...redReading, check: 'test' } });
      assert.deepStrictEqual(await post(effectsOf(fakeHost().host)), []);
      // Clean again: ready.
      baseChecked({});
      assert.deepStrictEqual(await post(effectsOf(fakeHost().host)), ['brief.1']);
    });

    it('posts nothing while the batch brews a fix of its pull request', async () => {
      nip();
      finished([failed('ci/test')]);
      accept({
        kind: 'fix_pull_request',
        batchId: 'web-7',
        pullRequest: url,
        head,
        cause: { kind: 'checks' },
      });
      // No pass records the checks of a batch that brews (ADR 0219): it is not On tap.
      assert.equal(batch().lane.kind, 'brewing');
      assert.equal(readyOf(log.state(), batch()), undefined);
      assert.deepStrictEqual(await post(effectsOf(fakeHost().host)), []);
    });

    it('posts a head with no checks only once its record finished, and says none ran', async () => {
      nip();
      pending();
      assert.deepStrictEqual(await post(effectsOf(fakeHost().host)), []);
      finished([]);
      const body = await brief();
      assert.match(body, /No check ran on this head\./);
    });

    it('posts once a re-run turned a failure green', async () => {
      nip();
      finished([failed('ci/test')]);
      assert.deepStrictEqual(await post(effectsOf(fakeHost().host)), []);
      finished([passed('ci/test')]);
      assert.match(await brief(), /ci\/test \(success\)/);
    });

    it('posts nothing again when the same record goes pending and finishes the same', async () => {
      nip();
      const effects = effectsOf(fakeHost().host);
      finished([passed('ci/build'), passed('ci/lint')]);
      assert.deepStrictEqual(await post(effects), ['brief.1']);
      pending();
      assert.deepStrictEqual(await post(effects), []);
      finished([passed('ci/lint'), passed('ci/build')]);
      assert.deepStrictEqual(await post(effects), []);
      // A check that registered late changes the record: it is ready again with other evidence.
      pending();
      finished([passed('ci/lint'), passed('ci/build'), passed('ci/late')]);
      assert.deepStrictEqual(await post(effects), ['brief.2']);
    });

    it("posts the next brief for a fix round's ready head, and says what changed", async () => {
      nip();
      const { host, comments } = fakeHost();
      const effects = effectsOf(host);
      finished([failed('ci/test')]);
      accept({
        kind: 'fix_pull_request',
        batchId: 'web-7',
        pullRequest: url,
        head,
        cause: { kind: 'checks' },
      });
      nipFromImplement(2, fixed);
      finished([passed('ci/test')], fixed);
      assert.deepStrictEqual(await post(effects), ['brief.1']);
      const body = comments[0]?.body ?? '';
      assert.ok(body.startsWith('### Merge? Add a --json flag @ `ffffffff`\n'));
      assert.match(body, /Round 2: the checks failed on `aaaaaaaa`, and it pushed `ffffffff`\./);
      // The first head was never ready: the round's brief is the first.
      assert.equal(comments.length, 1);
    });

    it('posts a brief for each head that was ready', async () => {
      nip();
      const effects = effectsOf(fakeHost().host);
      finished([passed('ci/test')]);
      assert.deepStrictEqual(await post(effects), ['brief.1']);
      // A late check fails it, and the fix round's head is ready.
      pending();
      finished([passed('ci/test'), failed('ci/late')]);
      accept({
        kind: 'fix_pull_request',
        batchId: 'web-7',
        pullRequest: url,
        head,
        cause: { kind: 'checks' },
      });
      nipFromImplement(2, fixed);
      finished([passed('ci/test'), passed('ci/late')], fixed);
      // The first head's brief is outdated (ADR 0229).
      assert.deepStrictEqual(await post(effects), ['brief.1.hidden', 'brief.2']);
    });

    it('posts while its order is paused: a brief runs nothing', async () => {
      nip();
      accept({ kind: 'pause', by: 'ann', via: 'terminal' });
      finished([passed('ci/build')]);
      assert.deepStrictEqual(await post(effectsOf(fakeHost().host)), ['brief.1']);
    });

    it('posts when a person skipped a blocking Taster blocked by its findings, and lists it as left open', async () => {
      order('strict');
      run('implement');
      run('taste', {
        kind: 'blocked',
        blockerKind: 'findings',
        summary: 'A change is asked',
        findings: [
          { severity: 'major', why: 'Breaks the flag', introduced: true, file: 'src/a.ts' },
        ],
      });
      assert.equal(batch().lane.kind, 'stuck');
      accept({ kind: 'skip', batchId: 'web-7', by: 'ann', via: 'terminal' });
      open();
      finished([passed('ci/build')]);
      assert.match(
        await brief(),
        /`taste`: left open by a skip: its attempt 1 was blocked by its findings/,
      );
    });
  });

  describe('what it says', () => {
    it('says nothing changed since it opened when no round sent it back', async () => {
      nip();
      finished([passed('ci/build')]);
      assert.match(await brief(), /\*\*What changed since it opened\*\*\n- Nothing\./);
    });

    it('lists each check with its conclusion and link, and how many more passed', async () => {
      nip();
      finished([passed('ci/build', build), passed('ci/lint')], head, 3);
      const body = await brief();
      assert.match(body, /\*\*Evidence on `aaaaaaaa`\*\*/);
      assert.ok(body.includes(`- ✅ ci/build (success) <${build}>`));
      assert.ok(body.includes('- ✅ ci/lint (success)\n'));
      assert.match(body, /- and 3 more checks, which passed/);
    });

    it('says how it merges with its base, a merged tree not checked included', async () => {
      nip();
      finished([passed('ci/build')]);
      assert.match(await brief(), /- Not checked against its base since it was pushed\./);
      store.close();
      store = openSqliteEventStore(':memory:');
      log = createCommandLog({ store, recipes });
      nip();
      finished([passed('ci/build')]);
      baseChecked({ unchecked: 'the setup "npm ci" is no longer named' });
      assert.match(
        await brief(),
        /- Not checked on the merged tree with `main` at `cccccccc`: the setup "npm ci" is no longer named\./,
      );
    });

    it('says a clean base check is the latest, which names no head, not a check of this head', async () => {
      nip();
      finished([passed('ci/build')]);
      baseChecked({});
      assert.match(
        await brief(),
        /- The latest check against its base, which names no head, merged cleanly with `main` at `cccccccc`\./,
      );
    });

    it('says the red proof read the new tests fail, and the checks a check step read and skipped', async () => {
      nip();
      finished([passed('ci/build')]);
      const body = await brief();
      assert.match(
        body,
        /- Red proof `red`: the check "test" \(npm test\) failed with exit code 1, as the new tests should before the change\./,
      );
      assert.match(
        body,
        /- `green` passed: the check "build" \(npm run build\)\. Not run: the check "format", which the repository does not have\./,
      );
    });

    it('says each step that did not run, and why', async () => {
      order('skippy');
      nipFromImplement();
      finished([passed('ci/build')]);
      const body = await brief();
      assert.match(body, /- Red proof `red`: not run: its when "recipe\.testFirst" was false\./);
      assert.match(body, /- `gauge`: not run: its when "recipe\.testFirst" was false\./);
    });

    it('says the recipe has no red proof', async () => {
      order('late');
      run('implement');
      run('taste', tasting(), { commit: head });
      run('fix');
      open();
      finished([passed('ci/build')]);
      assert.match(await brief(), /- Red proof: none in the recipe\./);
    });

    it('says where the last Taster tasted, and the fix rounds since', async () => {
      nip();
      finished([passed('ci/build')]);
      assert.match(await brief(), /- Tasted at `aaaaaaaa`, this head\./);
      store.close();
      store = openSqliteEventStore(':memory:');
      log = createCommandLog({ store, recipes });
      order('late');
      run('implement');
      run('taste', tasting(), { commit: tasted });
      run('fix');
      open();
      finished([failed('ci/test')]);
      accept({
        kind: 'fix_pull_request',
        batchId: 'web-7',
        pullRequest: url,
        head,
        cause: { kind: 'checks' },
      });
      run('fix');
      open(2, fixed);
      finished([passed('ci/test')], fixed);
      assert.match(await brief(), /- Tasted at `dddddddd`; 1 fix round since\./);
    });

    it('names the sensitive paths the latest push recorded', async () => {
      nip({}, { count: 2, files: ['.github/workflows/ci.yml', 'package.json'] });
      finished([passed('ci/build')]);
      assert.match(
        await brief(),
        /- Touches sensitive paths: \.github\/workflows\/ci\.yml, package\.json\./,
      );
    });

    it('lists the findings fixed and dismissed with their reason, and the open ones of an advisory step', async () => {
      order('lined');
      run('implement');
      run('taste', {
        kind: 'blocked',
        blockerKind: 'findings',
        summary: 'Changes asked',
        findings: [
          {
            severity: 'major',
            why: 'Breaks the flag',
            introduced: true,
            file: 'src/a.ts',
            line: 3,
          },
          { severity: 'minor', why: 'Odd name', introduced: true },
        ],
      });
      run('implement', {
        kind: 'succeeded',
        output: {
          status: 'done',
          summary: 'Fixed',
          assumptions: [],
          dispositions: [
            { file: 'src/a.ts', line: 3, disposition: 'fixed' },
            { disposition: 'dismissed', why: 'The name follows ADR 0123' },
          ],
        },
      });
      run(
        'taste',
        tasting([
          {
            severity: 'minor',
            why: 'A comment could be shorter',
            introduced: true,
            lens: 'diff/correctness',
            file: 'src/b.ts',
          },
        ]),
        { commit: head },
      );
      open();
      finished([passed('ci/build')]);
      const body = await brief();
      assert.match(body, /\*\*Findings\*\*/);
      assert.match(body, /- `taste`: fixed at src\/a\.ts:3/);
      assert.match(
        body,
        /- `taste`: dismissed at the change as a whole: The name follows ADR 0123/,
      );
      assert.match(
        body,
        /- `taste`: open: diff\/correctness, minor in src\/b\.ts: A comment could be shorter/,
      );
    });

    it("shows the last Taster's risk left, each child of its group, or none recorded", async () => {
      nip({
        correctness: tasting([], ['Only a run shows the Windows path']),
        acceptance: tasting([], ['The second checklist item is not verifiable']),
      });
      finished([passed('ci/build')]);
      const body = await brief();
      assert.match(
        body,
        /\*\*Risk left\*\*\n- `correctness`: Only a run shows the Windows path\n- `acceptance`: The second checklist item is not verifiable/,
      );
      store.close();
      store = openSqliteEventStore(':memory:');
      log = createCommandLog({ store, recipes });
      nip();
      finished([passed('ci/build')]);
      assert.match(await brief(), /\*\*Risk left\*\*\nNone recorded\./);
    });

    it('takes the risk left of the last tasting round only', async () => {
      order('lined');
      run('implement');
      run('taste', tasting([], ['An early round risk']), { commit: head });
      // The batch goes on; nothing sent it back, so this round is the last.
      open();
      finished([failed('ci/test')]);
      accept({
        kind: 'fix_pull_request',
        batchId: 'web-7',
        pullRequest: url,
        head,
        cause: { kind: 'checks' },
      });
      run('implement');
      run('taste', tasting([], ['The round after the fix']), { commit: fixed });
      open(2, fixed);
      finished([passed('ci/test')], fixed);
      const body = await brief();
      assert.match(body, /- `taste`: The round after the fix/);
      assert.doesNotMatch(body, /An early round risk/);
    });

    it("keeps a model's text inert: no closing keyword, mention, secret, marker or Markdown", async () => {
      const secret = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
      const loud =
        'closes #3 for @ann <!-- foedrum:["web-7","brief.2"] --> **bold** [x](https://e.vil)';
      order('lined');
      run('implement');
      run('taste', {
        kind: 'blocked',
        blockerKind: 'findings',
        summary: 'Changes asked',
        findings: [{ severity: 'major', why: 'x', introduced: true, file: 'src/a.ts' }],
      });
      run('implement', {
        kind: 'succeeded',
        output: {
          status: 'done',
          summary: 'Fixed',
          assumptions: [],
          dispositions: [{ file: 'src/a.ts', disposition: 'dismissed', why: loud }],
        },
      });
      run(
        'taste',
        tasting([{ severity: 'minor', why: `token ${secret}`, introduced: true }], [loud]),
        { commit: head },
      );
      open();
      finished([passed('ci/build')]);
      const body = await brief();
      // Up to the brief's own record line: a model's `<!--` anywhere before it is a leak.
      const text = body.slice(0, body.lastIndexOf('\n\n<!-- foedrum:brief '));
      assert.doesNotMatch(text, /closes #3/i);
      assert.doesNotMatch(text, /@ann/);
      assert.doesNotMatch(text, /<!--/);
      assert.doesNotMatch(text, /\*\*bold\*\*/);
      assert.ok(!text.includes('[x](https'));
      assert.ok(!text.includes(secret));
      assert.match(text, /left out: a text of step taste that looks like a secret/);
    });

    it("escapes the pull request's title, which anyone with write access chose", async () => {
      nip();
      finished([passed('ci/build')]);
      const { host, comments } = fakeHost('Fix @ann <!-- x --> **now**');
      await post(effectsOf(host));
      const title = comments[0]?.body.split('\n')[0] ?? '';
      assert.equal(
        title,
        '### Merge? Fix &#64;ann &lt;\\!-- x --&gt; \\*\\*now\\*\\* @ `aaaaaaaa`',
      );
    });

    it('names the lens of the finding each disposition answered, from the blocked round', async () => {
      order('lined');
      run('implement');
      run('taste', {
        kind: 'blocked',
        blockerKind: 'findings',
        summary: 'Changes asked',
        findings: [
          {
            severity: 'major',
            why: 'Breaks the flag',
            introduced: true,
            file: 'src/a.ts',
            line: 3,
            lens: 'diff/correctness',
          },
          { severity: 'minor', why: 'Odd name', introduced: true, lens: 'diff/acceptance' },
        ],
      });
      run('implement', {
        kind: 'succeeded',
        output: {
          status: 'done',
          summary: 'Fixed',
          assumptions: [],
          dispositions: [
            { disposition: 'dismissed', why: 'The name follows ADR 0123' },
            { file: 'src/a.ts', line: 3, disposition: 'fixed' },
          ],
        },
      });
      run('taste', tasting(), { commit: head });
      open();
      finished([passed('ci/build')]);
      const body = await brief();
      assert.match(body, /- `taste`: diff\/correctness, fixed at src\/a\.ts:3/);
      assert.match(
        body,
        /- `taste`: diff\/acceptance, dismissed at the change as a whole: The name follows ADR 0123/,
      );
    });

    it('lists each finding a skip left open, as its blocked round recorded it', async () => {
      order('strict');
      run('implement');
      run('taste', {
        kind: 'blocked',
        blockerKind: 'findings',
        summary: 'A change is asked',
        findings: [
          {
            severity: 'major',
            why: 'Breaks the flag for @ann',
            introduced: true,
            file: 'src/a.ts',
            line: 7,
            lens: 'diff/correctness',
          },
        ],
      });
      accept({ kind: 'skip', batchId: 'web-7', by: 'ann', via: 'terminal' });
      open();
      finished([passed('ci/build')]);
      assert.match(
        await brief(),
        /- `taste`: left open by a skip: diff\/correctness, major in src\/a\.ts:7: Breaks the flag for ann/,
      );
    });
  });

  describe('found by its marker', () => {
    it('takes a brief a killed driver posted for this record as posted', async () => {
      nip();
      finished([passed('ci/build')]);
      const { host, comments } = fakeHost();
      const effects = effectsOf(host);
      const [key] = effects.due(log.state(), 'web-7');
      assert.ok(key);
      const encoded = effectKey.encode(key);
      await effects.target.apply(encoded);
      // Killed before its ledger entry: the next driver finds it.
      const next = effectsOf(host);
      assert.deepStrictEqual(next.due(log.state(), 'web-7'), [key]);
      const found = await next.target.find(encoded);
      assert.equal((found?.result as { comment: number } | undefined)?.comment, 1);
      assert.equal(comments.length, 1);
    });

    it("posts again under its key when the comment found is another record's brief", async () => {
      nip();
      finished([passed('ci/build')]);
      const { host, comments } = fakeHost();
      const effects = effectsOf(host);
      const [key] = effects.due(log.state(), 'web-7');
      assert.ok(key);
      await effects.target.apply(effectKey.encode(key));
      // Killed before its ledger entry, and a late check changed the record meanwhile.
      pending();
      finished([passed('ci/build'), passed('ci/late')]);
      assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1']);
      assert.equal(comments.length, 2);
      const recorded = log.state().effects.get(effectKey.encode(key)) as { comment: number };
      assert.equal(recorded.comment, 2);
      assert.match(comments[1]?.body ?? '', /ci\/late/);
    });

    it("takes this record's brief as posted when only its base moved after the kill", async () => {
      nip();
      finished([passed('ci/build')]);
      const { host, comments } = fakeHost();
      const [key] = effectsOf(host).due(log.state(), 'web-7');
      assert.ok(key);
      const posting = effectsOf(host);
      posting.due(log.state(), 'web-7');
      await posting.target.apply(effectKey.encode(key));
      // Killed before its ledger entry; the base moved and merges cleanly: the same record.
      baseChecked({});
      assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1']);
      assert.equal(comments.length, 1);
    });

    it("finds this record's brief among two a kill left under its key", async () => {
      nip();
      finished([passed('ci/build')]);
      const { host, comments } = fakeHost();
      const apply = async (): Promise<void> => {
        const effects = effectsOf(host);
        const [key] = effects.due(log.state(), 'web-7');
        assert.ok(key);
        await effects.target.apply(effectKey.encode(key));
      };
      // Killed before its ledger entry, then the record changed and its brief was posted too,
      // and that driver was killed before its ledger entry as well.
      await apply();
      pending();
      finished([passed('ci/build'), passed('ci/late')]);
      await apply();
      assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1']);
      assert.equal(comments.length, 2);
      const recorded = log
        .state()
        .effects.get(effectKey.encode({ batchId: 'web-7', effect: 'brief.1' })) as {
        comment: number;
      };
      assert.equal(recorded.comment, 2);
    });
  });

  describe('hidden as outdated (ADR 0229)', () => {
    const hiddenKey = (n: number) =>
      effectKey.encode({ batchId: 'web-7', effect: `brief.${n}.hidden` });
    /** A late check fails the ready head `from`, and a fix round pushes `commit` as round `round`. */
    const fixRound = (round = 2, commit = fixed, from = head): void => {
      pending(from);
      finished([passed('ci/test'), failed('ci/late')], from);
      accept({
        kind: 'fix_pull_request',
        batchId: 'web-7',
        pullRequest: url,
        head: from,
        cause: { kind: 'checks' },
      });
      nipFromImplement(round, commit);
    };

    it("hides the old head's brief once when a fix round pushes a new head, and posts only once the new head is ready", async () => {
      nip();
      const { host, comments, hides } = fakeHost();
      const effects = effectsOf(host);
      finished([passed('ci/test')]);
      assert.deepStrictEqual(await post(effects), ['brief.1']);
      fixRound();
      assert.deepStrictEqual(await post(effects), ['brief.1.hidden']);
      assert.deepStrictEqual(await post(effects), []);
      assert.deepStrictEqual(hides, [1]);
      assert.deepStrictEqual(log.state().effects.get(hiddenKey(1)), {
        comment: 1,
        hidden: 'outdated',
      });
      finished([passed('ci/test'), passed('ci/late')], fixed);
      assert.deepStrictEqual(await post(effects), ['brief.2']);
      assert.deepStrictEqual(await post(effects), []);
      assert.deepStrictEqual(hides, [1]);
      assert.equal(comments.length, 2);
    });

    it("hides the brief once when a person pushed to the pull request's branch", async () => {
      nip();
      const { host, hides } = fakeHost();
      const effects = effectsOf(host);
      finished([passed('ci/test')]);
      assert.deepStrictEqual(await post(effects), ['brief.1']);
      baseChecked({ branchMoved: 'e'.repeat(40) });
      assert.deepStrictEqual(await post(effects), ['brief.1.hidden']);
      assert.deepStrictEqual(await post(effects), []);
      assert.deepStrictEqual(hides, [1]);
    });

    it('hides nothing while a record of the same head goes pending or fails (regression test)', async () => {
      nip();
      const { host, hides } = fakeHost();
      const effects = effectsOf(host);
      finished([passed('ci/test')]);
      assert.deepStrictEqual(await post(effects), ['brief.1']);
      pending();
      assert.deepStrictEqual(await post(effects), []);
      finished([failed('ci/test')]);
      assert.deepStrictEqual(await post(effects), []);
      // A re-run passes it again: the very brief still holds.
      finished([passed('ci/test')]);
      assert.deepStrictEqual(await post(effects), []);
      assert.deepStrictEqual(hides, []);
    });

    for (const end of ['merged', 'closed'] as const) {
      it(`leaves the brief of a pull request that ${end} as it is (regression test)`, async () => {
        nip();
        const { host, hides } = fakeHost();
        const effects = effectsOf(host);
        finished([passed('ci/test')]);
        assert.deepStrictEqual(await post(effects), ['brief.1']);
        accept({
          kind: 'record',
          event: { type: 'pull_request.ended', batchId: 'web-7', pullRequest: url, state: end },
        });
        // Even a push the ledger recorded after the end hides nothing.
        ledger(pushKey('web-7', 2), {
          branch: 'foedrum/web-7/acme.web',
          commit: fixed,
          from: 'start',
        });
        assert.deepStrictEqual(await post(effects), []);
        assert.deepStrictEqual(hides, []);
      });
    }

    it('hides an earlier brief of the same head once a later record posted its own', async () => {
      nip();
      const { host, hides } = fakeHost();
      const effects = effectsOf(host);
      finished([passed('ci/test')]);
      assert.deepStrictEqual(await post(effects), ['brief.1']);
      pending();
      finished([passed('ci/test'), passed('ci/late')]);
      assert.deepStrictEqual(await post(effects), ['brief.2']);
      assert.deepStrictEqual(await post(effects), ['brief.1.hidden']);
      assert.deepStrictEqual(await post(effects), []);
      assert.deepStrictEqual(hides, [1]);
    });

    it('records a brief a person deleted as gone, and never asks again', async () => {
      nip();
      const { host, comments, hides } = fakeHost();
      const effects = effectsOf(host);
      finished([passed('ci/test')]);
      assert.deepStrictEqual(await post(effects), ['brief.1']);
      comments.splice(0);
      baseChecked({ branchMoved: 'e'.repeat(40) });
      assert.deepStrictEqual(await post(effects), ['brief.1.hidden']);
      assert.deepStrictEqual(log.state().effects.get(hiddenKey(1)), { comment: 1, gone: true });
      assert.deepStrictEqual(await post(effects), []);
      assert.deepStrictEqual(hides, []);
    });

    it('hides once when a driver was killed between the hide and its record', async () => {
      nip();
      const { host, hides } = fakeHost();
      finished([passed('ci/test')]);
      assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1']);
      fixRound();
      const killed = effectsOf(host);
      const [key] = killed.due(log.state(), 'web-7');
      assert.ok(key !== undefined);
      assert.equal(key.effect, 'brief.1.hidden');
      await killed.target.apply(effectKey.encode(key));
      // A new driver finds it hidden.
      assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1.hidden']);
      assert.deepStrictEqual(hides, [1]);
      assert.deepStrictEqual(log.state().effects.get(hiddenKey(1)), {
        comment: 1,
        hidden: 'outdated',
      });
    });

    it('neither hides twice nor posts twice when a driver was killed between the hide and the next post', async () => {
      nip();
      const { host, comments, hides } = fakeHost();
      finished([passed('ci/test')]);
      assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1']);
      fixRound();
      finished([passed('ci/test'), passed('ci/late')], fixed);
      const killed = effectsOf(host);
      const keys = killed.due(log.state(), 'web-7');
      assert.deepStrictEqual(
        keys.map(({ effect }) => effect),
        ['brief.1.hidden', 'brief.2'],
      );
      const [hide, next] = keys;
      assert.ok(hide !== undefined && next !== undefined);
      ledger(hide, await killed.target.apply(effectKey.encode(hide)));
      // Killed after the post reached the pull request, before its ledger entry.
      await killed.target.apply(effectKey.encode(next));
      assert.deepStrictEqual(await post(effectsOf(host)), ['brief.2']);
      assert.deepStrictEqual(await post(effectsOf(host)), []);
      assert.deepStrictEqual(hides, [1]);
      assert.equal(comments.length, 2);
    });

    it('posts a new brief, never taking a hidden one as current, when a later round pushes the first head again', async () => {
      nip();
      const { host, comments } = fakeHost();
      const effects = effectsOf(host);
      finished([passed('ci/test'), passed('ci/late')]);
      assert.deepStrictEqual(await post(effects), ['brief.1']);
      // Round 2 moves the head, which hides brief 1; round 3 pushes the first head again.
      fixRound(2, fixed, head);
      assert.deepStrictEqual(await post(effects), ['brief.1.hidden']);
      fixRound(3, head, fixed);
      finished([passed('ci/test'), passed('ci/late')]);
      assert.deepStrictEqual(await post(effects), ['brief.2']);
      assert.equal(comments.length, 2);
    });
  });

  describe('the status comment', () => {
    /** The status comment's text now, as its first revision would show it. */
    const statusText = async (): Promise<string> => {
      const bodies: string[] = [];
      const comments: StatusComments = {
        find: async () => undefined,
        read: async () => undefined,
        create: async (_repo, _issue, body) => {
          bodies.push(body);
          return 1;
        },
        edit: async () => 'gone',
      };
      const effects = statusEffects({
        brewery: 'acme/brewery',
        comments,
        recipes,
        clock: () => now,
      });
      const [key] = effects.due(log.state(), 'web-7');
      assert.ok(key);
      await effects.target.apply(effectKey.encode(key));
      return bodies[0] ?? '';
    };

    it('links the latest brief while it is of the latest record', async () => {
      nip();
      finished([passed('ci/build')]);
      await post(effectsOf(fakeHost().host));
      assert.ok(
        (await statusText()).includes(
          `- <${url}> is ready to merge on \`aaaaaaaa\`: <${url}#issuecomment-1>`,
        ),
      );
      pending();
      assert.doesNotMatch(await statusText(), /is ready to merge/);
    });

    it('links no brief once a later record is ready and its brief is not posted yet (regression test)', async () => {
      nip();
      finished([passed('ci/build')]);
      assert.deepStrictEqual(await post(effectsOf(fakeHost().host)), ['brief.1']);
      assert.match(await statusText(), /is ready to merge/);
      pending();
      finished([passed('ci/build'), passed('ci/late')]);
      assert.doesNotMatch(await statusText(), /is ready to merge/);
    });

    it('links the brief of a later head ready with the same checks (regression test)', async () => {
      nip();
      const { host } = fakeHost();
      finished([passed('ci/test')]);
      assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1']);
      // A re-run fails it, and the fix round's head passes the very same check.
      pending();
      finished([failed('ci/test')]);
      accept({
        kind: 'fix_pull_request',
        batchId: 'web-7',
        pullRequest: url,
        head,
        cause: { kind: 'checks' },
      });
      nipFromImplement(2, fixed);
      finished([passed('ci/test')], fixed);
      assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1.hidden', 'brief.2']);
      assert.ok(
        (await statusText()).includes(`is ready to merge on \`ffffffff\`: <${url}#issuecomment-2>`),
      );
    });

    it('says the open pull request has no merge brief while none is current (ADR 0229)', async () => {
      nip();
      const notReady = `- <${url}> is not ready to merge yet: no merge brief.`;
      // Its checks are pending.
      pending();
      assert.ok((await statusText()).includes(notReady));
      const { host } = fakeHost();
      finished([passed('ci/test')]);
      assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1']);
      assert.doesNotMatch(await statusText(), /not ready to merge/);
      // A fix round moves the head: brief 1 is hidden, and never linked again.
      pending();
      finished([passed('ci/test'), failed('ci/late')]);
      accept({
        kind: 'fix_pull_request',
        batchId: 'web-7',
        pullRequest: url,
        head,
        cause: { kind: 'checks' },
      });
      nipFromImplement(2, fixed);
      assert.deepStrictEqual(await post(effectsOf(host)), ['brief.1.hidden']);
      const moved = await statusText();
      assert.ok(moved.includes(notReady));
      assert.doesNotMatch(moved, /issuecomment-1/);
      finished([passed('ci/test'), passed('ci/late')], fixed);
      assert.deepStrictEqual(await post(effectsOf(host)), ['brief.2']);
      const ready = await statusText();
      assert.ok(ready.includes(`is ready to merge on \`ffffffff\`: <${url}#issuecomment-2>`));
      assert.doesNotMatch(ready, /not ready to merge/);
    });

    it('says nothing of a brief once its pull request merged (ADR 0229, regression test)', async () => {
      nip();
      accept({
        kind: 'record',
        event: { type: 'pull_request.ended', batchId: 'web-7', pullRequest: url, state: 'merged' },
      });
      assert.doesNotMatch(await statusText(), /merge brief/);
    });
  });

  describe('its limits (regression tests)', () => {
    const blocked = (findings: TastingFinding[]): Ending => ({
      kind: 'blocked',
      blockerKind: 'findings',
      summary: 'Changes asked',
      findings,
    });
    const at = (n: number): TastingFinding => ({
      severity: 'major',
      why: `Finding ${n}`,
      introduced: true,
      file: `src/f${n}.ts`,
    });

    it('lists 30 dispositions and counts the rest', async () => {
      order('lined');
      run('implement');
      run('taste', blocked(Array.from({ length: 31 }, (_, n) => at(n))));
      run('implement', {
        kind: 'succeeded',
        output: {
          status: 'done',
          summary: 'Fixed',
          assumptions: [],
          dispositions: Array.from({ length: 31 }, (_, n) => ({
            file: `src/f${n}.ts`,
            disposition: 'fixed',
          })),
        },
      });
      run('taste', tasting(), { commit: head });
      open();
      finished([passed('ci/build')]);
      const body = await brief();
      assert.match(body, /- `taste`: fixed at src\/f29\.ts\n- and 1 more\n/);
      assert.doesNotMatch(body, /src\/f30\.ts/);
    });

    it('lists ten findings a skip left open and counts the rest', async () => {
      order('strict');
      run('implement');
      run('taste', blocked(Array.from({ length: 14 }, (_, n) => at(n))));
      accept({ kind: 'skip', batchId: 'web-7', by: 'ann', via: 'terminal' });
      open();
      finished([passed('ci/build')]);
      const body = await brief();
      assert.match(
        body,
        /left open by a skip: major in src\/f9\.ts: Finding 9\n- `taste`: left open by a skip: and 4 more/,
      );
      assert.doesNotMatch(body, /src\/f10\.ts/);
    });

    it('cuts a brief past its length at a whole line', async () => {
      nip();
      const long = (n: number) =>
        `https://github.com/acme/web/actions/runs/${n}?${'x'.repeat(1_900)}`;
      finished(Array.from({ length: 100 }, (_, n) => passed(`ci/${n}`, long(n))));
      const body = await brief();
      const note = '\n\n… the rest is cut: GitHub keeps comments shorter.';
      assert.ok(body.includes(note));
      const before = body.slice(0, body.indexOf(note));
      assert.match(
        before.slice(before.lastIndexOf('\n') + 1),
        /^- ✅ ci\/\d+ \(success\) <https:.*x>$/,
      );
      assert.ok(body.length < 65_536);
    });
  });

  describe('the steps that did not pass (regression tests)', () => {
    it('says a step a person skipped after it failed, with its attempt', async () => {
      order('late');
      run('implement');
      run('taste', tasting(), { commit: head });
      run('fix', { kind: 'failed', retryable: true, reason: 'boom' });
      run('fix', { kind: 'failed', retryable: true, reason: 'boom' });
      assert.equal(batch().lane.kind, 'stuck');
      accept({ kind: 'skip', batchId: 'web-7', by: 'ann', via: 'terminal' });
      open();
      finished([passed('ci/build')]);
      assert.match(
        await brief(),
        /- `fix`: did not pass: its attempt 2 failed, and a person's skip went past it\./,
      );
    });

    it('says no Taster tasted a change of a recipe without one', async () => {
      order('bare');
      run('implement');
      open();
      finished([passed('ci/build')]);
      const body = await brief();
      assert.match(body, /- No Taster tasted this change\./);
      assert.match(body, /\*\*Findings\*\*\nNo finding was recorded\./);
    });
  });
});
