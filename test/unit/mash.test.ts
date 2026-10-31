// The Brewmaster and the `mash` recipe (ADR 0234), from Foedrum's own defaults/: `foedrum brew` on
// an issue labelled recipe:mash plans it and shows the plan on the issue, with serve's shell over an
// in-memory store, fake worktrees, a fake GitHub and the scripted runner. No process starts
// (ADR 0021).

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import { type BrewRequest, runBrew } from '../../src/cli/brew.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { planDigest } from '../../src/engine/admit.ts';
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
  /** The shell's clock: a later brew can be a minute on, past the status comment's limit. */
  let now: Date;

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
    now = t0;
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
          const ended = plan(start).then(async (made) => {
            prompts.push(made.prompt);
            models.push(made.call.model);
            const end = await inner.start(start).ended;
            // The Brewmaster's out doc stays in its worktree, as the real session leaves it.
            if (end.outDoc !== undefined) {
              mkdirSync(made.cwd, { recursive: true });
              writeFileSync(join(made.cwd, 'plan.md'), end.outDoc);
            }
            return end;
          });
          return { ended, stop: () => {} };
        },
        progress: inner.progress,
      };
    };
    return {
      out: (line) => lines.push(line),
      signal: new AbortController().signal,
      clock: () => now,
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
    assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
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
  });

  it('ends Stuck for a review of its plan, not on tap, naming the plan comment (#658)', async () => {
    assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
    assert.deepEqual(log().state().batches.get('12-1')?.lane, {
      kind: 'stuck',
      reason: { kind: 'plan_review', stepId: 'plan', attempt: 1 },
      options: ['approve', 'lauter', 'retry', 'recipe', 'cancel'],
      remindAt: '2026-10-30T12:00:00.000Z',
    });
    const id = comments().find(({ body }) => body.includes('plan of batch'))?.id;
    assert.equal(
      lines.at(-1),
      `foedrum brew: batch 12-1 is stuck: the plan of plan #1 is ready for your review; reminder 2026-10-30T12:00:00.000Z; options: approve, lauter, retry, recipe, cancel; the plan: https://github.com/${setup.brewery}/issues/12#issuecomment-${id}`,
    );
  });

  it('leaves the status comment naming the plan comment when foedrum brew ends, within the minute (#658)', async () => {
    assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
    const id = comments().find(({ body }) => body.includes('plan of batch'))?.id;
    const url = `https://github.com/${setup.brewery}/issues/12#issuecomment-${id}`;
    const status = comments().find(({ body }) => body.includes('Foedrum · batch'))?.body ?? '';
    assert.ok(status.includes(`is ready for your review: <${url}>`), status);
  });

  it('links the plan comment from the status comment, on the Brewery issue (#658)', async () => {
    assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
    // Two minutes on, past the status comment's limit of one revision a minute (ADR 0072).
    now = new Date(t0.getTime() + 2 * 60_000);
    assert.equal(await runBrew(setup, shell([]), request), 3, lines.join('\n'));
    const id = comments().find(({ body }) => body.includes('plan of batch'))?.id;
    const url = `https://github.com/${setup.brewery}/issues/12#issuecomment-${id}`;
    const status = comments().find(({ body }) => body.includes('Foedrum · batch'))?.body ?? '';
    assert.ok(
      status.includes(`🔔 **Stuck**: the plan of \`plan\` #1 is ready for your review: <${url}>`),
      status,
    );
    assert.doesNotMatch(status, /On tap/);
  });

  it("gives the Brewmaster the Brewery's repositories with their bases, on the planner alias", async () => {
    assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
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
    assert.equal(await runBrew(setup, shell([invalid, planned]), request), 3, lines.join('\n'));
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
    assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
    assert.deepStrictEqual(started, ['plan#1', 'plan#2']);
    const [one, two] = sessions();
    assert.equal(two?.resumes, one?.id);
    assert.match(prompts[1] ?? '', /A: sqlite/);
    assert.ok(planComment()?.includes('`schema`'));
  });

  describe('foedrum lauter: the plan corrected in a session at gate 1 (ADR 0286, #589)', () => {
    const [first, ...rest] = subOrders;
    const corrected = behave.succeedWith(
      {
        subOrders: [
          { ...(first ?? assert.fail()), title: 'The export schema, corrected' },
          ...rest,
        ],
        alternatives,
      },
      'Corrected',
    );
    const lauter: BrewRequest = { ...request, lauter: '12-1' };
    const resumedBy = () =>
      store
        .eventsAfter(0)
        .flatMap(({ event }) =>
          event.type === 'batch.resumed' ? [`${event.action} by ${event.by} via ${event.via}`] : [],
        );

    it("opens the Brewmaster's session on the plan, then waits for a review of the session's plan (#589)", async () => {
      assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
      assert.equal(await runBrew(setup, shell([corrected]), lauter), 3, lines.join('\n'));
      assert.deepStrictEqual(started, ['plan#1', 'lauter#1']);
      assert.deepStrictEqual(resumedBy(), ['lauter by ann via terminal']);
      const { lane } = log().state().batches.get('12-1') ?? assert.fail('no batch 12-1');
      assert.deepStrictEqual(lane.kind === 'stuck' ? lane.reason : lane, {
        kind: 'plan_review',
        stepId: 'lauter',
        attempt: 1,
      });
      // The session reads the plan it corrects; the plan step read none.
      assert.match(prompts[1] ?? '', /name="plan">[^<]*"summary": "Planned"/);
      assert.doesNotMatch(prompts[0] ?? '', /name="plan">/);
      assert.ok(planComment()?.includes('The export schema, corrected'), planComment());
    });

    it('says on the plan comment that the plan was changed in a session, by whom and when (#589)', async () => {
      assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
      assert.doesNotMatch(planComment() ?? '', /Changed in a session/);
      assert.equal(await runBrew(setup, shell([corrected]), lauter), 3, lines.join('\n'));
      assert.ok(
        planComment()?.includes(
          'Changed in a session by ann (terminal) at 2026-10-28T12:00:00.000Z.',
        ),
        planComment(),
      );
    });

    it('waits for a session again when the session ends with an invalid plan (#589)', async () => {
      const { doneWhen: _, ...missing } = first ?? assert.fail();
      const invalid = behave.succeedWith({ subOrders: [missing, ...rest] }, 'Corrected');
      assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
      assert.equal(await runBrew(setup, shell([invalid]), lauter), 3, lines.join('\n'));
      assert.deepStrictEqual(started, ['plan#1', 'lauter#1']);
      const { lane } = log().state().batches.get('12-1') ?? assert.fail('no batch 12-1');
      assert.deepStrictEqual(lane.kind === 'stuck' ? lane.reason : lane, {
        kind: 'waiting_for_session',
        stepId: 'lauter',
      });
    });

    it("signs off the session's plan, by its digest, on an approve after it (#589)", async () => {
      assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
      assert.equal(await runBrew(setup, shell([corrected]), lauter), 3, lines.join('\n'));
      const approve = { kind: 'approve', batchId: '12-1', by: 'ann', via: 'terminal' } as const;
      assert.equal(log().issue(approve, t0).kind, 'accepted');
      const batch = log().state().batches.get('12-1') ?? assert.fail('no batch 12-1');
      const digest = planDigest(batch, 'lauter', 1) ?? assert.fail('no plan of lauter #1');
      assert.notEqual(digest, planDigest(batch, 'plan', 1));
      assert.deepStrictEqual(batch.approval && { ...batch.approval }, {
        stepId: 'lauter',
        attempt: 1,
        plan: digest,
        by: 'ann',
        via: 'terminal',
        at: t0.toISOString(),
      });
    });

    it('records the lauter and parks the batch for a session without a terminal (#589)', async () => {
      assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
      const piped = { ...lauter, noSessions: 'no-terminal' } as const;
      assert.equal(await runBrew(setup, shell([]), piped), 3, lines.join('\n'));
      assert.deepStrictEqual(started, ['plan#1']);
      assert.deepStrictEqual(resumedBy(), ['lauter by ann via terminal']);
      const { lane } = log().state().batches.get('12-1') ?? assert.fail('no batch 12-1');
      assert.deepStrictEqual(lane.kind === 'stuck' ? lane.reason : lane, {
        kind: 'waiting_for_session',
        stepId: 'lauter',
      });
    });

    it('refuses a lauter of a batch not waiting for a review of its plan, naming its lane (#589)', async () => {
      assert.equal(await runBrew(setup, shell([behave.needInput()]), request), 4);
      assert.equal(await runBrew(setup, shell([]), lauter), 5, lines.join('\n'));
      assert.equal(
        lines.at(-1),
        'foedrum lauter: batch 12-1 is stuck on needs input, not on a plan to review',
      );
      assert.deepStrictEqual(resumedBy(), []);
    });

    it('lists the lauter step in the status comment only once a lauter ran it (#589)', async () => {
      const status = () =>
        comments().find(({ body }) => body.includes('Foedrum · batch'))?.body ?? '';
      assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
      assert.match(status(), /^- [^\n]*`plan`/m);
      assert.doesNotMatch(status(), /^- [^\n]*`lauter`/m);
      // Two minutes on, past the status comment's limit of one revision a minute (ADR 0072).
      now = new Date(t0.getTime() + 2 * 60_000);
      assert.equal(await runBrew(setup, shell([corrected]), lauter), 3, lines.join('\n'));
      assert.match(status(), /^- [^\n]*`lauter`/m);
    });

    it("opens a second lauter on the first session's plan, not the plan step's: regression test (#589)", async () => {
      const twice = behave.succeedWith(
        { subOrders: [{ ...(first ?? assert.fail()), title: 'Twice' }, ...rest], alternatives },
        'Corrected twice',
      );
      assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
      assert.equal(await runBrew(setup, shell([corrected]), lauter), 3, lines.join('\n'));
      assert.equal(await runBrew(setup, shell([twice]), lauter), 3, lines.join('\n'));
      assert.deepStrictEqual(started, ['plan#1', 'lauter#1', 'lauter#2']);
      assert.match(prompts[2] ?? '', /name="plan">[^<]*"title": "The export schema, corrected"/);
      assert.doesNotMatch(prompts[2] ?? '', /name="plan">[^<]*"title": "The export schema"/);
    });

    it('says when the session opened, not when the plan comment was edited: regression test (#589)', async () => {
      assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
      const session = shell([corrected]);
      const runner = session.runner;
      const later = new Date(t0.getTime() + 5 * 60_000);
      // The session runs five minutes, so its end and the comment's edit are past its opening.
      const timed: ServeShell = {
        ...session,
        runner: (claude, plan) => {
          const inner = runner(claude, plan);
          return {
            ...inner,
            start: (start) => {
              const running = inner.start(start);
              now = later;
              return running;
            },
          };
        },
      };
      assert.equal(await runBrew(setup, timed, lauter), 3, lines.join('\n'));
      const body = planComment() ?? '';
      assert.ok(body.includes(`by ann (terminal) at ${t0.toISOString()}.`), body);
      assert.doesNotMatch(body, new RegExp(later.toISOString().replaceAll('.', '\\.')));
    });

    it("refuses a lauter of a batch on tap, in decide's words: regression test (#589)", async () => {
      assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
      const approve = { kind: 'approve', batchId: '12-1', by: 'ann', via: 'terminal' } as const;
      assert.equal(log().issue(approve, t0).kind, 'accepted');
      assert.equal(await runBrew(setup, shell([]), lauter), 5, lines.join('\n'));
      assert.equal(lines.at(-1), 'foedrum lauter: batch 12-1 is on_tap; lauter needs it stuck');
      assert.deepStrictEqual(resumedBy(), []);
    });

    it('refuses a lauter of an issue with no batch, ordering nothing: regression test (#589)', async () => {
      const none: BrewRequest = { ...lauter, target: { issue: 13 } };
      assert.equal(await runBrew(setup, shell([]), none), 5, lines.join('\n'));
      assert.equal(lines.at(-1), 'foedrum lauter: #13 has no batch to correct a plan of');
      assert.equal(log().state().batches.size, 0);
    });

    it("lauters the batch it names, never the issue's later batch (#589)", async () => {
      assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
      const approve = { kind: 'approve', batchId: '12-1', by: 'ann', via: 'terminal' } as const;
      assert.equal(log().issue(approve, t0).kind, 'accepted');
      const order = { issue: 12 };
      const again = {
        kind: 'order_again',
        batchId: '12-2',
        order,
        by: 'ann',
        via: 'terminal',
      } as const;
      assert.equal(log().issue(again, t0).kind, 'accepted');
      assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
      assert.equal(await runBrew(setup, shell([corrected]), lauter), 5, lines.join('\n'));
      assert.equal(lines.at(-1), 'foedrum lauter: batch 12-1 is on_tap; lauter needs it stuck');
      assert.deepStrictEqual(resumedBy(), []);
    });

    it('keeps who chose the session when it reopens after an invalid plan (#589)', async () => {
      const { doneWhen: _, ...missing } = first ?? assert.fail();
      const invalid = behave.succeedWith({ subOrders: [missing, ...rest] }, 'Corrected');
      assert.equal(await runBrew(setup, shell([planned]), request), 3, lines.join('\n'));
      assert.equal(await runBrew(setup, shell([invalid]), lauter), 3, lines.join('\n'));
      // brew finds the batch waiting for a session and reopens it (ADR 0222).
      assert.equal(await runBrew(setup, shell([corrected]), request), 3, lines.join('\n'));
      assert.deepStrictEqual(started, ['plan#1', 'lauter#1', 'lauter#2']);
      assert.ok(
        planComment()?.includes('Changed in a session by ann (terminal) at'),
        planComment(),
      );
    });
  });
});
