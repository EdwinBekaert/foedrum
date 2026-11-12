// `foedrum serve`'s shell (ADR 0063): it takes the Cellar's lock, opens the store and the state
// branch, each repository's attempt worktrees and the driver, ticks it until Ctrl+C, and closes it
// all again. An in-memory store, fake worktrees, a fake GitHub and a runner that asks for the plan
// and ends each attempt itself; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import {
  formatIntakeNotice,
  formatNotice,
  type LiveTerminal,
  runServe,
  type ServeShell,
} from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import type { AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { DriverRunningError } from '../../src/engine/driver-lock.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { Git } from '../../src/workspace/git.ts';
import { testGuidance } from '../helpers/brewery-files.ts';
import {
  type FakeApiReview,
  fakeGitHubApi,
  type Instead,
  pullNode,
} from '../helpers/fake-github-api.ts';
import { FAKE_COMMIT, type FakeWorktrees, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { brewer, clone, config, local, recipe, serveInputs } from '../helpers/serve-brewery.ts';
import { serveFixture, t0 } from '../helpers/serve-fixture.ts';

describe('runServe', () => {
  const f = serveFixture();
  const { shell, types } = f;

  it('pushes the bottle branch and opens one pull request for a recipe that ends with openPullRequest (ADR 0071)', async () => {
    const porter = JSON.stringify({
      name: 'porter',
      type: 'brew',
      description: 'Brews an order in one step and opens its pull request.',
      guidance: testGuidance,
      steps: [{ id: 'brew', brewer: 'cellarman' }, { action: 'openPullRequest' }],
      testFirst: false,
    });
    const result = serveSetup(
      serveInputs({
        files: {
          ...serveInputs().files,
          local: local({ workRoot: f.dir.path }),
          brewery: {
            recipes: [
              { path: 'recipes/stout.jsonc', text: recipe },
              { path: 'recipes/porter.jsonc', text: porter },
            ],
            brewers: [{ path: 'brewers/cellarman.md', text: brewer }],
          },
        },
      }),
    );
    f.setup = result.kind === 'ready' ? result.setup : assert.fail();
    // Serve closes its store at the end; the test reads it after.
    const inner = openSqliteEventStore(':memory:');
    f.store = { ...inner, close: () => {} };
    const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log.issue(
      { kind: 'route', batchId: '12-1', recipe: 'porter', reason: 'label', source: 'label' },
      t0,
    );
    const github = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: [], author: 'ann', title: 'Add a --json flag', body: 'Please.' },
        ],
      },
    });
    assert.equal(await runServe(f.setup, shell({ fetch: github.fetch })), 0);
    const branch = 'foedrum/acme.brewery/12-1/acme.web';
    assert.deepStrictEqual(f.pushes, [`acme/web ${FAKE_COMMIT} ${branch}`]);
    assert.deepStrictEqual(
      github.pulls.map(({ repo, head, base, title }) => ({ repo, head, base, title })),
      [{ repo: 'acme/web', head: branch, base: 'main', title: 'Add a --json flag' }],
    );
    assert.match(
      github.pulls[0]?.body ?? '',
      /brew: Brewed[\s\S]*\n<\/details>\n\n<!-- foedrum:\[[^\]]*\] sha256:[0-9a-f]{16} -->$/,
    );
    const [pull] = github.pulls;
    assert.deepStrictEqual(
      createCommandLog({ store: f.store, recipes: f.setup.recipes }).state().batches.get('12-1')
        ?.lane,
      { kind: 'on_tap', pullRequests: [`https://github.com/acme/web/pull/${pull?.number}`] },
    );
  });

  it('the Cellarman brews in a recipe with no gauge step', async () => {
    // Foedrum's own Cellarman, whose tests input names step:gauge (#774).
    const porter = JSON.stringify({
      name: 'porter',
      type: 'brew',
      description: 'The Cellarman, then the pull request, with no Gauger.',
      guidance: testGuidance,
      steps: [{ id: 'implement', brewer: 'cellarman' }, { action: 'openPullRequest' }],
      testFirst: false,
    });
    const result = serveSetup(
      serveInputs({
        files: {
          ...serveInputs().files,
          local: local({ workRoot: f.dir.path }),
          // No brewers/ of its own: a folder that does not exist has none, so the defaults load.
          brewery: {
            ...readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')),
            recipes: [{ path: 'recipes/porter.jsonc', text: porter }],
          },
        },
      }),
    );
    f.setup = result.kind === 'ready' ? result.setup : assert.fail();
    const inner = openSqliteEventStore(':memory:');
    f.store = { ...inner, close: () => {} };
    const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log.issue(
      { kind: 'route', batchId: '12-1', recipe: 'porter', reason: 'label', source: 'label' },
      t0,
    );
    // The Cellarman's guards read its change with git: here it changed nothing they refuse.
    const git = async () => ({ code: 0, stdout: '', stderr: '' });
    assert.equal(await runServe(f.setup, shell({ git })), 0);
    const lane = createCommandLog({ store: f.store, recipes: f.setup.recipes })
      .state()
      .batches.get('12-1')?.lane;
    assert.equal(lane?.kind, 'on_tap', JSON.stringify(lane));
    assert.equal(f.plans.length, 1);
    // Its order is an input, named as each input is; its tests from no gauge step are none.
    assert.match(f.plans[0]?.prompt ?? '', /name="order"/);
    assert.doesNotMatch(f.plans[0]?.prompt ?? '', /name="tests"/);
  });

  it("records the sensitive files the push of a repository's pull request touches (ADR 0201)", async () => {
    const porter = JSON.stringify({
      name: 'porter',
      type: 'brew',
      description: 'Brews an order in one step and opens its pull request.',
      guidance: testGuidance,
      steps: [{ id: 'brew', brewer: 'cellarman' }, { action: 'openPullRequest' }],
      testFirst: false,
    });
    const result = serveSetup(
      serveInputs({
        files: {
          ...serveInputs().files,
          config: config({}, { sensitivePaths: ['src/auth/**'] }),
          local: local({ workRoot: f.dir.path }),
          brewery: {
            recipes: [
              { path: 'recipes/stout.jsonc', text: recipe },
              { path: 'recipes/porter.jsonc', text: porter },
            ],
            brewers: [{ path: 'brewers/cellarman.md', text: brewer }],
          },
        },
      }),
    );
    f.setup = result.kind === 'ready' ? result.setup : assert.fail();
    const inner = openSqliteEventStore(':memory:');
    f.store = { ...inner, close: () => {} };
    const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log.issue(
      { kind: 'route', batchId: '12-1', recipe: 'porter', reason: 'label', source: 'label' },
      t0,
    );
    const github = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: [], author: 'ann', title: 'Add a --json flag', body: 'Please.' },
        ],
      },
    });
    const push = (repository: { repo: string }) => ({
      commit: async () => FAKE_COMMIT,
      baseTip: async () => 'b'.repeat(40),
      isAncestor: async (commit: string, of: string) => commit === of,
      remoteTip: async () => undefined,
      push: async (commit: string, branch: string) => {
        f.pushes.push(`${repository.repo} ${commit} ${branch}`);
      },
      secretScan: async () => [],
      touchedFiles: async () => ['README.md', 'src/auth/login.ts'],
      fileAt: async () => undefined,
    });
    assert.equal(await runServe(f.setup, shell({ fetch: github.fetch, push })), 0);
    const pushed =
      f.store.findEffect({ batchId: '12-1', effect: 'push' }) ?? assert.fail('no push');
    assert.deepStrictEqual((pushed.result as { sensitive?: unknown }).sensitive, {
      count: 1,
      files: ['src/auth/login.ts'],
    });
  });

  /**
   * Brews 12-1 with the porter recipe until its pull request is open, for a repository with
   * `repository`'s fields in foedrum.jsonc and the Brewery's `testMaps`, a push whose change touches
   * the test map, and `git`: the push's recorded sensitive files, and what git was asked.
   */
  const pushTouchingTheMap = async (
    repository: Record<string, unknown>,
    testMaps: { path: string; text: string }[],
    git: Git,
  ) => {
    const porter = JSON.stringify({
      name: 'porter',
      type: 'brew',
      description: 'Brews an order in one step and opens its pull request.',
      guidance: testGuidance,
      steps: [{ id: 'brew', brewer: 'cellarman' }, { action: 'openPullRequest' }],
      testFirst: false,
    });
    const result = serveSetup(
      serveInputs({
        files: {
          ...serveInputs().files,
          config: config({}, repository),
          local: local({ workRoot: f.dir.path }),
          brewery: {
            recipes: [
              { path: 'recipes/stout.jsonc', text: recipe },
              { path: 'recipes/porter.jsonc', text: porter },
            ],
            brewers: [{ path: 'brewers/cellarman.md', text: brewer }],
          },
          testMaps,
        },
      }),
    );
    f.setup = result.kind === 'ready' ? result.setup : assert.fail();
    const inner = openSqliteEventStore(':memory:');
    f.store = { ...inner, close: () => {} };
    const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log.issue(
      { kind: 'route', batchId: '12-1', recipe: 'porter', reason: 'label', source: 'label' },
      t0,
    );
    const github = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: [], author: 'ann', title: 'Add a --json flag', body: 'Please.' },
        ],
      },
    });
    const push = () => ({
      commit: async () => FAKE_COMMIT,
      baseTip: async () => 'b'.repeat(40),
      isAncestor: async (commit: string, of: string) => commit === of,
      remoteTip: async () => undefined,
      push: async () => {},
      secretScan: async () => [],
      touchedFiles: async () => ['README.md', '.foedrum/test-map.jsonc'],
      fileAt: async () => undefined,
    });
    assert.equal(await runServe(f.setup, shell({ fetch: github.fetch, push, git })), 0);
    const pushed =
      f.store.findEffect({ batchId: '12-1', effect: 'push' }) ?? assert.fail('no push');
    return (pushed.result as { sensitive?: unknown }).sensitive;
  };

  const engine = JSON.stringify({
    derivedFrom: { globs: ['**/Cargo.toml'], paths: ['Cargo.toml'] },
    modules: [
      {
        name: 'engine',
        code: ['src/**'],
        tests: { inline: true },
        testReport: { format: 'junit', path: 'junit.xml' },
        coverage: 'none',
      },
    ],
  });

  it('records the test map as a sensitive file of the push, with the modules its change adds unmeasured: regression test', async () => {
    const blob = 'e'.repeat(40);
    // The change starts and ends at one commit here: the first read is the base's, with no map.
    let lists = 0;
    const git: Git = async (_cwd, args) => {
      if (args[0] === 'ls-tree') {
        lists += 1;
        const stdout = lists === 1 ? '' : `100644 blob ${blob}\t.foedrum/test-map.jsonc\0`;
        return { code: 0, stdout, stderr: '' };
      }
      if (args[0] === 'cat-file' && args[2] === blob) {
        return { code: 0, stdout: engine, stderr: '' };
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    assert.deepStrictEqual(await pushTouchingTheMap({}, [], git), {
      count: 1,
      files: ['.foedrum/test-map.jsonc'],
      unmeasured: ['engine'],
    });
    assert.equal(lists, 2);
  });

  it('names no test map file of a repository whose map the Brewery keeps, nor reads one with git: regression test', async () => {
    const asked: string[] = [];
    const git: Git = async (_cwd, args) => {
      asked.push(args.join(' '));
      throw new Error('no git read of the map');
    };
    const brewery = [{ path: 'test-maps/acme/web.jsonc', text: engine }];
    assert.equal(await pushTouchingTheMap({ testMap: 'brewery' }, brewery, git), undefined);
    assert.deepStrictEqual(asked, []);
  });

  /**
   * Brews 12-1 with the porter recipe until its pull request is open, with a base that moved and a
   * merge-tree that conflicts (ADR 0198), on a git that records what it is asked and answers nothing.
   * With `passed`, the merge-tree is clean and every check on the head passed, until the merge brief
   * is posted (ADR 0225). With `reviewed` too, `bea` is in users, and once the pull request is open
   * she, Foedrum's own login and a stranger each ask for changes on it (ADR 0382).
   */
  const brewWithMovedBase = async (passed = false, reviewed = false) => {
    const porter = JSON.stringify({
      name: 'porter',
      type: 'brew',
      description: 'Brews an order in one step and opens its pull request.',
      guidance: testGuidance,
      // With `passed`, a red proof its `when` skips, which the brief names (ADR 0225).
      steps: [
        { id: 'brew', brewer: 'cellarman' },
        ...(passed
          ? [{ id: 'red', check: 'test', expect: 'fail', of: 'brew', when: 'recipe.testFirst' }]
          : []),
        { action: 'openPullRequest' },
      ],
      testFirst: false,
    });
    const result = serveSetup(
      serveInputs({
        files: {
          ...serveInputs().files,
          ...(reviewed ? { config: config({ users: ['ann', 'bea'] }) } : {}),
          local: local({ workRoot: f.dir.path }),
          brewery: {
            recipes: [
              { path: 'recipes/stout.jsonc', text: recipe },
              { path: 'recipes/porter.jsonc', text: porter },
            ],
            brewers: [{ path: 'brewers/cellarman.md', text: brewer }],
          },
        },
      }),
    );
    const ready = result.kind === 'ready' ? result.setup : assert.fail();
    // A pass at every tick, so one sees the batch on tap.
    f.setup = { ...ready, intake: { ...ready.intake, pollEveryMs: 0 } };
    const inner = openSqliteEventStore(':memory:');
    f.store = { ...inner, close: () => {} };
    const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log.issue(
      { kind: 'route', batchId: '12-1', recipe: 'porter', reason: 'label', source: 'label' },
      t0,
    );
    // The head of the pull request and the one check on it, which passed (ADR 0213).
    const checks = (_method: string, url: URL): Instead | undefined => {
      if (!passed) return undefined;
      if (/^\/repos\/acme\/web\/pulls\/\d+$/.test(url.pathname)) {
        return { status: 200, body: { state: 'open', head: { sha: FAKE_COMMIT } } };
      }
      if (url.pathname.endsWith(`/commits/${FAKE_COMMIT}/check-runs`)) {
        const run = { name: 'ci', status: 'completed', conclusion: 'success', html_url: null };
        return { status: 200, body: { total_count: 1, check_runs: [run] } };
      }
      if (url.pathname.endsWith(`/commits/${FAKE_COMMIT}/status`)) {
        return { status: 200, body: { statuses: [] } };
      }
      return undefined;
    };
    const github = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: [], author: 'ann', title: 'Add a --json flag', body: 'Please.' },
        ],
      },
      instead: checks,
    });
    const merged: string[] = [];
    // The pull request's comments that carry the merge brief's marker.
    const briefComments = () =>
      [...github.comments.entries()].flatMap(([key, comments]) =>
        comments.filter(({ body }) => body.includes('brief.1')).map(({ body }) => ({ key, body })),
      );
    // The pull request's comments that carry the conflict's marker.
    const conflictComments = () =>
      [...github.comments.entries()].flatMap(([key, comments]) =>
        comments
          .filter(({ body }) => body.includes('base_conflict.1'))
          .map(({ body }) => ({ key, body })),
      );
    const asked: string[] = [];
    let waits = 0;
    const code = await runServe(
      f.setup,
      shell({
        fetch: github.fetch,
        wait: async () => {
          waits++;
          // A person retitles the pull request once it is open: the brief reads its title.
          const [opened] = github.pulls;
          if (passed && opened !== undefined) opened.title = 'Add a --json flag, retitled';
          if (reviewed && opened !== undefined && opened.reviews === undefined) {
            const asks = (id: number, by: string): FakeApiReview => ({
              id,
              by,
              state: 'CHANGES_REQUESTED',
              body: `${by} asks`,
              comments: [],
            });
            for (const [id, by] of [
              [3, 'ann'],
              [4, 'zed'],
              [5, 'Bea'],
            ] as const) {
              github.review('acme/web', opened.number, asks(id, by));
            }
          }
          const done = passed ? briefComments() : conflictComments();
          if (done.length > 0 || waits > 40) f.controller.abort();
        },
        git: async (_cwd, args) => {
          asked.push(args.join(' '));
          throw new Error('no red proof or guarded step runs here');
        },
        // The bottle branch holds what was pushed; the base moved to 'b…' since.
        push: (repository) => ({
          commit: async () => FAKE_COMMIT,
          baseTip: async () => 'b'.repeat(40),
          isAncestor: async (commit, of) => commit === of,
          remoteTip: async () => (f.pushes.length > 0 ? FAKE_COMMIT : undefined),
          push: async (commit, branch) => {
            f.pushes.push(`${repository.repo} ${commit} ${branch}`);
          },
          secretScan: async () => [],
          touchedFiles: async () => [],
          fileAt: async () => undefined,
        }),
        mergeTree: () => async (head, tip) => {
          merged.push(`${head} ${tip}`);
          return passed ? { kind: 'clean' } : { kind: 'conflicts', files: ['src/cli.ts'] };
        },
      }),
    );
    const [pull] = github.pulls;
    const baseChecks = createCommandLog({ store: f.store, recipes: f.setup.recipes })
      .state()
      .batches.get('12-1')?.baseChecks;
    // The reviews each record of them names, as `<id> <by>` (ADR 0382).
    const recorded = f.store
      .eventsAfter(0)
      .flatMap(({ event }) =>
        event.type === 'pull_request.reviews_read'
          ? [event.reviews.map(({ id, by }) => `${id} ${by}`)]
          : [],
      );
    return { code, merged, pull, baseChecks, recorded, conflictComments, briefComments, asked };
  };

  /**
   * Brews 12-1 through mash-in (ADR 0232): the Innkeeper's question was answered with porter, so
   * the batch's steps hold the Innkeeper's attempt beside porter's, which has no such step (#867).
   * With `mash` false the order is routed to porter directly. Every check on its pull request's
   * head passed; serve ticks until the merge brief is posted, and once more.
   */
  const brewMashed = async (mash = true, readyToo = false) => {
    const porter = JSON.stringify({
      name: 'porter',
      type: 'brew',
      description: 'Brews an order in one step and opens its pull request.',
      guidance: testGuidance,
      steps: [{ id: 'brew', brewer: 'cellarman' }, { action: 'openPullRequest' }],
      testFirst: false,
    });
    const result = serveSetup(
      serveInputs({
        files: {
          ...serveInputs().files,
          local: local({ workRoot: f.dir.path }),
          // Foedrum's mash-in and Innkeeper are the defaults'.
          brewery: {
            ...readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')),
            recipes: [{ path: 'recipes/porter.jsonc', text: porter }],
            brewers: [{ path: 'brewers/cellarman.md', text: brewer }],
          },
        },
      }),
    );
    const ready = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    f.setup = { ...ready, intake: { ...ready.intake, pollEveryMs: 0 } };
    const inner = openSqliteEventStore(':memory:');
    f.store = { ...inner, close: () => {} };
    const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
    const accept = (command: Parameters<typeof log.issue>[0]) => {
      const decision = log.issue(command, t0);
      assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    };
    const question = {
      q: 'Which recipe brews #12? Suggested: porter: one small change',
      options: ['porter', 'nip'],
      recommended: 'porter',
      whyBlocking: 'The recipe decides what runs next',
    };
    accept({ kind: 'order', batchId: '12-1', order: { issue: 12 } });
    if (mash) {
      accept({
        kind: 'route',
        batchId: '12-1',
        recipe: 'mash-in',
        reason: 'label',
        source: 'label',
      });
      const innkeep = { batchId: '12-1', stepId: 'innkeep', attempt: 1 };
      accept({ kind: 'record', event: { type: 'step.started', ...innkeep } });
      accept({
        kind: 'finish',
        ...innkeep,
        ending: { kind: 'needs_input', questions: [question] },
      });
      accept({
        kind: 'answer',
        batchId: '12-1',
        by: 'ann',
        via: 'terminal',
        answers: [{ q: question.q, answer: 'porter' }],
      });
    } else {
      accept({
        kind: 'route',
        batchId: '12-1',
        recipe: 'porter',
        reason: 'label',
        source: 'label',
      });
    }
    // The head of the pull request and the one check on it, which passed (ADR 0213).
    const checks = (_method: string, url: URL): Instead | undefined => {
      if (/^\/repos\/acme\/web\/pulls\/\d+$/.test(url.pathname)) {
        // Its draft state as the fake keeps it, which GraphQL changes (ADR 0350).
        const pull = github.pulls.find(({ number }) => url.pathname.endsWith(`/${number}`));
        const drafted =
          pull === undefined ? {} : { draft: pull.draft === true, node_id: pullNode(pull) };
        return { status: 200, body: { state: 'open', ...drafted, head: { sha: FAKE_COMMIT } } };
      }
      if (url.pathname.endsWith(`/commits/${FAKE_COMMIT}/check-runs`)) {
        const run = { name: 'ci', status: 'completed', conclusion: 'success', html_url: null };
        return { status: 200, body: { total_count: 1, check_runs: [run] } };
      }
      if (url.pathname.endsWith(`/commits/${FAKE_COMMIT}/status`)) {
        return { status: 200, body: { statuses: [] } };
      }
      return undefined;
    };
    const github = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: [], author: 'ann', title: 'Add a --json flag', body: 'Please.' },
        ],
      },
      instead: checks,
    });
    const briefComments = () =>
      [...github.comments.values()].flatMap((comments) =>
        comments.filter(({ body }) => body.includes('brief.1')).map(({ body }) => body),
      );
    let waits = 0;
    let doneAt: number | undefined;
    const code = await runServe(
      f.setup,
      shell({
        fetch: github.fetch,
        wait: async () => {
          waits++;
          const done = readyToo ? github.pulls[0]?.draft === false : briefComments().length > 0;
          // One tick more once it is done, which reads the batch with its brief recorded (#871).
          if (done) doneAt ??= waits;
          if ((doneAt !== undefined && waits > doneAt) || waits > 40) f.controller.abort();
        },
        git: async () => {
          throw new Error('no red proof or guarded step runs here');
        },
        push: (repository) => ({
          commit: async () => FAKE_COMMIT,
          baseTip: async () => 'b'.repeat(40),
          isAncestor: async (commit, of) => commit === of,
          remoteTip: async () => (f.pushes.length > 0 ? FAKE_COMMIT : undefined),
          push: async (commit, branch) => {
            f.pushes.push(`${repository.repo} ${commit} ${branch}`);
          },
          secretScan: async () => [],
          touchedFiles: async () => [],
          fileAt: async () => undefined,
        }),
        mergeTree: () => async () => ({ kind: 'clean' }),
      }),
    );
    return { code, briefComments, pulls: github.pulls };
  };

  /** A line that says a batch's effects threw: the tick's, a pass's that went on, or one effect's. */
  const failedRead = (line: string): boolean =>
    line.includes('a tick failed') ||
    line.includes('the other batches go on') ||
    /^foedrum serve: the effect .+ failed: /.test(line);

  it('ticks with no error for a batch mashed to a building recipe that is on tap with finished checks (#867)', async () => {
    const { code, briefComments } = await brewMashed();
    assert.equal(code, 0);
    assert.equal(briefComments().length, 1, f.lines.slice(0, 8).join('\n'));
    const failed = f.lines.filter(failedRead);
    assert.deepStrictEqual(failed.slice(0, 1), [], `${failed.length} lines say a read failed`);
  });

  it('posts the merge brief of a batch mashed to a building recipe through serve (#867)', async () => {
    const { briefComments } = await brewMashed();
    const [brief] = briefComments();
    assert.ok(brief, f.lines.slice(0, 8).join('\n'));
    assert.match(brief, /^### Merge\? Add a --json flag @ `/);
    assert.match(brief, /- ✅ ci \(success\)/);
    assert.doesNotMatch(brief, /`innkeep`: (not run|did not pass)/);
  });

  it('opens the pull request as a draft and marks it ready once its merge brief is posted, through serve (ADR 0350, regression test)', async () => {
    const { code, briefComments, pulls } = await brewMashed(true, true);
    assert.equal(code, 0);
    assert.equal(briefComments().length, 1, f.lines.slice(0, 8).join('\n'));
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0]?.draft, false);
    assert.deepStrictEqual(f.lines.filter(failedRead), []);
  });

  it('posts the merge brief of a batch routed straight to porter through the same wiring (#867, regression test)', async () => {
    const { code, briefComments } = await brewMashed(false);
    assert.equal(code, 0);
    const [brief] = briefComments();
    assert.ok(brief, f.lines.slice(0, 8).join('\n'));
    assert.match(brief, /^### Merge\? Add a --json flag @ `/);
    assert.deepStrictEqual(f.lines.filter(failedRead), []);
  });

  it("checks an open pull request against its base's moved tip and comments the conflict on it (ADR 0198)", async () => {
    const { code, merged, pull, baseChecks, conflictComments, asked } = await brewWithMovedBase();
    assert.equal(code, 0);
    assert.deepStrictEqual(asked, []);
    assert.deepStrictEqual(merged, [`${FAKE_COMMIT} ${'b'.repeat(40)}`]);
    const url = `https://github.com/acme/web/pull/${pull?.number}`;
    assert.deepStrictEqual(baseChecks, [
      {
        pullRequest: url,
        branch: 'main',
        tip: 'b'.repeat(40),
        head: FAKE_COMMIT,
        conflicts: ['src/cli.ts'],
      },
    ]);
    const [comment] = conflictComments();
    assert.ok(comment, f.lines.join('\n'));
    assert.equal(comment?.key, `acme/web#${pull?.number}`);
    assert.match(comment?.body ?? '', /src\/cli\.ts/);
  });

  it('posts the merge brief on a pull request whose checks passed on its head (ADR 0225, regression test)', async () => {
    const { code, pull, briefComments } = await brewWithMovedBase(true);
    assert.equal(code, 0);
    const [brief] = briefComments();
    assert.ok(brief, f.lines.join(String.fromCodePoint(0x0a)));
    assert.equal(brief?.key, `acme/web#${pull?.number}`);
    assert.match(brief?.body ?? '', /^### Merge\? Add a --json flag, retitled @ `/);
    assert.match(brief?.body ?? '', /- ✅ ci \(success\)/);
    assert.match(
      brief?.body ?? '',
      /- Red proof `red`: not run: its when "recipe\.testFirst" was false\./,
    );
  });

  it("records the review of someone in users that asks for changes, never Foedrum's own or a stranger's (ADR 0382)", async () => {
    const { code, pull, recorded } = await brewWithMovedBase(true, true);
    assert.equal(code, 0);
    assert.ok(pull?.reviews !== undefined);
    assert.deepStrictEqual(recorded, [['5 Bea']], f.lines.join(String.fromCodePoint(0x0a)));
  });

  describe('a usage window per family (review of #555, ADR 0215)', () => {
    /** Serves the Brewery with `models` for its models.jsonc, the Opus window closed all day. */
    const servedWhileOpusClosed = async (models: string) => {
      const result = serveSetup(
        serveInputs({
          files: { ...serveInputs().files, local: local({ workRoot: f.dir.path }), models },
        }),
      );
      f.setup = result.kind === 'ready' ? result.setup : assert.fail();
      f.store.withTransaction((tx) =>
        tx.append({
          type: 'usage.window_closed',
          limit: 'Opus',
          resets: '11:55pm',
          reopensAt: '2026-10-18T00:00:00.000Z',
          read: true,
        }),
      );
      assert.equal(await runServe(f.setup, shell()), 0);
    };

    it('starts the cellarman models.jsonc swaps to a Sonnet alias, though its own alias runs Opus', async () => {
      await servedWhileOpusClosed(
        JSON.stringify({
          models: { quick: 'claude-opus-5-5', middle: 'claude-sonnet-5-5' },
          brewers: { cellarman: 'middle' },
        }),
      );
      assert.equal(f.plans.length, 1);
    });

    it('holds the cellarman on Opus', async () => {
      await servedWhileOpusClosed(JSON.stringify({ models: { quick: 'claude-opus-5-5' } }));
      assert.deepStrictEqual(f.plans, []);
    });

    it('starts an attempt by the family of the recipe it was scheduled under, after its batch moved to an Opus one (ADR 0310, regression test)', async () => {
      // Recipe imperial brews the same step with a brewer on Opus.
      const files = serveInputs().files;
      const result = serveSetup(
        serveInputs({
          files: {
            ...files,
            local: local({ workRoot: f.dir.path }),
            models: JSON.stringify({
              models: { quick: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' },
            }),
            brewery: {
              recipes: [
                ...files.brewery.recipes,
                {
                  path: 'recipes/imperial.jsonc',
                  text: recipe.replace('"stout"', '"imperial"').replace('"cellarman"', '"deepman"'),
                },
              ],
              brewers: [
                ...files.brewery.brewers,
                {
                  path: 'brewers/deepman.md',
                  text: brewer
                    .replace('"name": "cellarman"', '"name": "deepman"')
                    .replace('"model": "quick"', '"model": "deep"'),
                },
              ],
            },
          },
        }),
      );
      f.setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
      // brew#1 was scheduled under stout when the batch was routed; a person moves it to imperial
      // before it starts (ADR 0240).
      f.store.withTransaction((tx) => {
        for (const event of [
          {
            type: 'batch.recipe_chosen',
            batchId: '12-1',
            recipe: 'imperial',
            reason: 'a stronger brew',
            source: 'human',
            by: 'ann',
            via: 'terminal',
          },
          {
            type: 'usage.window_closed',
            limit: 'Opus',
            resets: '11:55pm',
            reopensAt: '2026-10-18T00:00:00.000Z',
            read: true,
          },
        ] satisfies Event[]) {
          tx.append(event);
        }
      });
      assert.equal(await runServe(f.setup, shell()), 0, f.lines.join(String.fromCodePoint(0x0a)));
      assert.deepStrictEqual(
        f.plans.map(({ call }) => call.model),
        ['claude-sonnet-5-5'],
      );
    });
  });

  it('keeps its plain lines and never touches a terminal its shell holds (ADR 0174)', async () => {
    const touched: string[] = [];
    const terminal: LiveTerminal = {
      marks: [],
      columns: () => {
        touched.push('columns');
        return 80;
      },
      onResize: () => {
        touched.push('onResize');
        return () => {};
      },
      clear: () => {
        touched.push('clear');
      },
      rewrite: () => {
        touched.push('rewrite');
      },
    };
    assert.equal(await runServe(f.setup, shell({ terminal })), 0);
    assert.deepStrictEqual(touched, []);
    assert.ok(f.lines.length > 0, 'serve printed its lines');
  });

  it('sets the Cellar up in order, brews the order with its text, and stops on Ctrl+C', async () => {
    assert.equal(await runServe(f.setup, shell()), 0);
    assert.deepStrictEqual(f.calls.slice(0, 5), [
      'lock cellar Acme/Brewery true',
      'store true',
      'state branch',
      'worktrees acme/web origin/main',
      'runner /home/brewer/.local/bin/claude',
    ]);
    assert.ok(f.calls.slice(5).every((call) => call === 'wait 5000'));
    assert.deepStrictEqual(types(), [
      'batch.ordered',
      'batch.recipe_chosen',
      'step.scheduled',
      'step.started',
      'step.finished',
      // The openPullRequest action (ADR 0071, ADR 0084).
      'step.scheduled',
      'step.started',
      'step.finished',
      'batch.on_tap',
    ]);
    const [plan] = f.plans;
    assert.match(plan?.prompt ?? '', /Add a --json flag\./);
    assert.equal(plan?.call.model, 'claude-haiku-5-5');
    assert.equal(plan?.cwd, join(f.dir.path, 'acme.web', 'attempts', '12-1', 'brew', '1'));
    assert.equal(plan?.env.npm_config_ignore_scripts, 'true');
    assert.equal(plan?.env.GH_TOKEN, undefined);
    assert.equal(
      plan?.settingsFile,
      join(f.dir.path, 'attempt-settings', '12-1', 'brew', '1.json'),
    );
    // The cellarman produces commits: they are counted on its branch in the local clone its
    // worktree was added to, which the push takes too (ADR 0074, review of #208).
    assert.deepStrictEqual(plan?.commits, { clone, branch: 'foedrum/12-1/brew/1' });
    assert.deepStrictEqual(
      [f.lines[0], f.lines.at(-1)],
      [
        `foedrum serve: brewing for Acme/Brewery in ${f.dir.path}; Ctrl+C stops it`,
        'foedrum serve: stopped',
      ],
    );
    assert.deepStrictEqual([f.lock.held, f.closed], [false, 1]);
    // One status comment on the order's issue, by the token's login, followed up to on tap.
    const status = f.api.comments.get('acme/brewery#12') ?? [];
    assert.equal(status.length, 1, 'one status comment');
    assert.equal(status[0]?.author, 'ann');
    assert.match(status[0]?.body ?? '', /Waiting for you\*\*: merge a pull request/);
    assert.match(status[0]?.body ?? '', /`brew`/);
    // The batch goes on tap within the first tick, so whether an edit came first is the timing's.
    assert.match(status[0]?.body ?? '', /<!-- foedrum:\["12-1","status\.\d+"\] -->$/);
  });

  it('holds the machine awake only while an attempt runs, and lets the hold go when it stops (ADR 0195)', async () => {
    const held: string[] = [];
    const awake = {
      attemptStarted: () => held.push('started'),
      attemptEnded: () => held.push('ended'),
      release: () => held.push('released'),
    };
    assert.equal(await runServe(f.setup, shell({ awake })), 0);
    // The brew step's attempt; the openPullRequest action is no attempt.
    assert.deepStrictEqual(held, ['started', 'ended', 'released']);
  });

  describe('the hold when an attempt fails to start or end (ADR 0195)', () => {
    const recording = () => {
      const held: string[] = [];
      const awake = {
        attemptStarted: () => held.push('started'),
        attemptEnded: () => held.push('ended'),
        release: () => held.push('released'),
      };
      return { held, awake };
    };
    /** Every start is matched by its end before the next, and the hold is let go last. */
    const balanced = (held: readonly string[]) => {
      assert.ok(held.length >= 3, held.join(', '));
      assert.equal(held.at(-1), 'released');
      const pairs = held.slice(0, -1);
      assert.ok(
        pairs.every((entry, index) => entry === (index % 2 === 0 ? 'started' : 'ended')),
        held.join(', '),
      );
    };

    it('ends the attempt the runner could not start', async () => {
      const { held, awake } = recording();
      const broken: BrewerRunner = {
        start: () => {
          throw new Error('the runner broke');
        },
        progress: () => undefined,
      };
      assert.equal(await runServe(f.setup, shell({ runner: () => broken, awake })), 0);
      balanced(held);
    });

    it('ends the attempt whose end rejected', async () => {
      const { held, awake } = recording();
      const broken: BrewerRunner = {
        start: () => ({ ended: Promise.reject(new Error('the runner broke')), stop: () => {} }),
        progress: () => undefined,
      };
      assert.equal(await runServe(f.setup, shell({ runner: () => broken, awake })), 0);
      balanced(held);
    });

    it('lets the hold go when closing its store fails', async () => {
      const { held, awake } = recording();
      const failing = {
        ...f.store,
        close: () => {
          throw new Error('the store did not close');
        },
      };
      await assert.rejects(
        runServe(f.setup, shell({ awake, openStore: () => failing })),
        /the store did not close/,
      );
      assert.equal(held.at(-1), 'released');
    });
  });

  it("posts a plan brewer's plan on its order's issue, its paths checked in the Brewery's repositories (ADR 0233, regression test)", async () => {
    const planner = `---
${JSON.stringify({
  name: 'brewmaster',
  description: 'Plans the order.',
  version: 1,
  inputs: [{ name: 'order', from: 'order' }],
  output: { doc: 'plan.md', schema: 'plan' },
  produces: 'report',
  model: 'quick',
  effort: 'low',
  tools: { allow: ['Read'] },
  access: 'read',
  tree: 'task',
  deadline: '10m',
  maxAttempts: 1,
})}
---
Plan the order in {order}.
`;
    const mash = JSON.stringify({
      name: 'mash',
      type: 'mash',
      description: 'Plans an order.',
      guidance: testGuidance,
      steps: [{ id: 'plan', brewer: 'brewmaster' }],
      testFirst: false,
    });
    const result = serveSetup(
      serveInputs({
        files: {
          ...serveInputs().files,
          local: local({ workRoot: f.dir.path }),
          brewery: {
            recipes: [{ path: 'recipes/mash.jsonc', text: mash }],
            brewers: [{ path: 'brewers/brewmaster.md', text: planner }],
          },
        },
      }),
    );
    f.setup = result.kind === 'ready' ? result.setup : assert.fail();
    const inner = openSqliteEventStore(':memory:');
    f.store = { ...inner, close: () => {} };
    const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, t0);
    log.issue(
      { kind: 'route', batchId: '12-1', recipe: 'mash', reason: 'label', source: 'label' },
      t0,
    );
    const subOrders = [
      {
        id: 'json-flag',
        title: 'A --json flag',
        repo: 'acme/web',
        size: { lines: 120, mechanism: 'one option' },
        doneWhen: 'foedrum --json prints JSON',
        touches: [{ path: 'src/cli.ts' }],
        dependencies: [],
        recipe: 'stout',
        why: 'one change',
        ready: true,
      },
    ];
    const runner = (
      _claude: string,
      plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>,
    ) => ({
      start: (start: AttemptStart) => ({
        ended: plan(start).then((made) => {
          f.plans.push(made);
          const output = { status: 'done', summary: 'Planned', assumptions: [], subOrders };
          return { ending: { kind: 'succeeded', output } } as const;
        }),
        stop: () => {},
      }),
      progress: () => undefined,
    });
    assert.equal(await runServe(f.setup, shell({ runner })), 0);
    assert.deepEqual(
      f.plans[0]?.touches?.map((each) => ({
        repo: each.repo,
        commit: 'commit' in each && each.commit,
      })),
      f.setup.repositories.map(({ repo }) => ({ repo, commit: FAKE_COMMIT })),
    );
    const posted = (f.api.comments.get('acme/brewery#12') ?? []).filter(({ body }) =>
      body.includes('plan.1'),
    );
    assert.equal(posted.length, 1, f.lines.join('\n'));
    assert.match(posted[0]?.body ?? '', /^### Foedrum · plan of batch `12-1`/);
    assert.match(posted[0]?.body ?? '', /\n- Builds in acme\/web: one option, about 120 lines\n/);
  });

  it("opens an approved plan's sub-orders as sub-issues of its order's issue, with their labels (ADR 0285, regression test)", async () => {
    const planner = `---\n${JSON.stringify({
      name: 'brewmaster',
      description: 'Plans the order.',
      version: 1,
      inputs: [{ name: 'order', from: 'order' }],
      output: { doc: 'plan.md', schema: 'plan' },
      produces: 'report',
      model: 'quick',
      effort: 'low',
      tools: { allow: ['Read'] },
      access: 'read',
      tree: 'task',
      deadline: '10m',
      maxAttempts: 1,
    })}\n---\nPlan the order in {order}.\n`;
    const mash = JSON.stringify({
      name: 'mash',
      type: 'mash',
      description: 'Plans an order.',
      guidance: testGuidance,
      steps: [{ id: 'plan', brewer: 'brewmaster' }],
      testFirst: false,
    });
    const result = serveSetup(
      serveInputs({
        files: {
          ...serveInputs().files,
          local: local({ workRoot: f.dir.path }),
          brewery: {
            recipes: [{ path: 'recipes/mash.jsonc', text: mash }],
            brewers: [{ path: 'brewers/brewmaster.md', text: planner }],
          },
        },
      }),
    );
    f.setup = result.kind === 'ready' ? result.setup : assert.fail();
    const inner = openSqliteEventStore(':memory:');
    f.store = { ...inner, close: () => {} };
    const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
    const accept = (command: Parameters<typeof log.issue>[0]): void =>
      assert.equal(log.issue(command, t0).kind, 'accepted');
    accept({ kind: 'order', batchId: '12-1', order: { issue: 12 } });
    accept({ kind: 'route', batchId: '12-1', recipe: 'mash', reason: 'label', source: 'label' });
    const ref = { batchId: '12-1', stepId: 'plan', attempt: 1 };
    accept({ kind: 'record', event: { type: 'step.started', ...ref } });
    const subOrder = {
      id: 'json-flag',
      title: 'A --json flag',
      repo: 'acme/web',
      size: { lines: 120, mechanism: 'one option' },
      doneWhen: 'foedrum --json prints JSON',
      touches: [{ path: 'src/cli.ts' }],
      dependencies: [],
      recipe: 'stout',
      why: 'one change',
      ready: true,
    };
    const output = { status: 'done', summary: 'Planned', assumptions: [], subOrders: [subOrder] };
    accept({ kind: 'finish', ...ref, ending: { kind: 'succeeded', output } });
    accept({ kind: 'approve', batchId: '12-1', by: 'ann', via: 'terminal' });
    assert.equal(await runServe(f.setup, shell()), 0);
    const opened = f.api.issue('acme/brewery', 15);
    assert.equal(opened?.title, 'A --json flag', f.lines.join('\n'));
    assert.deepStrictEqual(opened?.labels, ['foedrum:sub-order', 'recipe:stout']);
    assert.deepStrictEqual(f.api.issue('acme/brewery', 12)?.subIssues, [15]);
    assert.deepStrictEqual(
      createCommandLog({ store: f.store, recipes: f.setup.recipes }).state().orders.get(12)
        ?.subOrders,
      [15],
    );
    // The sub-issues open before the plan comment is written, which names them in one revision.
    const plan = (f.api.comments.get('acme/brewery#12') ?? []).filter(({ body }) =>
      body.startsWith('### Foedrum · plan of batch'),
    );
    assert.equal(plan.length, 1);
    assert.match(plan[0]?.body ?? '', /\nSub-issues: `json-flag` #15\.\n/);
    assert.notEqual(f.store.findEffect({ batchId: '12-1', effect: 'plan.1' }), undefined);
    assert.equal(f.store.findEffect({ batchId: '12-1', effect: 'plan.2' }), undefined);
  });

  it('keeps the out doc an attempt ended with for the state branch (ADR 0103)', async () => {
    const text = '---\n{"status":"done","summary":"Brewed"}\n---\nNotes.\n';
    const runner = (): BrewerRunner => ({
      start: () => ({
        ended: Promise.resolve({
          ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
          outDoc: text,
        }),
        stop: () => {},
      }),
      progress: () => undefined,
    });
    assert.equal(await runServe(f.setup, shell({ runner })), 0);
    // The stub state branch never pushes, so the store still keeps it.
    assert.deepStrictEqual(f.store.keptOutDocs(), [
      { batchId: '12-1', stepId: 'brew', attempt: 1, text },
    ]);
  });

  it("records what an attempt's out doc handed over, through serve's own wiring (ADR 0340)", async () => {
    const text = '---\n{"status":"done","summary":"Brewed","handover":["A lesson"]}\n---\nNotes.\n';
    const runner = (): BrewerRunner => ({
      start: () => ({
        ended: Promise.resolve({
          ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
          outDoc: text,
        }),
        stop: () => {},
      }),
      progress: () => undefined,
    });
    assert.equal(await runServe(f.setup, shell({ runner })), 0);
    const finished = f.store
      .eventsAfter(0)
      .map(({ event }) => event)
      .find((event) => event.type === 'step.finished' && event.stepId === 'brew');
    assert.ok(finished?.type === 'step.finished');
    assert.deepStrictEqual(finished.handover, ['A lesson']);
    assert.equal(JSON.stringify(finished.outcome).includes('A lesson'), false);
  });

  it('says in one line when an out doc cannot be kept, and brews on (ADR 0103)', async () => {
    const runner = (): BrewerRunner => ({
      start: () => ({
        ended: Promise.resolve({
          ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
          outDoc: '# Notes\n',
        }),
        stop: () => {},
      }),
      progress: () => undefined,
    });
    const inner = f.store;
    f.store = {
      ...inner,
      withTransaction: (fn) =>
        inner.withTransaction((tx) =>
          fn({
            ...tx,
            keepOutDoc: () => {
              throw new Error('disk full');
            },
          }),
        ),
    };
    assert.equal(await runServe(f.setup, shell({ runner })), 0);
    assert.ok(
      f.lines.includes(
        'foedrum serve: the out doc of 12-1 brew#1 was not kept for the state branch: disk full',
      ),
      f.lines.join('\n'),
    );
    assert.equal(
      createCommandLog({ store: f.store, recipes: f.setup.recipes }).state().batches.get('12-1')
        ?.lane.kind,
      'on_tap',
    );
  });

  it('refuses a second Cellar, opening nothing', async () => {
    const running = new DriverRunningError('cellar', 'drivers/cellar.lock', undefined);
    const code = await runServe(
      f.setup,
      shell({
        lock: () => {
          throw running;
        },
      }),
    );
    assert.equal(code, 1);
    assert.deepStrictEqual(f.calls, []);
    assert.deepStrictEqual(f.lines, [`foedrum serve: ${running.message}`]);
  });

  it('lets the lock go and closes the store when the state branch refuses to start', async () => {
    const code = await runServe(
      f.setup,
      shell({
        stateBranch: () => ({
          start: async () => {
            throw new StateBranchStopError('the branch moved and the store has unpushed events');
          },
          flush: async () => ({ kind: 'unchanged' }),
        }),
      }),
    );
    assert.equal(code, 1);
    assert.deepStrictEqual(f.lines, [
      'foedrum serve: the branch moved and the store has unpushed events',
    ]);
    assert.deepStrictEqual([f.lock.held, f.closed], [false, 1]);
  });

  it("stops when a repository's worktrees cannot be opened", async () => {
    const code = await runServe(
      f.setup,
      shell({
        worktrees: async () => {
          throw new Error('git clone of https://github.com/acme/web.git failed: not found');
        },
      }),
    );
    assert.equal(code, 1);
    assert.deepStrictEqual(f.lines, [
      'foedrum serve: git clone of https://github.com/acme/web.git failed: not found',
    ]);
    assert.deepStrictEqual([f.lock.held, f.closed], [false, 1]);
  });

  it('stops when a tick must stop the engine: another engine pushed the state branch', async () => {
    const code = await runServe(
      f.setup,
      shell({
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () => {
            throw new StateBranchStopError('the push was rejected: another engine wrote');
          },
        }),
      }),
    );
    assert.equal(code, 1);
    assert.equal(f.lines.at(-1), 'foedrum serve: the push was rejected: another engine wrote');
    assert.deepStrictEqual([f.lock.held, f.closed], [false, 1]);
  });

  it("removes an ended batch's attempt settings with its worktrees", async () => {
    assert.equal(await runServe(f.setup, shell()), 0);
    assert.equal(f.plans.length, 1);
    assert.equal(existsSync(join(f.dir.path, 'attempt-settings', '12-1')), false);
  });

  it("lets the cleanup of an ended batch know each attempt's out doc, from its brewer (ADR 0081)", async () => {
    const managers: FakeWorktrees[] = [];
    const worktrees: ServeShell['worktrees'] = async () => {
      const manager = fakeWorktrees({ root: join(f.dir.path, 'acme.web', 'attempts') });
      managers.push(manager);
      return manager;
    };
    assert.equal(await runServe(f.setup, shell({ worktrees })), 0);
    assert.deepStrictEqual(
      managers.flatMap((manager) => manager.cleans()).at(-1)?.claims.outDocs,
      new Map([['12-1/brew/1', 'brew.md']]),
    );
  });

  it("lets the cleanup delete the task tree's branch once the action's push recorded it (ADR 0084)", async () => {
    const managers: FakeWorktrees[] = [];
    const worktrees: ServeShell['worktrees'] = async () => {
      const manager = fakeWorktrees({ root: join(f.dir.path, 'acme.web', 'attempts') });
      managers.push(manager);
      return manager;
    };
    assert.equal(await runServe(f.setup, shell({ worktrees })), 0);
    assert.equal(f.pushes.length, 1);
    assert.deepStrictEqual(
      managers.flatMap((manager) => manager.cleans()).at(-1)?.claims.unpushed,
      new Map(),
    );
  });

  it("gives each brewer its repository's toolchain rules", async () => {
    assert.equal(await runServe(f.setup, shell()), 0);
    assert.ok(f.plans[0]?.permissions.allow.includes('Bash(npm test*)'));
  });

  // ADR 0163: the brewer finds the repository's dependencies in its worktree.
  it("gives each fresh brewer attempt its repository's setup to run before claude", async () => {
    const npmCi = { command: 'npm ci', timeout: '10m' };
    const repositories = f.setup.repositories.map((repository) => ({
      ...repository,
      setup: npmCi,
    }));
    assert.equal(await runServe({ ...f.setup, repositories }, shell()), 0);
    assert.equal(f.plans[0]?.setup?.run.command, 'npm ci');
    assert.equal(f.plans[0]?.setup?.run.timeoutMs, 600_000);
  });

  // ADR 0160: the sandbox hides the logins where serve's environment moved them.
  it('gives each brewer the sandbox and where the environment moves the logins', async () => {
    const configDirs = { GH_CONFIG_DIR: '/srv/gh' };
    assert.equal(await runServe({ ...f.setup, sandbox: true, configDirs }, shell()), 0);
    assert.equal(f.plans[0]?.permissions.sandbox, true);
    assert.deepStrictEqual(f.plans[0]?.permissions.configDirs, configDirs);
  });

  it('keeps ticking after a tick failed for another reason than the state branch', async () => {
    // The heartbeat's reading of a run, which belongs to no pass over the batches (ADR 0328).
    const broken: BrewerRunner = {
      start: () => ({ ended: new Promise(() => {}), stop: () => {} }),
      progress: () => {
        throw new Error('the runner broke');
      },
    };
    assert.equal(await runServe(f.setup, shell({ runner: () => broken })), 0);
    assert.ok(
      f.lines.includes('foedrum serve: a tick failed: the runner broke'),
      f.lines.join('\n'),
    );
    // It went on ticking after the failed tick, until it was stopped.
    assert.ok(f.calls.filter((call) => call === 'wait 5000').length > 1, f.calls.join('\n'));
    assert.equal(f.lines.at(-1), 'foedrum serve: stopped');
  });

  it('prints a run whose end rejected once, as a notice, and no failed tick (#130)', async () => {
    const broken: BrewerRunner = {
      start: () => ({ ended: Promise.reject(new Error('the runner broke')), stop: () => {} }),
      progress: () => undefined,
    };
    assert.equal(await runServe(f.setup, shell({ runner: () => broken })), 0);
    const failed = f.lines.filter((line) =>
      line.endsWith('failed, so it is blocked on its environment: the runner broke'),
    );
    assert.equal(failed.length, 1, f.lines.join('\n'));
    assert.ok(!f.lines.some((line) => line.includes('a tick failed')), f.lines.join('\n'));
    assert.equal(f.lines.at(-1), 'foedrum serve: stopped');
  });

  it("prints the driver's notices, one line each, and goes on", async () => {
    let flushes = 0;
    await runServe(
      f.setup,
      shell({
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () =>
            flushes++ === 0 ? { kind: 'failed', reason: 'no network' } : { kind: 'unchanged' },
        }),
      }),
    );
    assert.ok(
      f.lines.includes('foedrum serve: the state branch was not pushed: no network'),
      f.lines.join('\n'),
    );
    assert.equal(f.lines.at(-1), 'foedrum serve: stopped');
  });

  it('prints a notice with control characters escaped, since a model may have written it', async () => {
    let flushes = 0;
    await runServe(
      f.setup,
      shell({
        stateBranch: () => ({
          start: async () => ({ decision: 'ready' }),
          flush: async () =>
            flushes++ === 0
              ? { kind: 'failed', reason: 'hook said \u001b[2Jhi' }
              : { kind: 'unchanged' },
        }),
      }),
    );
    assert.ok(
      f.lines.includes('foedrum serve: the state branch was not pushed: hook said \\u001b[2Jhi'),
      f.lines.join('\n'),
    );
  });

  it('does not tick once it was stopped before it started', async () => {
    f.controller.abort();
    assert.equal(await runServe(f.setup, shell()), 0);
    assert.deepStrictEqual(types().slice(-1), ['step.scheduled']);
    assert.deepStrictEqual([f.lock.held, f.closed], [false, 1]);
  });

  // gh reads the login at the start, with the stop signal; a stop then ends that call (ADR 0073).
  it('stops with 0, and says so, when it is stopped while it reads its login', async () => {
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/user') {
        f.controller.abort(new Error('stopped by a signal'));
        return new Promise<Response>((_, reject) => {
          if (init?.signal?.aborted === true) reject(init.signal.reason);
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      }
      return f.api.fetch(input, init);
    }) as typeof globalThis.fetch;
    assert.equal(await runServe(f.setup, shell({ fetch })), 0);
    assert.equal(f.lines.at(-1), 'foedrum serve: stopped');
    assert.deepStrictEqual([f.lock.held, f.closed], [false, 1]);
  });

  it('still fails with the reason when its login read fails for another reason after a stop', async () => {
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/user') {
        f.controller.abort(new Error('stopped by a signal'));
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      }
      return f.api.fetch(input, init);
    }) as typeof globalThis.fetch;
    assert.equal(await runServe(f.setup, shell({ fetch })), 1);
    assert.equal(
      f.lines.at(-1),
      'foedrum serve: GitHub answered 401 to the login gh uses: Bad credentials',
    );
  });
});

describe('formatNotice', () => {
  const key = { batchId: '12-1', stepId: 'brew', attempt: 1, effect: 'comment' };
  const command = { kind: 'expire', batchId: '12-1', stepId: 'brew', attempt: 1 } as const;
  it('says what happened in one line for each notice', () => {
    assert.deepStrictEqual(
      [
        formatNotice({ kind: 'refused', command, reason: 'the batch is on tap' }),
        formatNotice({ kind: 'command_failed', command, error: new Error('disk full') }),
        formatNotice({ kind: 'flush_failed', reason: 'no network' }),
        formatNotice({ kind: 'flush_overdue', since: t0 }),
        formatNotice({ kind: 'tick_failed', error: 'boom' }),
        formatNotice({
          kind: 'batch_lost',
          batchId: '12-1',
          holder: { batchId: '12-1', owner: 'session-1', expiresAt: t0 },
        }),
        formatNotice({ kind: 'effect_failed', key, error: new Error('GitHub answered 502') }),
        formatNotice({
          kind: 'run_failed',
          ref: { batchId: '12-1', stepId: 'brew', attempt: 1 },
          error: new Error('the stream reader broke'),
        }),
        formatNotice({
          kind: 'cleaned',
          batchId: '12-1',
          report: {
            done: ['removed worktree 12-1/brew/1'],
            kept: [],
            failed: ['could not clean x: busy'],
          },
        }),
        formatNotice({
          kind: 'cleaned',
          batchId: '12-1',
          report: { done: [], kept: [], failed: [] },
        }),
      ],
      [
        'expire of batch 12-1 was refused: the batch is on tap',
        'expire of batch 12-1 failed: disk full',
        'the state branch was not pushed: no network',
        'the state branch has not been pushed since 2026-10-17T12:00:00.000Z',
        'a tick failed: boom',
        'batch 12-1 is driven by session-1 now',
        `the effect ${JSON.stringify(['12-1', 'brew', 1, 'comment'])} failed: GitHub answered 502`,
        'the run of step brew#1 of batch 12-1 failed, so it is blocked on its environment: the stream reader broke',
        'cleaned batch 12-1: removed 1 worktree; could not clean x: busy',
        'cleaned batch 12-1: nothing to remove',
      ],
    );
  });

  it('names the batch whose effects could not be read, and says the others go on (#867)', () => {
    assert.equal(
      formatNotice({
        kind: 'batch_effects_failed',
        batchId: '12-1',
        error: new Error('Recipe nip has no step innkeep'),
      }),
      'the effects of batch 12-1 could not be read or finished, and the other batches go on: Recipe nip has no step innkeep',
    );
  });

  it('names the batch that threw and the pass it threw in, and says the others go on (ADR 0328)', () => {
    const line = (pass: 'supervisor' | 'runs' | 'drive' | 'cleanup') =>
      formatNotice({ kind: 'batch_failed', batchId: '12-1', pass, error: new Error('boom') });
    assert.equal(
      line('supervisor'),
      'batch 12-1 could not be read by the supervisor, and the other batches go on: boom',
    );
    assert.equal(
      line('runs'),
      'a run of batch 12-1 could not be read or stopped, and the other batches go on: boom',
    );
    assert.equal(
      line('drive'),
      'batch 12-1 could not be driven, and the other batches go on: boom',
    );
    assert.equal(
      line('cleanup'),
      'the worktrees of batch 12-1 could not be cleaned, and the other batches go on: boom',
    );
  });

  it('says of each pass that a batch that failed there recovered (ADR 0328)', () => {
    const line = (pass: 'supervisor' | 'runs' | 'drive' | 'cleanup' | 'effects') =>
      formatNotice({ kind: 'batch_recovered', batchId: '12-1', pass });
    assert.equal(line('supervisor'), 'the supervisor reads batch 12-1 again');
    assert.equal(line('runs'), 'the runs of batch 12-1 read and stop again');
    assert.equal(line('drive'), 'batch 12-1 is driven again');
    assert.equal(line('cleanup'), 'the worktrees of batch 12-1 are cleaned again');
    assert.equal(line('effects'), 'the effects of batch 12-1 read and finish again');
  });

  it('counts one worktree and one branch in the singular (regression test)', () => {
    assert.equal(
      formatNotice({
        kind: 'cleaned',
        batchId: '12-1',
        report: {
          done: ['removed worktree 12-1/brew/1', 'deleted branch foedrum/12-1/brew/1'],
          kept: [],
          failed: [],
        },
      }),
      'cleaned batch 12-1: removed 1 worktree; deleted 1 branch',
    );
  });

  it("counts a cleanup's worktrees and branches, and names what it kept or could not clean (#662)", () => {
    const attempts = ['gauge/1', 'red/1', 'review/1', 'review/2'];
    assert.equal(
      formatNotice({
        kind: 'cleaned',
        batchId: '12-1',
        report: {
          done: [
            ...attempts.map((attempt) => `removed worktree 12-1/${attempt}`),
            ...attempts.slice(0, 3).map((attempt) => `deleted branch foedrum/12-1/${attempt}`),
            'removed batch folder 12-1',
          ],
          kept: ['kept branch foedrum/12-1/review/2: its pull request is open (ADR 0219)'],
          failed: ['could not clean 12-1/x: busy'],
        },
      }),
      'cleaned batch 12-1: removed 4 worktrees; deleted 3 branches; removed batch folder 12-1; kept branch foedrum/12-1/review/2: its pull request is open (ADR 0219); could not clean 12-1/x: busy',
    );
  });

  it('says which attempt a waiting attempt waits for and when its lease expires (#155)', () => {
    assert.equal(
      formatNotice({
        kind: 'waiting_for_lease',
        ref: { batchId: '12-1', stepId: 'brew', attempt: 2 },
        waitsFor: { batchId: '12-1', stepId: 'brew', attempt: 1 },
        expiresAt: t0,
      }),
      'step brew#2 of batch 12-1 waits until the lease of brew#1 is released; it expires at 2026-10-17T12:00:00.000Z unless it is renewed',
    );
  });
});

describe('formatIntakeNotice', () => {
  it('says what the intake did or could not do in one line for each notice (ADR 0068)', () => {
    const command = { kind: 'order', batchId: '12-1', order: { issue: 12 } } as const;
    assert.deepStrictEqual(
      [
        formatIntakeNotice({ kind: 'ordered', repo: 'acme/web', issue: 7, batchId: 'web-7' }),
        formatIntakeNotice({ kind: 'routed', batchId: 'web-7', recipe: 'stout' }),
        formatIntakeNotice({ kind: 'unrouted', batchId: '12-1', reason: 'no recipe pint' }),
        formatIntakeNotice({
          kind: 'held',
          repo: 'acme/web',
          issue: 5,
          reason: 'recipe pint is full',
        }),
        formatIntakeNotice({ kind: 'released', repo: 'acme/lib-core', version: 'v2.4.0' }),
        formatIntakeNotice({ kind: 'taken', repo: 'acme/web', issue: 3, by: 'bob/brewery' }),
        formatIntakeNotice({ kind: 'taken', repo: 'acme/web', issue: 4, by: undefined }),
        formatIntakeNotice({ kind: 'refused', command, reason: 'batch 12-1 exists' }),
        formatIntakeNotice({ kind: 'failed', what: 'listing acme/web', error: new Error('502') }),
      ],
      [
        'ordered acme/web#7 as batch web-7',
        'routed batch web-7 to the recipe stout',
        'batch 12-1 is not routed: no recipe pint',
        'acme/web#5 waits: recipe pint is full',
        'recorded the release v2.4.0 of acme/lib-core',
        'acme/web#3 is claimed by bob/brewery',
        'acme/web#4 is claimed by a ref whose record cannot be read',
        'order of batch 12-1 was refused: batch 12-1 exists',
        'the intake failed listing acme/web: 502',
      ],
    );
  });

  it('says in one line why it does not take an issue whose labels nobody in users added (ADR 0359)', () => {
    const reason = 'the label foedrum was last added by mallory, who is not in users';
    assert.equal(
      formatIntakeNotice({ kind: 'unapproved', repo: 'acme/web', issue: 7, reason }),
      `acme/web#7 is not taken: ${reason}`,
    );
  });
});
