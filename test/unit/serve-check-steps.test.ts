// A recipe's check steps through `foedrum serve` (ADR 0069): the check runs in the task tree and a
// failing one sends the batch back. An in-memory store, fake worktrees, a fake GitHub and a fake
// check command; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runServe } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import type { WorktreeMerge } from '../../src/engine/base-merge.ts';
import { brewerForcedEnv } from '../../src/engine/brewer-env.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import type { ExecOptions, ExecProcess } from '../../src/platform/processes.ts';
import type { Git } from '../../src/workspace/git.ts';
import { FAKE_COMMIT, fakeWorktreeMerge } from '../helpers/fake-worktrees.ts';
import { clone, config, home, local, serveInputs } from '../helpers/serve-brewery.ts';
import { serveFixture, t0 } from '../helpers/serve-fixture.ts';

describe('runServe', () => {
  const f = serveFixture();
  const { shell } = f;

  describe('a recipe with a check step (ADR 0069)', () => {
    const outsideSandbox =
      'foedrum serve: check steps run outside an OS sandbox on native Windows: their commands can run code a brewer wrote, with network and home-folder access (ADR 0076)';

    it('says at its start, once, that check steps run outside an OS sandbox on native Windows', async () => {
      assert.equal(await runServe({ ...f.setup, unsandboxedChecks: true }, shell()), 0);
      assert.equal(f.lines[1], outsideSandbox);
      assert.equal(f.lines.filter((line) => line === outsideSandbox).length, 1);
    });

    it('says nothing of it where check steps run in the sandbox (ADR 0076)', async () => {
      assert.equal(f.setup.unsandboxedChecks, false);
      assert.equal(await runServe(f.setup, shell()), 0);
      assert.ok(!f.lines.some((line) => line.includes('outside')), f.lines.join('\n'));
    });

    it('says nothing of it when no recipe has a check step', async () => {
      const files = serveInputs().files;
      const stoutOnly = serveSetup(
        serveInputs({
          files: {
            ...files,
            local: local({ workRoot: f.dir.path }),
            brewery: { ...files.brewery, recipes: files.brewery.recipes.slice(0, 1) },
          },
        }),
      );
      assert.ok(stoutOnly.kind === 'ready');
      assert.equal(await runServe({ ...stoutOnly.setup, unsandboxedChecks: true }, shell()), 0);
      assert.ok(!f.lines.includes(outsideSandbox), f.lines.join('\n'));
    });

    // A setup runs before every fresh brewer attempt too, so a recipe without a check step runs
    // it, outside a sandbox on native Windows (ADR 0163).
    it("says at its start, once, that a repository's setup runs outside an OS sandbox on native Windows, with or without a check step", async () => {
      const setupOutside =
        "foedrum serve: acme/web's setup runs outside an OS sandbox on native Windows, before brewer attempts and check steps: it can run code a brewer wrote, with network and home-folder access (ADR 0163)";
      const files = serveInputs().files;
      const withSetup = (recipes: typeof files.brewery.recipes) => {
        const ready = serveSetup(
          serveInputs({
            files: {
              ...files,
              config: config({}, { setup: { command: 'npm ci', timeout: '10m' } }),
              local: local({ workRoot: f.dir.path }),
              brewery: { ...files.brewery, recipes },
            },
          }),
        );
        assert.ok(ready.kind === 'ready');
        return ready.setup;
      };
      const stoutOnly = withSetup(files.brewery.recipes.slice(0, 1));
      assert.equal(await runServe({ ...stoutOnly, unsandboxedChecks: true }, shell()), 0);
      assert.equal(f.lines.filter((line) => line === setupOutside).length, 1, f.lines.join('\n'));
      assert.ok(!f.lines.includes(outsideSandbox), f.lines.join('\n'));
      f.lines.length = 0;
      assert.equal(await runServe(withSetup(files.brewery.recipes), shell()), 0);
      assert.ok(!f.lines.includes(setupOutside), 'in a sandbox it says nothing of it');
    });

    type Call = { file: string; args: readonly string[]; options: ExecOptions };
    /** Serve with a brewer that succeeds and a process runner that answers each check with `code`. */
    const brewWithChecks = async (
      code: number,
      {
        serving = f.setup,
        prepare,
        merge,
        steps = [],
        git,
      }: {
        serving?: ServeSetup;
        prepare?: ExecProcess;
        merge?: WorktreeMerge;
        git?: Git;
        /** What ran, in order: each check's command and its folder, after whatever else wrote here. */
        steps?: string[];
      } = {},
    ) => {
      const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
      log.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
      const route = { kind: 'route', batchId: '13-1', recipe: 'porter', reason: 'label' } as const;
      log.issue({ ...route, source: 'label' }, t0);
      const checks: Call[] = [];
      const exec: ExecProcess = async (file, args, options) => {
        checks.push({ file, args, options });
        steps.push(`${file} in ${options.cwd}`);
        const output = code === 0 ? 'ok 1\n' : 'not ok 1\n';
        return { exitCode: code, stdout: output, stderr: '', output };
      };
      const succeeding: BrewerRunner = {
        start: () => ({
          ended: Promise.resolve({
            ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
          }),
          stop: () => {},
        }),
        progress: () => undefined,
      };
      const code_ = await runServe(
        serving,
        shell({
          runner: () => succeeding,
          exec,
          ...(prepare === undefined ? {} : { setup: prepare }),
          ...(merge === undefined ? {} : { merge: () => merge }),
          ...(git === undefined ? {} : { git }),
          wait: async () => {
            f.calls.push('wait');
            const lane = log.state().batches.get('13-1')?.lane.kind;
            if (lane === 'on_tap' || lane === 'stuck' || f.calls.length > 40) f.controller.abort();
          },
        }),
      );
      assert.equal(code_, 0);
      const events = f.store
        .eventsAfter(0)
        .map(({ event }) => event)
        .filter((event) => 'batchId' in event && event.batchId === '13-1');
      return { checks, events, batch: log.state().batches.get('13-1') };
    };
    const worktreeOf = (attempt: number) =>
      join(f.dir.path, 'acme.web', 'attempts', '13-1', 'green', String(attempt));

    it("merges the base into the check's worktree before its test command runs (ADR 0164)", async () => {
      const steps: string[] = [];
      const clean = fakeWorktreeMerge();
      const merge: WorktreeMerge = {
        ...clean,
        merge: async (path, commit, message) => {
          steps.push(`${path} ${commit}: ${message}`);
          return clean.merge(path, commit, message);
        },
      };
      const { batch } = await brewWithChecks(0, { merge, steps });
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.deepStrictEqual(steps, [
        `${worktreeOf(1)} ${'b'.repeat(40)}: Merge main before green`,
        `npm test in ${worktreeOf(1)}`,
      ]);
      assert.ok(
        f.store
          .eventsAfter(0)
          .some(
            ({ event }) =>
              event.type === 'effect.applied' && event.key === '["13-1","green",1,"merge_base"]',
          ),
      );
    });

    it("runs the checks on an open pull request's merged tree once its base moves, and records the failing one (ADR 0203)", async () => {
      const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
      log.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
      const route = { kind: 'route', batchId: '13-1', recipe: 'porter', reason: 'label' } as const;
      log.issue({ ...route, source: 'label' }, t0);
      const mergedRoot = join(f.dir.path, 'merged', 'one.tree');
      const ran: string[] = [];
      // green passes on the batch's own tree; the merged tree fails it.
      const exec: ExecProcess = async (file, _args, options) => {
        ran.push(`${file} in ${options.cwd}`);
        const code = options.cwd === mergedRoot ? 1 : 0;
        const output = code === 0 ? 'ok 1\n' : 'not ok 1 - adds\n';
        return { exitCode: code, stdout: output, stderr: '', output };
      };
      const succeeding: BrewerRunner = {
        start: () => ({
          ended: Promise.resolve({
            ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
          }),
          stop: () => {},
        }),
        progress: () => undefined,
      };
      const trees: string[] = [];
      const checked = () => log.state().batches.get('13-1')?.baseChecks ?? [];
      const code = await runServe(
        { ...f.setup, intake: { ...f.setup.intake, pollEveryMs: 0 } },
        shell({
          runner: () => succeeding,
          exec,
          push: (repository) => ({
            commit: async () => FAKE_COMMIT,
            // green merged the base at 'b…'; once the pull request is open it moves to 'e…'.
            baseTip: async () => (f.pushes.length > 0 ? 'e' : 'b').repeat(40),
            isAncestor: async (commit, of) => commit === of,
            // The bottle branch holds what was pushed.
            remoteTip: async () => (f.pushes.length > 0 ? FAKE_COMMIT : undefined),
            push: async (commit, branch) => {
              f.pushes.push(`${repository.repo} ${commit} ${branch}`);
            },
            secretScan: async () => [],
            touchedFiles: async () => [],
          }),
          mergeTree: () => async () => ({ kind: 'clean' }),
          mergedTree: () => async (head, tip, use) => {
            trees.push(`${head} ${tip}`);
            return use(mergedRoot);
          },
          wait: async () => {
            f.calls.push('wait');
            if (checked().length > 0 || f.calls.length > 60) f.controller.abort();
          },
        }),
      );
      assert.equal(code, 0);
      assert.deepStrictEqual(trees, [`${FAKE_COMMIT} ${'e'.repeat(40)}`]);
      assert.deepStrictEqual(
        ran.filter((line) => line.endsWith(mergedRoot)),
        [`npm test in ${mergedRoot}`],
      );
      const [check] = checked();
      assert.equal(check?.tip, 'e'.repeat(40));
      assert.deepStrictEqual(check?.failed, {
        result: 'exited',
        check: 'test',
        command: 'npm test',
        ...(process.platform === 'win32' ? { unsandboxed: true } : {}),
        exitCode: 1,
        tail: 'not ok 1 - adds\n',
      });
    });

    // Serve closes the store and lets the lock go: a run underway is stopped and settles first
    // (review of #528).
    it('stops a run on the merged tree and waits for it when a tick must stop the engine', async () => {
      const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
      log.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
      const route = { kind: 'route', batchId: '13-1', recipe: 'porter', reason: 'label' } as const;
      log.issue({ ...route, source: 'label' }, t0);
      const succeeding: BrewerRunner = {
        start: () => ({
          ended: Promise.resolve({
            ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
          }),
          stop: () => {},
        }),
        progress: () => undefined,
      };
      const run = { started: false, aborted: false, settled: false };
      const exec: ExecProcess = async () => ({
        exitCode: 0,
        stdout: 'ok 1\n',
        stderr: '',
        output: 'ok 1\n',
      });
      const code = await runServe(
        { ...f.setup, intake: { ...f.setup.intake, pollEveryMs: 0 } },
        shell({
          runner: () => succeeding,
          exec,
          stateBranch: () => ({
            start: async () => ({ decision: 'ready' }),
            flush: async () => {
              if (run.started) {
                throw new StateBranchStopError('the push was rejected: another engine wrote');
              }
              return { kind: 'unchanged' };
            },
          }),
          push: (repository) => ({
            commit: async () => FAKE_COMMIT,
            baseTip: async () => (f.pushes.length > 0 ? 'e' : 'b').repeat(40),
            isAncestor: async (commit, of) => commit === of,
            remoteTip: async () => (f.pushes.length > 0 ? FAKE_COMMIT : undefined),
            push: async (commit, branch) => {
              f.pushes.push(`${repository.repo} ${commit} ${branch}`);
            },
            secretScan: async () => [],
            touchedFiles: async () => [],
          }),
          mergeTree: () => async () => ({ kind: 'clean' }),
          mergedTree: () => async (_head, _tip, _use, signal) => {
            run.started = true;
            await new Promise<void>((resolve) => {
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            run.aborted = true;
            run.settled = true;
            throw new Error('stopped');
          },
          wait: async () => {
            f.calls.push('wait');
            if (f.calls.length > 80) f.controller.abort();
          },
        }),
      );
      assert.equal(code, 1);
      assert.deepStrictEqual(run, { started: true, aborted: true, settled: true });
    });

    // On the way out a pass underway may wait for its deadline: the run is stopped first, and
    // settles before the lock goes (review of #528).
    it('stops a run on the merged tree before it waits for the pass, and lets the lock go once it settled', async () => {
      const log = createCommandLog({ store: f.store, recipes: f.setup.recipes });
      log.issue({ kind: 'order', batchId: '13-1', order: { issue: 13 } }, t0);
      const route = { kind: 'route', batchId: '13-1', recipe: 'porter', reason: 'label' } as const;
      log.issue({ ...route, source: 'label' }, t0);
      const succeeding: BrewerRunner = {
        start: () => ({
          ended: Promise.resolve({
            ending: { kind: 'succeeded', output: { status: 'done', summary: 'Brewed' } },
          }),
          stop: () => {},
        }),
        progress: () => undefined,
      };
      const events: string[] = [];
      let started = false;
      let stopped: () => void = () => {};
      const aborted = new Promise<void>((resolve) => {
        stopped = resolve;
      });
      // The pass's read of the pull request waits until the run was stopped.
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const target = input instanceof Request ? input.url : String(input);
        if (started && (init?.method ?? 'GET') === 'GET' && target.includes('/pulls/')) {
          events.push('pass waiting');
          await aborted;
          events.push('pass read');
        }
        return f.api.fetch(input, init);
      };
      const code = await runServe(
        { ...f.setup, intake: { ...f.setup.intake, pollEveryMs: 0 } },
        shell({
          fetch,
          // A hang guard only: the order of events is what the test reads.
          intakeDeadlineMs: 5000,
          runner: () => succeeding,
          exec: async () => ({ exitCode: 0, stdout: 'ok 1\n', stderr: '', output: 'ok 1\n' }),
          lock: () => ({
            owner: 'cellar',
            path: join(f.dir.path, 'drivers', 'cellar.lock'),
            held: true,
            release: () => {
              events.push('lock released');
            },
          }),
          stateBranch: () => ({
            start: async () => ({ decision: 'ready' }),
            flush: async () => {
              if (events.includes('run started')) {
                throw new StateBranchStopError('the push was rejected: another engine wrote');
              }
              return { kind: 'unchanged' };
            },
          }),
          push: (repository) => ({
            commit: async () => FAKE_COMMIT,
            baseTip: async () => (f.pushes.length > 0 ? 'e' : 'b').repeat(40),
            isAncestor: async (commit, of) => commit === of,
            remoteTip: async () => (f.pushes.length > 0 ? FAKE_COMMIT : undefined),
            push: async (commit, branch) => {
              f.pushes.push(`${repository.repo} ${commit} ${branch}`);
            },
            secretScan: async () => [],
            touchedFiles: async () => [],
          }),
          mergeTree: () => async () => ({ kind: 'clean' }),
          mergedTree: () => async (_head, _tip, _use, signal) => {
            started = true;
            events.push('run started');
            await new Promise<void>((resolve) => {
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            events.push('run aborted');
            stopped();
            await new Promise<void>((resolve) => setImmediate(resolve));
            events.push('run settled');
            throw new Error('stopped');
          },
          wait: async () => {
            f.calls.push('wait');
            if (f.calls.length > 80) f.controller.abort();
          },
        }),
      );
      assert.equal(code, 1);
      const at = (event: string) => events.indexOf(event);
      assert.ok(at('run started') >= 0, events.join(', '));
      // A pass was underway, the run is stopped before it ends, and the lock goes after both.
      assert.ok(
        at('pass waiting') >= 0 && at('pass waiting') < at('run aborted'),
        events.join(', '),
      );
      assert.ok(at('run aborted') < at('pass read'), events.join(', '));
      assert.ok(
        at('run settled') >= 0 && at('run settled') < at('lock released'),
        events.join(', '),
      );
      assert.ok(
        !f.lines.some((line) => line.includes('longer than its deadline')),
        f.lines.join('\n'),
      );
    });

    it("sticks the batch when the batch's test map adds a module the test command wrote no report for (ADR 0274)", async () => {
      const blob = 'e'.repeat(40);
      const map = JSON.stringify({
        derivedFrom: { globs: ['**/package.json'], paths: ['package.json'] },
        modules: [
          {
            name: 'web',
            code: ['src/**'],
            tests: { paths: ['test/**'] },
            testReport: { format: 'junit', path: 'web-results.xml' },
            coverage: 'none',
          },
        ],
      });
      // Every worktree is at one commit: the check step's tip has a map, read first for its
      // manifests (ADR 0282), and the base has none.
      let lists = 0;
      const git: Git = async (_cwd, args) => {
        if (args[0] === 'ls-tree') {
          lists += 1;
          const stdout = lists === 2 ? '' : `100644 blob ${blob}\t.foedrum/test-map.jsonc\0`;
          return { code: 0, stdout, stderr: '' };
        }
        if (args[0] === 'cat-file' && args[2] === blob) return { code: 0, stdout: map, stderr: '' };
        // The map's manifests at the step's tip, as it records them (ADR 0282).
        if (args[0] === 'ls-files') return { code: 0, stdout: 'package.json\0', stderr: '' };
        throw new Error(`unexpected: ${args.join(' ')}`);
      };
      const { batch } = await brewWithChecks(0, { git });
      assert.equal(batch?.lane.kind, 'stuck');
      const reason = batch?.lane.kind === 'stuck' ? batch.lane.reason : undefined;
      assert.equal(reason?.kind === 'blocked' && reason.blockerKind, 'environment');
      assert.match(
        reason?.kind === 'blocked' ? reason.summary : '',
        /^module "web" of the test map is new in this batch/,
      );
    });

    it("reads the Brewery's test map of a repository it keeps the map of, never the clone's: regression test", async () => {
      const map = JSON.stringify({
        derivedFrom: { globs: ['**/package.json'], paths: ['package.json'] },
        modules: [
          {
            name: 'web',
            code: ['src/**'],
            tests: { paths: ['test/**'] },
            testReport: { format: 'junit', path: 'web-results.xml' },
            coverage: 'none',
          },
        ],
      });
      const serving = {
        ...f.setup,
        repositories: f.setup.repositories.map((repository) => ({
          ...repository,
          testMap: { text: map },
        })),
      };
      const asked: string[] = [];
      const git: Git = async (_cwd, args) => {
        // The worktree's manifests are listed for the Brewery's map too (ADR 0282).
        if (args[0] === 'ls-files') return { code: 0, stdout: 'package.json\0', stderr: '' };
        asked.push(args.join(' '));
        // The uncovered-line check reads the batch's change, an empty one here (ADR 0274).
        if (args.includes('diff')) return { code: 0, stdout: '', stderr: '' };
        throw new Error('no git read of the map');
      };
      // The Brewery's map is the base's too: its module is taken as reached.
      const { batch } = await brewWithChecks(0, { serving, git });
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.ok(
        asked.length > 0 && asked.every((args) => args.includes(' diff ')),
        asked.join('\n'),
      );
    });

    it('records a stale Brewery-kept test map and the batch goes on tap: the wiring says where it is kept (ADR 0282)', async () => {
      const map = JSON.stringify({
        derivedFrom: { globs: ['**/package.json'], paths: ['package.json'] },
        modules: [
          {
            name: 'web',
            code: ['src/**'],
            tests: { paths: ['test/**'] },
            testReport: { format: 'junit', path: 'web-results.xml' },
            coverage: 'none',
          },
        ],
      });
      const serving = {
        ...f.setup,
        repositories: f.setup.repositories.map((repository) => ({
          ...repository,
          testMap: { text: map },
        })),
      };
      const git: Git = async (_cwd, args) => {
        // A manifest the map does not record. The batch's change is not read for the Brewery's
        // map, only by the uncovered-line check, to which it adds no line (ADR 0274).
        if (args[0] === 'ls-files') {
          return { code: 0, stdout: 'package.json\0api/package.json\0', stderr: '' };
        }
        if (args.includes('diff')) return { code: 0, stdout: '', stderr: '' };
        throw new Error(`unexpected: ${args.join(' ')}`);
      };
      const { batch, events } = await brewWithChecks(0, { serving, git });
      assert.equal(batch?.lane.kind, 'on_tap', JSON.stringify(batch?.lane));
      const green = events.find(
        (event) => event.type === 'step.finished' && event.stepId === 'green',
      );
      assert.deepStrictEqual(green?.type === 'step.finished' ? green.staleMap : undefined, {
        repo: 'acme/web',
        kept: 'brewery',
        paths: ['api/package.json (added)', 'web-results.xml (no report of module "web")'],
        more: 0,
      });
    });

    it("sends the check step back along onFail when the batch left the repository's test map stale, reading its change in the clone: regression test", async () => {
      const blob = 'e'.repeat(40);
      const map = JSON.stringify({
        derivedFrom: { globs: ['**/package.json'], paths: ['package.json'] },
        modules: [
          {
            name: 'web',
            code: ['src/**'],
            tests: { paths: ['test/**'] },
            testReport: { format: 'junit', path: 'web-results.xml' },
            coverage: 'none',
          },
        ],
      });
      const diffs: string[] = [];
      const git: Git = async (cwd, args) => {
        if (args[0] === 'ls-tree') {
          return { code: 0, stdout: `100644 blob ${blob}\t.foedrum/test-map.jsonc\0`, stderr: '' };
        }
        if (args[0] === 'cat-file' && args[2] === blob) return { code: 0, stdout: map, stderr: '' };
        // A manifest the map does not record, and a change that added it.
        if (args[0] === 'ls-files') {
          return { code: 0, stdout: 'package.json\0api/package.json\0', stderr: '' };
        }
        if (args[0] === 'diff') {
          diffs.push(cwd);
          return { code: 0, stdout: 'api/package.json\0', stderr: '' };
        }
        throw new Error(`unexpected: ${args.join(' ')}`);
      };
      const { events } = await brewWithChecks(0, { git });
      const green = events.find(
        (event) => event.type === 'step.finished' && event.stepId === 'green',
      );
      assert.deepStrictEqual(green?.type === 'step.finished' ? green.outcome : undefined, {
        kind: 'failed',
        retryable: false,
        reason:
          'the test map of acme/web is stale: its derivedFrom.globs match api/package.json (added); ' +
          'update .foedrum/test-map.jsonc in this change (ADR 0274, ADR 0282)',
      });
      // The change is read in the repository's clone, never in the check step's worktree.
      assert.ok(diffs.length > 0);
      assert.ok(
        diffs.every((cwd) => cwd === clone),
        diffs.join('\n'),
      );
    });

    it("sticks the batch when the Brewery's test map of the repository does not parse: regression test", async () => {
      const serving = {
        ...f.setup,
        repositories: f.setup.repositories.map((repository) => ({
          ...repository,
          testMap: { text: '{ "modules": [' },
        })),
      };
      const git: Git = async () => {
        throw new Error('no git read of the map');
      };
      const { batch } = await brewWithChecks(0, { serving, git });
      const reason = batch?.lane.kind === 'stuck' ? batch.lane.reason : undefined;
      assert.match(
        reason?.kind === 'blocked' ? reason.summary : '',
        /^the test map of acme\/web at [0-9a-f]{40} cannot be read: /,
      );
    });

    it("runs the repository's test command in the check's worktree, and the batch goes on tap", async () => {
      const { checks, events, batch } = await brewWithChecks(0);
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.deepStrictEqual(
        checks.map(({ file, args, options }) => [file, args, options.cwd, options.shell]),
        [['npm test', [], worktreeOf(1), true]],
      );
      // The brewers' minimal environment and nothing else: no GitHub token under any name, no npm
      // lifecycle scripts (ADR 0063), and git with no push credential (ADR 0109).
      const env = checks[0]?.options.env ?? {};
      assert.deepStrictEqual(env, { PATH: '/usr/bin', HOME: home, ...brewerForcedEnv() });
      const finished = events.filter(
        (event) => event.type === 'step.finished' && event.stepId === 'green',
      );
      assert.deepStrictEqual(finished, [
        {
          type: 'step.finished',
          batchId: '13-1',
          stepId: 'green',
          attempt: 1,
          outcome: { kind: 'succeeded', output: null },
          readings: [
            {
              result: 'exited',
              check: 'test',
              command: 'npm test',
              // serve's check runner reads this process's platform (ADR 0076).
              ...(process.platform === 'win32' ? { unsandboxed: true } : {}),
              exitCode: 0,
              tail: 'ok 1\n',
            },
          ],
        },
      ]);
    });

    it("runs the repository's setup with serve's own process runner before the check (ADR 0140)", async () => {
      const ready = serveSetup(
        serveInputs({
          files: {
            ...serveInputs().files,
            config: config({}, { setup: { command: 'npm ci', timeout: '10m' } }),
            local: local({ workRoot: f.dir.path }),
          },
        }),
      );
      assert.ok(ready.kind === 'ready');
      const installs: Call[] = [];
      const prepare: ExecProcess = async (file, args, options) => {
        installs.push({ file, args, options });
        return { exitCode: 0, stdout: '', stderr: '', output: '' };
      };
      const { checks, batch } = await brewWithChecks(0, { serving: ready.setup, prepare });
      assert.equal(batch?.lane.kind, 'on_tap');
      assert.deepStrictEqual(
        installs.map(({ file, options }) => [file, options.cwd, options.shell]),
        [['npm ci', worktreeOf(1), true]],
      );
      assert.deepStrictEqual(installs[0]?.options.env, checks[0]?.options.env);
      assert.deepStrictEqual(
        checks.map(({ file }) => file),
        ['npm test'],
      );
    });

    it("records a session for the brewer's attempt and none for the check's (ADR 0116)", async () => {
      const { events } = await brewWithChecks(0);
      const sessionOf = (stepId: string) =>
        events.flatMap((event) =>
          event.type === 'step.started' && event.stepId === stepId ? [event.session] : [],
        );
      const [brew, ...more] = sessionOf('brew');
      assert.deepStrictEqual(more, []);
      assert.match(
        brew?.id ?? '',
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.equal(brew?.worktree, join(f.dir.path, 'acme.web', 'attempts', '13-1', 'brew', '1'));
      assert.deepStrictEqual(sessionOf('green'), [undefined]);
    });

    it('sends the batch back along onFail when the test fails, then makes it Stuck', async () => {
      const { checks, events, batch } = await brewWithChecks(1);
      assert.deepStrictEqual(
        events
          .filter((event) => event.type === 'step.scheduled')
          .map((event) => [event.stepId, event.attempt, event.route]),
        [
          ['brew', 1, undefined],
          ['green', 1, undefined],
          ['brew', 2, { from: 'green', why: 'failed' }],
          ['green', 2, undefined],
        ],
      );
      assert.deepStrictEqual(
        checks.map(({ options }) => options.cwd),
        [worktreeOf(1), worktreeOf(2)],
      );
      assert.deepStrictEqual(batch?.lane.kind === 'stuck' && batch.lane.reason, {
        kind: 'attempts_exhausted',
        stepId: 'green',
        attempts: 2,
        lastReason: 'the check "test" (npm test) failed with exit code 1',
      });
    });
  });
});
