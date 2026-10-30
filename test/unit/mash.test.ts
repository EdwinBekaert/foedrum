// The Brewmaster and the `mash` recipe (ADR 0234), from Foedrum's own defaults/: `foedrum brew` on
// an issue labelled recipe:mash plans it and shows the plan on the issue, with serve's shell over an
// in-memory store, fake worktrees, a fake GitHub and the scripted runner. No process starts
// (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import { type BrewRequest, runBrew } from '../../src/cli/brew.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import type { AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import {
  type Behaviour,
  behave,
  fakeBrewerRunner,
  question,
} from '../helpers/fake-brewer-runner.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { FAKE_COMMIT, fakeWorktreeMerge, fakeWorktrees } from '../helpers/fake-worktrees.ts';
import { local, serveInputs } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const t0 = new Date('2026-10-28T12:00:00.000Z');

/** Three sub-orders, every field of the plan among them (ADR 0233). */
const subOrders = [
  {
    id: 'schema',
    title: 'The export schema',
    repo: 'acme/web',
    size: { lines: 200, mechanism: 'one zod schema' },
    doneWhen: 'a schema test reads an export',
    touches: [{ path: 'src/schemas' }, { path: 'src/schemas/export.ts', new: true }],
    recipe: 'nip',
    why: 'small and test-first',
    ready: true,
  },
  {
    id: 'writer',
    title: 'The export writer',
    repo: 'acme/web',
    size: { lines: 600, mechanism: 'the writer and its flag' },
    doneWhen: 'foedrum export prints the file',
    touches: [{ path: 'src/cli' }],
    dependencies: [{ on: 'schema', kind: 'code' }],
    recipe: 'nip',
    why: 'one mechanism',
    ready: true,
  },
  {
    id: 'docs',
    title: 'The export guide',
    repo: 'acme/web',
    size: { lines: 80, mechanism: 'one page' },
    doneWhen: 'the guide names every option',
    touches: [{ path: 'docs/export.md', new: true }],
    dependencies: [{ on: 'writer', kind: 'release' }],
    recipe: 'stout',
    why: 'prose only',
    testFirst: false,
    testFirstOff: 'a page has no test',
    ready: false,
    refinement: 'which options stay is open',
  },
];
const alternatives = {
  considered: [{ cut: 'one sub-order', whyNot: 'past a thousand lines' }],
  whyThis: 'each part merges alone',
};

describe('foedrum brew on recipe:mash, with the default Brewmaster (ADR 0234)', () => {
  let dir: TempDir;
  let setup: ServeSetup;
  let store: EventStore;
  let lines: string[];
  let api: FakeGitHubApi;
  let started: string[];
  let prompts: string[];
  /** The model each attempt was planned with. */
  let models: string[];

  beforeEach(() => {
    dir = makeTempDir('mash');
    const files = serveInputs().files;
    // No Brewery brewer or recipe of its own named brewmaster or mash: both come from defaults/.
    const { defaults } = readBreweryFiles(dir.path);
    const result = serveSetup(
      serveInputs({
        files: {
          ...files,
          local: local({ workRoot: dir.path }),
          brewery: { ...files.brewery, ...(defaults === undefined ? {} : { defaults }) },
        },
      }),
    );
    setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    store = { ...openSqliteEventStore(':memory:'), close: () => {} };
    lines = [];
    started = [];
    prompts = [];
    models = [];
    api = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          {
            number: 12,
            labels: ['recipe:mash'],
            author: 'ann',
            title: 'Export the batches',
            body: 'Add an export of the batches, with a guide.',
          },
        ],
      },
    });
  });
  afterEach(() => dir.remove());

  const log = () => createCommandLog({ store, recipes: setup.recipes });
  const request: BrewRequest = { target: { issue: 12 }, owner: 'ann', by: 'ann', via: 'terminal' };

  /** serve's shell whose runner plans each attempt, keeps its prompt, then plays `script`. */
  const shell = (script: readonly Behaviour[]): ServeShell => {
    let ticks = 0;
    const queue = [...script];
    const runnerOf = (plan: (start: AttemptStart) => Promise<ClaudeAttemptPlan>): BrewerRunner => {
      const inner = fakeBrewerRunner(
        () => queue.shift(),
        // claude's init, so a retry and an answer can resume the session (ADR 0117).
        { session: () => ({ sessionId: 's', model: 'claude-opus-5-5', claudeVersion: '2.1.301' }) },
      );
      return {
        start: (start) => {
          started.push(`${start.ref.stepId}#${start.ref.attempt}`);
          const ended = plan(start).then((made) => {
            prompts.push(made.prompt);
            models.push(made.call.model);
            return inner.start(start).ended;
          });
          return { ended, stop: () => {} };
        },
        progress: inner.progress,
      };
    };
    return {
      out: (line) => lines.push(line),
      signal: new AbortController().signal,
      clock: () => t0,
      wait: async () => {
        ticks++;
        if (ticks > 20) assert.fail(`brew did not stop:\n${lines.join('\n')}`);
      },
      lock: () => fakeLock('ann'),
      openStore: () => store,
      stateBranch: () => ({
        start: async () => ({ decision: 'ready' }),
        flush: async () => ({ kind: 'unchanged' }),
      }),
      worktrees: async () => fakeWorktrees({ root: join(dir.path, 'acme.web', 'attempts') }),
      merge: () => fakeWorktreeMerge(),
      push: () => ({
        commit: async () => FAKE_COMMIT,
        baseTip: async () => 'b'.repeat(40),
        isAncestor: async (commit, of) => commit === of,
        remoteTip: async () => undefined,
        push: async () => {},
        secretScan: async () => [],
        touchedFiles: async () => [],
      }),
      runner: (_claude, plan) => runnerOf(plan),
      exec: () => Promise.reject(new Error('no check step runs here')),
      setup: () => Promise.reject(new Error('no repository setup runs here')),
      gh: ghOver(api.fetch).exec,
      git: () => Promise.reject(new Error('no red proof or guarded step runs here')),
    };
  };

  const comments = () => api.comments.get('acme/brewery#12') ?? [];
  const planComment = () => comments().find(({ body }) => body.includes('plan of batch'))?.body;
  const sessions = () =>
    store
      .eventsAfter(0)
      .flatMap(({ event }) => (event.type === 'step.started' ? [event.session] : []));
  const planned = behave.succeedWith({ subOrders, alternatives }, 'Planned');

  it('plans the order and shows every field of its plan on the issue, building nothing', async () => {
    assert.equal(await runBrew(setup, shell([planned]), request), 0, lines.join('\n'));
    assert.deepStrictEqual(started, ['plan#1']);
    const body = planComment() ?? assert.fail(`no plan comment:\n${lines.join('\n')}`);
    for (const shown of [
      '`schema`: The export schema',
      'acme/web',
      '200 lines',
      'one zod schema',
      'a schema test reads an export',
      'src/schemas/export.ts',
      '`writer`',
      'foedrum export prints the file',
      'test-first off: a page has no test',
      'which options stay is open',
      'small and test-first',
      'one sub-order: past a thousand lines',
      'Chosen because: each part merges alone',
      '-->|"code"|',
      '-->|"release"|',
    ]) {
      assert.ok(body.includes(shown), `the plan comment shows ${shown}:\n${body}`);
    }
    assert.equal(api.pulls.length, 0);
    assert.equal(log().state().batches.get('12-1')?.lane.kind, 'on_tap');
    const status = comments().find(({ body }) => body.includes('On tap'))?.body ?? '';
    assert.match(status, /No pull request: the plan is in its own comment on this issue/);
  });

  it('ends on tap naming the plan comment, since there is no pull request (#656)', async () => {
    assert.equal(await runBrew(setup, shell([planned]), request), 0, lines.join('\n'));
    const id = comments().find(({ body }) => body.includes('plan of batch'))?.id;
    assert.equal(
      lines.at(-1),
      `foedrum brew: batch 12-1 is on tap: no pull request; the plan: https://github.com/acme/brewery/issues/12#issuecomment-${id}`,
    );
  });

  it("gives the Brewmaster the Brewery's repositories with their bases, on the planner alias", async () => {
    assert.equal(await runBrew(setup, shell([planned]), request), 0, lines.join('\n'));
    assert.match(
      prompts[0] ?? '',
      /source="the Brewery's repositories" name="repositories">\n[^<]*- acme\/web, base origin\/main: this attempt's repository, the one in your worktree\n/,
    );
    // defaults/models.jsonc maps planner, and the Brewery's models.jsonc does not.
    assert.deepStrictEqual(models, ['opus']);
  });

  it('retries a plan missing a field in the same session, told which field', async () => {
    const [first, ...rest] = subOrders;
    const { doneWhen: _, ...missing } = first ?? assert.fail();
    const invalid = behave.succeedWith({ subOrders: [missing, ...rest] }, 'Planned');
    assert.equal(await runBrew(setup, shell([invalid, planned]), request), 0, lines.join('\n'));
    assert.deepStrictEqual(started, ['plan#1', 'plan#2']);
    const [one, two] = sessions();
    assert.equal(two?.resumes, one?.id);
    assert.match(prompts[1] ?? '', /^The run before this one ended before the step was done\./);
    assert.match(prompts[1] ?? '', /failed: [^<]*subOrders\[0\]\.doneWhen/);
    assert.ok(planComment()?.includes('`schema`'));
  });

  it('asks its question, and the answer resumes the same session to the plan', async () => {
    assert.equal(await runBrew(setup, shell([behave.needInput()]), request), 4);
    const answers = [{ q: question.q, answer: 'sqlite' }];
    log().issue({ kind: 'answer', batchId: '12-1', by: 'ann', via: 'terminal', answers }, t0);
    assert.equal(await runBrew(setup, shell([planned]), request), 0, lines.join('\n'));
    assert.deepStrictEqual(started, ['plan#1', 'plan#2']);
    const [one, two] = sessions();
    assert.equal(two?.resumes, one?.id);
    assert.match(prompts[1] ?? '', /A: sqlite/);
    assert.ok(planComment()?.includes('`schema`'));
  });
});
