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

/** A code host of one pull request, its title `title`, that keeps the comments made on it. */
const fakeHost = (title = 'Add a --json flag') => {
  const comments: { id: number; body: string }[] = [];
  const host: MergeBriefHost = {
    find: async (_repo, _number, marker) => comments.find(({ body }) => body.endsWith(marker)),
    create: async (_repo, _number, body) => {
      comments.push({ id: comments.length + 1, body });
      return comments.length;
    },
    title: async () => title,
  };
  return { host, comments };
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
      assert.ok(comment.body.endsWith(`\n\n${marker}`));
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
      assert.deepStrictEqual(await post(effects), ['brief.2']);
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
      const text = body.slice(0, body.lastIndexOf('<!-- foedrum:'));
      assert.doesNotMatch(text, /closes #3/i);
      assert.doesNotMatch(text, /@ann/);
      assert.doesNotMatch(text, /<!--/);
      assert.doesNotMatch(text, /\*\*bold\*\*/);
      assert.doesNotMatch(text, /\]\(https/);
      assert.ok(!text.includes(secret));
      assert.match(text, /\[left out: a text of step taste that looks like a secret\]/);
    });

    it("escapes the pull request's title, which anyone with write access chose", async () => {
      nip();
      finished([passed('ci/build')]);
      const { host, comments } = fakeHost('Fix @ann <!-- x --> **now**');
      await post(effectsOf(host));
      const title = comments[0]?.body.split('\n')[0] ?? '';
      assert.equal(title, '### Merge? Fix &#64;ann &lt;!-- x --&gt; \\*\\*now\\*\\* @ `aaaaaaaa`');
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
  });
});
