// `foedrum serve`'s shell (ADR 0063): it takes the Cellar's lock, opens the store and the state
// branch, each repository's attempt worktrees and the driver, ticks it until Ctrl+C, and closes it
// all again. An in-memory store, fake worktrees, a fake GitHub and a runner that asks for the plan
// and ends each attempt itself; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
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
import type { EventStore } from '../../src/engine/event-store.ts';
import { pullRequestText } from '../../src/engine/pull-request.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { Git } from '../../src/workspace/git.ts';
import { fakeGitHubApi, type Instead } from '../helpers/fake-github-api.ts';
import { FAKE_COMMIT, type FakeWorktrees, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { brewer, clone, config, local, recipe, serveInputs } from '../helpers/serve-brewery.ts';
import { serveFixture, t0 } from '../helpers/serve-fixture.ts';

describe('runServe', () => {
  const f = serveFixture();
  const { shell, types } = f;

  it('pushes the bottle branch and opens one pull request for a recipe that ends with openPullRequest (ADR 0071)', async () => {
    const porter = JSON.stringify({
      name: 'porter',
      description: 'Brews an order in one step and opens its pull request.',
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
      description: 'The Cellarman, then the pull request, with no Gauger.',
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
      description: 'Brews an order in one step and opens its pull request.',
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
      description: 'Brews an order in one step and opens its pull request.',
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
   * is posted (ADR 0225).
   */
  const brewWithMovedBase = async (passed = false) => {
    const porter = JSON.stringify({
      name: 'porter',
      description: 'Brews an order in one step and opens its pull request.',
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
        return { status: 200, body: { head: { sha: FAKE_COMMIT } } };
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
    return { code, merged, pull, baseChecks, conflictComments, briefComments, asked };
  };

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
    assert.match(status[0]?.body ?? '', /On tap/);
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
      description: 'Plans an order.',
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
      description: 'Plans an order.',
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
    const broken: BrewerRunner = {
      start: () => {
        throw new Error('the runner broke');
      },
      progress: () => undefined,
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

  describe('the intake in its loop (ADR 0068)', () => {
    const target = { alias: 'web', intake: { labels: ['foedrum'] } };
    const intakeSetup = (
      fields: Record<string, unknown> = {},
      web: Record<string, unknown> = {},
    ) => {
      const result = serveSetup(
        serveInputs({
          files: {
            ...serveInputs().files,
            config: config(fields, web),
            local: local({ workRoot: f.dir.path }),
          },
        }),
      );
      assert.equal(
        result.kind,
        'ready',
        result.kind === 'refused' ? result.problems.join('\n') : '',
      );
      return result.kind === 'ready' ? result.setup : assert.fail();
    };
    const brewerySpelled = 'Acme/Brewery';
    const listingOf = (repo: string) => (request: string) =>
      request.startsWith(`GET /repos/${repo}/issues?`);
    let now: number;
    beforeEach(() => {
      now = t0.getTime();
    });
    const state = () => createCommandLog({ store: f.store, recipes: f.setup.recipes }).state();
    const lane = (batchId: string) => state().batches.get(batchId)?.lane.kind;
    /** A clock that moves `stepMs` at every wait; serve stops once `stop` holds, or at 200 waits. */
    const ticking = (stop: () => boolean, stepMs = 5000) => ({
      clock: () => new Date(now),
      wait: async () => {
        f.calls.push('wait');
        now += stepMs;
        // Lets the pass underway go on between ticks, as the real wait does.
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (stop() || f.calls.length > 200) f.controller.abort();
      },
    });
    /** A store with no order in it, which serve closes as it closes the one of beforeEach. */
    const empty = (): EventStore => {
      const inner = openSqliteEventStore(':memory:');
      return {
        ...inner,
        close: () => {
          f.closed++;
        },
      };
    };
    const hanging: BrewerRunner = {
      start: () => ({ ended: new Promise(() => {}), stop: () => {} }),
      progress: () => undefined,
    };

    it("the ordered label is applied before the batch's first attempt starts", async () => {
      f.store = empty();
      f.setup = intakeSetup({ concurrency: 1 });
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            { number: 12, labels: ['recipe:stout'], author: 'ann', body: 'Add it.' },
          ],
        },
      });
      // The first lane label revision when the runner starts the first attempt, which never ends.
      const seen: unknown[] = [];
      const runner: BrewerRunner = {
        start: (start) => {
          seen.push(f.store.findEffect({ batchId: '12-1', effect: 'label.1' }));
          return hanging.start(start);
        },
        progress: () => undefined,
      };
      const started = () => seen.length > 0;
      const ran = await runServe(
        f.setup,
        shell({ fetch: github.fetch, runner: () => runner, ...ticking(started) }),
      );
      assert.equal(ran, 0);
      assert.ok(started(), f.lines.join('\n'));
      // Ordered and routed in one intake pass: the ordered label went on between them.
      assert.ok(
        f.lines.includes('foedrum serve: routed batch 12-1 to the recipe stout'),
        f.lines.join('\n'),
      );
      assert.deepStrictEqual(seen[0], { result: { label: 'foedrum:ordered' } });
    });

    describe('a pass that waits for a tick (ADR 0316)', () => {
      const labelled = () =>
        fakeGitHubApi({
          login: 'ann',
          issues: {
            'acme/brewery': [
              { number: 12, labels: ['recipe:stout'], author: 'ann', body: 'Add it.' },
            ],
          },
        });
      /** Until the pass ordered #12, and so waits for a tick; a hang guard, not a measure. */
      const ordered = async (): Promise<void> => {
        for (let n = 0; n < 2000 && lane('12-1') === undefined; n++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        assert.equal(lane('12-1'), 'ordered');
      };

      it('is let go by a stop, so serve stops: regression test', { timeout: 60_000 }, async () => {
        f.store = empty();
        f.setup = intakeSetup({ concurrency: 1 });
        const github = labelled();
        const ran = await runServe(
          f.setup,
          shell({
            fetch: github.fetch,
            runner: () => hanging,
            // The pass ordered and waits for the next tick, which the stop never starts.
            wait: async () => {
              await ordered();
              f.controller.abort();
            },
          }),
        );
        assert.equal(ran, 0);
        assert.equal(f.lines.at(-1), 'foedrum serve: stopped');
        // Let go, the pass routed its batch.
        assert.equal(lane('12-1'), 'brewing');
      });

      it('is let go by a tick that stops the engine, so serve ends: regression test', {
        timeout: 60_000,
      }, async () => {
        f.store = empty();
        f.setup = intakeSetup({ concurrency: 1 });
        const github = labelled();
        const ran = await runServe(
          f.setup,
          shell({
            fetch: github.fetch,
            runner: () => hanging,
            // The pass begins to wait during this tick, which then throws.
            stateBranch: () => ({
              start: async () => ({ decision: 'ready' }),
              flush: async () => {
                await ordered();
                throw new StateBranchStopError('the push was rejected: another engine wrote');
              },
            }),
          }),
        );
        assert.equal(ran, 1);
        assert.ok(
          f.lines.includes('foedrum serve: the push was rejected: another engine wrote'),
          f.lines.join('\n'),
        );
        assert.equal(f.lock.held, false);
      });

      it('goes on at once when it reaches the wait after the stop', {
        timeout: 60_000,
      }, async () => {
        f.store = empty();
        f.setup = intakeSetup({ concurrency: 1 });
        const github = labelled();
        // The pass's listing of the Brewery's issues answers only once serve is stopping.
        let answer: () => void = () => {};
        const stopping = new Promise<void>((resolve) => {
          answer = resolve;
        });
        const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          if (/^\/repos\/acme\/brewery\/issues$/i.test(new URL(String(input)).pathname)) {
            await stopping;
          }
          return github.fetch(input, init);
        }) as typeof globalThis.fetch;
        const ran = await runServe(
          f.setup,
          shell({
            fetch,
            runner: () => hanging,
            // Ends a pass that waits for the tick no stopped serve starts; never reached otherwise.
            intakeDeadlineMs: 5000,
            wait: async () => {
              f.controller.abort();
              answer();
            },
          }),
        );
        assert.equal(ran, 0);
        assert.ok(
          !f.lines.some((line) => /longer than its deadline/.test(line)),
          f.lines.join('\n'),
        );
        assert.equal(f.lines.at(-1), 'foedrum serve: stopped');
        // It ordered after the stop and routed without waiting for a tick.
        assert.equal(lane('12-1'), 'brewing');
      });
    });

    it('orders and routes a labelled Brewery issue and a claimed target issue, marks the claim and releases it', async () => {
      f.store = empty();
      f.setup = intakeSetup({ concurrency: 2 }, target);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            // The Brewery's own #7, with the target issue's number, which no batch orders.
            { number: 7, labels: [], author: 'bob' },
            { number: 12, labels: ['recipe:stout'], author: 'ann', body: 'Add a --json flag.' },
          ],
          'acme/web': [
            {
              number: 7,
              // Never read for routing: a claimed order is routed by its Brewery issue (ADR 0156).
              labels: ['foedrum', 'recipe:other'],
              author: 'ann',
              title: 'Dark theme',
              body: 'Add a dark theme.',
            },
          ],
        },
        // Each batch's pull request merges at once, so its claim is released (ADR 0084).
        instead: (method, url) =>
          method === 'GET' && /\/pulls\/\d+$/.test(url.pathname)
            ? { status: 200, body: { state: 'closed', merged: true } }
            : undefined,
      });
      // The Brewery issue that is the order of acme/web#7, after the Brewery's own #12 (ADR 0144).
      const order = () => github.issue('acme/brewery', 13);
      const takenOff =
        /^DELETE \/repos\/acme\/brewery\/issues\/13\/labels\/foedrum%3Aawaiting-merge$/i;
      const done = () => {
        // A person labels the Brewery issue once the driver opened it, between two passes; the
        // driver's lane label may already be on it (#413).
        const opened = order();
        if (opened !== undefined && !opened.labels.includes('recipe:stout')) {
          opened.labels.push('recipe:stout');
        }
        return (
          lane('12-1') === 'on_tap' &&
          lane('web-7') === 'on_tap' &&
          github.created.length === 1 &&
          github.refs.size === 0 &&
          github.comments.get('acme/web#7')?.length === 2 &&
          order()?.state === 'closed' &&
          // Its pull request merged: nothing waits on the person, so the label came off.
          github.requests.some((request) => takenOff.test(request))
        );
      };
      assert.equal(await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(done) })), 0);
      assert.ok(done(), f.lines.join('\n'));
      for (const batchId of ['12-1', 'web-7']) {
        assert.deepStrictEqual(state().batches.get(batchId)?.recipe, {
          name: 'stout',
          reason: 'the label recipe:stout',
          source: 'label',
        });
      }
      const claimed = github.issue('acme/web', 7);
      assert.deepStrictEqual(claimed?.assignees, ['ann']);
      // foedrum:claimed was added with the claim and removed with its release.
      assert.deepStrictEqual(claimed?.labels, ['foedrum', 'recipe:other']);
      assert.ok(github.requests.includes('GET /user'));
      for (const line of [
        `ordered ${brewerySpelled}#12 as batch 12-1`,
        'ordered acme/web#7 as batch web-7',
        'routed batch 12-1 to the recipe stout',
        'routed batch web-7 to the recipe stout',
      ]) {
        assert.ok(f.lines.includes(`foedrum serve: ${line}`), `${line}\n${f.lines.join('\n')}`);
      }
      assert.deepStrictEqual(
        f.plans.map(({ prompt }) => /Add a (--json flag|dark theme)/.exec(prompt)?.[0]).sort(),
        ['Add a --json flag', 'Add a dark theme'],
      );
      // One Brewery issue, the title copied and the target issue linked, closed with the release.
      const opened = (github.issues['acme/brewery'] ?? []).filter((each) => each.number > 12);
      assert.deepStrictEqual(
        opened.map(({ number, title, author }) => ({ number, title, author })),
        [{ number: 13, title: 'Dark theme', author: 'ann' }],
      );
      assert.match(order()?.body ?? '', /acme\/web#7/);
      // The Brewery issue shows the claimed batch's lane and its status comment (#413), its lane
      // label off once the pull request merged (#777); the Brewery's #7 and the target issue get
      // neither.
      assert.deepStrictEqual(
        order()?.labels.filter((label) => label.startsWith('foedrum:')),
        [],
      );
      const status = github.comments.get('acme/brewery#13') ?? [];
      assert.equal(status.length, 1, JSON.stringify(status));
      assert.match(status[0]?.body ?? '', /On tap/);
      assert.deepStrictEqual(github.issue('acme/brewery', 7)?.labels, []);
      assert.equal(github.comments.get('acme/brewery#7'), undefined);
      assert.ok(
        (github.comments.get('acme/web#7') ?? []).every(({ body }) => !/status\.\d/.test(body)),
      );
      // The pull request is the target repository's: it closes the target issue and never names
      // the Brewery issue, which is private.
      const web7 = state().batches.get('web-7')?.lane;
      const url = web7?.kind === 'on_tap' ? web7.pullRequests[0] : undefined;
      const pull = github.pulls.find(
        (each) => `https://github.com/${each.repo}/pull/${each.number}` === url,
      );
      assert.match(pull?.body ?? '', /Closes acme\/web#7/);
      assert.doesNotMatch(`${pull?.title}\n${pull?.body}`, /acme\/brewery|#13\b/i);
      assert.equal(lane('13-1'), undefined, 'the intake never orders the Brewery issue');
    });

    it('opens the Brewery issue of a target issue ordered by hand (ADR 0105, ADR 0144)', async () => {
      f.store = empty();
      f.setup = intakeSetup();
      const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
      const order = { issue: 7, repo: 'acme/web' };
      const by = { by: 'ann', via: 'terminal' } as const;
      log.issue({ kind: 'order_again', batchId: 'web-7', order, ...by }, t0);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [],
          'acme/web': [{ number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark theme' }],
        },
      });
      const marked = () =>
        github.comments.get('acme/web#7')?.length === 1 &&
        github.issues['acme/brewery']?.length === 1;
      assert.equal(await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(marked) })), 0);
      assert.ok(marked(), f.lines.join('\n'));
      assert.deepStrictEqual(
        (github.issues['acme/brewery'] ?? []).map(({ number, title }) => ({ number, title })),
        [{ number: 1, title: 'Dark theme' }],
      );
    });

    it("polls every pollEvery, not at every tick, and reads the token's login without a target intake", async () => {
      f.store = empty();
      f.setup = intakeSetup({ concurrency: 2 });
      const github = fakeGitHubApi({ login: 'ann', issues: {} });
      const stop = () => now >= t0.getTime() + 125_000;
      assert.equal(await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(stop) })), 0);
      // At 0, 60 and 120 seconds.
      assert.equal(github.requests.filter(listingOf(brewerySpelled)).length, 3);
      // The status comments count only the Brewery's own comments (ADR 0072).
      assert.equal(github.requests.includes('GET /user'), true);
    });

    it("polls at foedrum.jsonc's pollEvery", async () => {
      f.store = empty();
      f.setup = intakeSetup({ concurrency: 2, pollEvery: '2m' });
      const github = fakeGitHubApi({ login: 'ann', issues: {} });
      const stop = () => now >= t0.getTime() + 245_000;
      assert.equal(await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(stop) })), 0);
      // At 0 and 120 seconds, and 240.
      assert.equal(github.requests.filter(listingOf(brewerySpelled)).length, 3);
    });

    it("times GitHub's rate-limit pause on serve's clock, not the machine's", async () => {
      f.store = empty();
      f.setup = intakeSetup({ concurrency: 2 });
      // Years ahead of the machine's clock: a pause timed by Date.now would last its hour at most.
      const start = Date.parse('2031-01-01T00:00:00.000Z');
      now = start;
      let first = true;
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {},
        instead: (_method, url) => {
          if (!url.pathname.endsWith('/issues') || !first) return undefined;
          first = false;
          const reset = String(Math.floor((start + 180_000) / 1000));
          return {
            status: 403,
            body: { message: 'API rate limit exceeded' },
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
          };
        },
      });
      const stop = () => now >= start + 250_000;
      assert.equal(await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(stop) })), 0);
      // Refused at 0; asked again at 180 and 240 seconds of serve's clock.
      assert.equal(github.requests.filter(listingOf(brewerySpelled)).length, 3);
    });

    it("starts no pass while GitHub's rate limit pauses the token (ADR 0052)", async () => {
      f.store = empty();
      f.setup = intakeSetup({ concurrency: 2 });
      let first = true;
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {},
        instead: (_method, url) => {
          if (!url.pathname.endsWith('/issues') || !first) return undefined;
          first = false;
          const reset = String(Math.floor((t0.getTime() + 180_000) / 1000));
          return {
            status: 403,
            body: { message: 'API rate limit exceeded' },
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
          };
        },
      });
      const stop = () => now >= t0.getTime() + 250_000;
      assert.equal(await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(stop) })), 0);
      // At 0, refused; then not until the reset at 180 seconds, and again at 240.
      assert.equal(github.requests.filter(listingOf(brewerySpelled)).length, 3);
      assert.equal(f.lines.filter((line) => /rate limit/.test(line)).length, 1, f.lines.join('\n'));
    });

    it('ticks on while a slow pass is underway, and the batch leases stay alive', {
      timeout: 10_000,
    }, async () => {
      f.setup = intakeSetup({ concurrency: 2 });
      const github = fakeGitHubApi({ login: 'ann', issues: {} });
      // The Brewery's listing answers only once the test lets it, three ticks after it was asked.
      let release = (): void => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waits = () => f.calls.filter((call) => call === 'wait').length;
      let listedAt: number | undefined;
      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (listingOf(brewerySpelled)(`GET ${url.pathname}${url.search}`)) {
          listedAt ??= waits();
          await released;
        }
        return github.fetch(input, init);
      }) as typeof globalThis.fetch;
      let lease: ReturnType<EventStore['batchLeases']>[number] | undefined;
      let releasedAt: number | undefined;
      const stop = () => {
        if (listedAt !== undefined && releasedAt === undefined && waits() - listedAt >= 3) {
          // Three minutes of ticks into the pass: past half the lease, so only a heartbeat keeps it.
          lease = f.store.batchLeases(new Date(now)).find(({ batchId }) => batchId === '12-1');
          releasedAt = waits();
          release();
        }
        return releasedAt !== undefined && waits() > releasedAt + 1;
      };
      const code = await runServe(
        f.setup,
        shell({ fetch, runner: () => hanging, ...ticking(stop, 60_000) }),
      );
      assert.equal(code, 0);
      assert.ok(releasedAt !== undefined, f.lines.join('\n'));
      assert.equal(lease?.owner, 'cellar');
      assert.ok((lease?.expiresAt.getTime() ?? 0) > now - 60_000, 'renewed during the pass');
      assert.deepStrictEqual(
        f.lines.filter((line) => line.includes('the intake failed')),
        [],
      );
    });

    it('waits for the pass underway before it stops', async () => {
      f.setup = intakeSetup({ concurrency: 2 });
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {},
        instead: (_method, url) => (url.pathname.endsWith('/issues') ? 'hang' : undefined),
      });
      const stop = () => github.requests.some(listingOf(brewerySpelled));
      await runServe(
        f.setup,
        shell({
          fetch: github.fetch,
          runner: () => hanging,
          intakeDeadlineMs: 40,
          ...ticking(stop),
        }),
      );
      const late = f.lines.findIndex((line) => /the intake failed the pass/.test(line));
      assert.ok(
        late !== -1 && late < f.lines.indexOf('foedrum serve: stopped'),
        f.lines.join('\n'),
      );
      assert.deepStrictEqual([f.lock.held, f.closed], [false, 1]);
    });

    it("orders up to foedrum.jsonc's concurrency in one pass", async () => {
      f.store = empty();
      f.setup = intakeSetup({ concurrency: 2 });
      // A recipe the Brewery lacks: both batches stay Ordered, holding their places.
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [12, 13, 14].map((number) => ({
            number,
            labels: ['recipe:pint'],
            author: 'ann',
          })),
        },
      });
      const stop = () => f.calls.filter((call) => call === 'wait').length >= 3;
      await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(stop, 0) }));
      assert.deepStrictEqual([...state().batches.keys()], ['12-1', '13-1']);
    });

    it("holds a new order past foedrum.jsonc's openOrders, and says so once (ADR 0217)", async () => {
      f.store = empty();
      f.setup = intakeSetup({ concurrency: 2, openOrders: 1 });
      // A recipe the Brewery lacks: the batch stays Ordered, its order open.
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [12, 13].map((number) => ({
            number,
            labels: ['recipe:pint'],
            author: 'ann',
          })),
        },
      });
      const stop = () => f.calls.filter((call) => call === 'wait').length >= 3;
      await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(stop, 0) }));
      assert.deepStrictEqual([...state().batches.keys()], ['12-1']);
      const waits = f.lines.filter((line) => line.includes('#13 waits'));
      assert.deepStrictEqual(waits, [
        "foedrum serve: Acme/Brewery#13 waits: 1 order is open, the Brewery's openOrders",
      ]);
    });

    it('holds a second order of a recipe at its own concurrency, read from the recipe file (ADR 0217)', async () => {
      f.store = empty();
      const files = serveInputs().files;
      const limited = JSON.stringify({ ...JSON.parse(recipe), concurrency: 1 });
      const result = serveSetup(
        serveInputs({
          files: {
            ...files,
            config: config({ concurrency: 2 }, {}),
            local: local({ workRoot: f.dir.path }),
            brewery: {
              ...files.brewery,
              recipes: files.brewery.recipes.map((each) =>
                each.path === 'recipes/stout.jsonc' ? { ...each, text: limited } : each,
              ),
            },
          },
        }),
      );
      f.setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [12, 13].map((number) => ({
            number,
            labels: ['recipe:stout'],
            author: 'ann',
          })),
        },
      });
      const stop = () => f.calls.filter((call) => call === 'wait').length >= 3;
      await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(stop, 0) }));
      assert.deepStrictEqual([...state().batches.keys()], ['12-1']);
      const waits = f.lines.filter((line) => line.includes('#13 waits'));
      assert.deepStrictEqual(waits, [
        'foedrum serve: Acme/Brewery#13 waits: recipe stout brews its 1 at once (concurrency)',
      ]);
    });

    it('releases the claim of a claimed batch the store has, though no repository has an intake any more', async () => {
      f.store = empty();
      f.setup = intakeSetup();
      const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
      log.issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      log.issue({ kind: 'cancel', batchId: 'web-7', by: 'ann', via: 'terminal' }, t0);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: { 'acme/web': [{ number: 7, labels: ['foedrum:claimed'], author: 'ann' }] },
      });
      const released = () => github.comments.get('acme/web#7')?.length === 1;
      assert.equal(
        await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(released) })),
        0,
      );
      assert.ok(released(), f.lines.join('\n'));
      assert.ok(github.requests.includes('GET /user'));
      assert.deepStrictEqual(github.issue('acme/web', 7)?.labels, []);
    });

    it("records the release a merged release blocker waits on, through GitHub's API (ADR 0223)", async () => {
      f.store = empty();
      const lib = 'acme/lib-core';
      const merged = 'https://github.com/acme/lib-core/pull/5';
      const routeBy = '2026-10-17T13:00:00.000Z';
      f.store.withTransaction((tx) => {
        for (const event of [
          { type: 'batch.ordered', batchId: '1-1', order: { issue: 1 }, routeBy },
          {
            type: 'order.decomposed',
            batchId: '1-1',
            subOrders: [
              { issue: 2, repo: lib },
              { issue: 3, repo: 'acme/web' },
            ],
            dependencies: [{ subOrder: 3, blockedBy: 2, kind: 'release' }],
          },
          { type: 'batch.on_tap', batchId: '1-1', pullRequests: [] },
          {
            type: 'batch.ordered',
            batchId: '2-1',
            order: { issue: 2 },
            parentBatchId: '1-1',
            routeBy,
          },
          { type: 'batch.on_tap', batchId: '2-1', pullRequests: [merged] },
          { type: 'pull_request.ended', batchId: '2-1', pullRequest: merged, state: 'merged' },
        ] satisfies Event[]) {
          tx.append(event);
        }
      });
      f.setup = intakeSetup({ concurrency: 2 });
      const sha = 'c'.repeat(40);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {},
        instead: (_method, url) => {
          switch (url.pathname) {
            case '/repos/acme/lib-core/releases/latest':
              return {
                status: 200,
                body: { tag_name: 'v1.0.0', published_at: '2026-10-17T11:00:00Z' },
              };
            case '/repos/acme/lib-core/pulls/5':
              return {
                status: 200,
                body: {
                  state: 'closed',
                  merged: true,
                  merged_at: '2026-10-17T10:00:00Z',
                  merge_commit_sha: sha,
                },
              };
            case `/repos/acme/lib-core/compare/v1.0.0...${sha}`:
              return { status: 200, body: { status: 'behind' } };
            default:
              return undefined;
          }
        },
      });
      const recorded = () => state().releases.length > 0;
      assert.equal(
        await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(recorded) })),
        0,
      );
      assert.deepStrictEqual(
        state().releases.map(({ repo, version }) => `${repo} ${version}`),
        [`${lib} v1.0.0`],
      );
      assert.ok(f.lines.includes(`foedrum serve: recorded the release v1.0.0 of ${lib}`));
    });

    it("names an order's other pull request in each sub-order pull request's body, through GitHub's API (ADR 0292)", async () => {
      f.store = empty();
      const routeBy = '2026-10-17T13:00:00.000Z';
      const pulls = {
        '2-1': 'https://github.com/acme/lib-core/pull/7',
        '3-1': 'https://github.com/acme/web/pull/12',
      };
      f.store.withTransaction((tx) => {
        for (const event of [
          { type: 'batch.ordered', batchId: '1-1', order: { issue: 1 }, routeBy },
          {
            type: 'order.decomposed',
            batchId: '1-1',
            subOrders: [
              { issue: 2, repo: 'acme/lib-core' },
              { issue: 3, repo: 'acme/web' },
            ],
            dependencies: [{ subOrder: 3, blockedBy: 2, kind: 'code' }],
          },
          { type: 'batch.on_tap', batchId: '1-1', pullRequests: [] },
          ...Object.entries(pulls).flatMap(([batchId, url]): Event[] => [
            {
              type: 'batch.ordered',
              batchId,
              order: { issue: Number(batchId[0]) },
              parentBatchId: '1-1',
              routeBy,
            },
            {
              type: 'effect.applied',
              key: JSON.stringify([batchId, 'pull_request']),
              result: url,
            },
            { type: 'batch.on_tap', batchId, pullRequests: [url] },
          ]),
        ] satisfies Event[]) {
          tx.append(event);
        }
      });
      // Both repositories listed, so the driver reads whether each is public (ADR 0300).
      const checks = { build: null, typecheck: null, lint: null, format: null, test: 'npm test' };
      const listed = serveSetup(
        serveInputs({
          files: {
            ...serveInputs().files,
            config: config({
              concurrency: 2,
              repositories: { 'acme/web': { checks }, 'acme/lib-core': { checks } },
            }),
            local: local({
              workRoot: f.dir.path,
              clones: { 'acme/web': clone, 'acme/lib-core': clone },
            }),
          },
        }),
      );
      f.setup = listed.kind === 'ready' ? listed.setup : assert.fail(listed.problems.join('\n'));
      const marked = (batchId: string) =>
        pullRequestText({
          title: 'Order',
          closes: { repo: 'acme/brewery', issue: 1 },
          reports: [],
          key: { batchId, effect: 'pull_request' },
        }).body;
      const github = fakeGitHubApi({
        login: 'ann',
        // The status comments of the order and its sub-orders go on their Brewery issues.
        issues: {
          'acme/brewery': [1, 2, 3].map((number) => ({ number, labels: [], author: 'ann' })),
        },
        instead: (method, url) => {
          if (
            method === 'GET' &&
            ['/repos/acme/web', '/repos/acme/lib-core'].includes(url.pathname)
          ) {
            return { status: 200, body: { private: false, visibility: 'public' } };
          }
          const [batchId] =
            Object.entries(pulls).find(
              ([, pull]) =>
                new URL(pull).pathname.replace('/pull/', '/pulls/') ===
                url.pathname.replace('/repos', ''),
            ) ?? [];
          if (batchId === undefined) return undefined;
          return method === 'GET'
            ? { status: 200, body: { state: 'open', body: marked(batchId) } }
            : { status: 200, body: {} };
        },
      });
      // What each PATCH sent, by its path: the body names the other pull request.
      const sent = new Map<string, string>();
      const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        if (init.method === 'PATCH' && typeof init.body === 'string') {
          sent.set(new URL(String(input)).pathname, JSON.parse(init.body).body);
        }
        return github.fetch(input, init);
      }) as typeof globalThis.fetch;
      const patched = () =>
        ['/repos/acme/lib-core/pulls/7', '/repos/acme/web/pulls/12'].every((path) =>
          github.requests.includes(`PATCH ${path}`),
        );
      assert.equal(await runServe(f.setup, shell({ fetch, ...ticking(patched) })), 0);
      assert.ok(patched(), github.requests.join('\n'));
      assert.match(sent.get('/repos/acme/lib-core/pulls/7') ?? '', /acme\/web#12/);
      assert.match(sent.get('/repos/acme/web/pulls/12') ?? '', /acme\/lib-core#7/);
    });

    // Both of the driver's lists of effects carry the close: without a target intake, and with one.
    for (const [named, web] of [
      ['', undefined],
      [', with a target intake', target],
    ] as const) {
      it(`closes a Brewery issue whose batch's pull request merged, with a comment, through GitHub's API (ADR 0296)${named}`, async () => {
        f.store = empty();
        const routeBy = '2026-10-17T13:00:00.000Z';
        const url = 'https://github.com/acme/web/pull/31';
        f.store.withTransaction((tx) => {
          for (const event of [
            { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy },
            { type: 'effect.applied', key: JSON.stringify(['12-1', 'pull_request']), result: url },
            { type: 'batch.on_tap', batchId: '12-1', pullRequests: [url] },
            { type: 'pull_request.ended', batchId: '12-1', pullRequest: url, state: 'merged' },
          ] satisfies Event[]) {
            tx.append(event);
          }
        });
        f.setup = web === undefined ? intakeSetup() : intakeSetup({}, web);
        const github = fakeGitHubApi({
          login: 'ann',
          issues: { 'acme/brewery': [{ number: 12, labels: [], author: 'ann' }] },
        });
        const closed = () => github.issue('acme/brewery', 12)?.state === 'closed';
        assert.equal(
          await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(closed) })),
          0,
        );
        assert.ok(closed(), github.requests.join('\n'));
        const comments = github.comments.get('acme/brewery#12') ?? [];
        assert.ok(
          comments.some(({ body }) => body.startsWith('Merged as acme/web#31; Foedrum closes')),
          JSON.stringify(comments),
        );
      });
    }

    it("stops when it cannot read the token's login for a target intake", async () => {
      f.setup = intakeSetup({}, target);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {},
        instead: (_method, url) =>
          url.pathname === '/user'
            ? { status: 401, body: { message: 'Bad credentials' } }
            : undefined,
      });
      assert.equal(await runServe(f.setup, shell({ fetch: github.fetch })), 1);
      assert.equal(
        f.lines.at(-1),
        'foedrum serve: GitHub answered 401 to the login gh uses: Bad credentials',
      );
      assert.deepStrictEqual([f.lock.held, f.closed], [false, 1]);
    });
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
});
