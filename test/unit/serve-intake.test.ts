// The intake in `foedrum serve`'s loop (ADR 0068): what it orders from each repository's issues and
// what it says when it cannot. An in-memory store, fake worktrees and a fake GitHub; no process
// starts (ADR 0021).

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { runServe } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { pullRequestText } from '../../src/engine/pull-request.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { StateBranchStopError } from '../../src/engine/state-branch.ts';
import type { Event } from '../../src/schemas/events.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { clone, config, local, recipe, serveInputs } from '../helpers/serve-brewery.ts';
import { serveFixture, t0 } from '../helpers/serve-fixture.ts';

describe('runServe', () => {
  const f = serveFixture();
  const { shell } = f;

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
          type: 'brew',
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
      assert.match(status[0]?.body ?? '', /Done\*\*: merged/);
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

    it('asks the engineer about a claimed target issue whose body was edited after its label, and no brewer reads it (ADR 0368)', async () => {
      f.store = empty();
      f.setup = intakeSetup({}, target);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [],
          'acme/web': [
            {
              number: 7,
              labels: ['foedrum'],
              author: 'ann',
              title: 'Dark theme',
              body: 'Add a dark theme.',
              // Labelled when it was opened, on 2026-10-01; edited by a stranger since.
              edited: [{ by: 'mallory', at: '2026-10-05T00:00:00Z' }],
            },
          ],
        },
      });
      // A person routes the Brewery issue once the driver opened it.
      const done = () => {
        const opened = github.issue('acme/brewery', 1);
        if (opened !== undefined && !opened.labels.includes('recipe:stout')) {
          opened.labels.push('recipe:stout');
        }
        return lane('web-7') === 'stuck';
      };
      assert.equal(await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(done) })), 0);
      const found = state().batches.get('web-7')?.lane;
      assert.ok(
        found?.kind === 'stuck' && found.reason.kind === 'order_changed',
        f.lines.join('\n'),
      );
      assert.deepStrictEqual(found.reason.changes, [
        { what: 'body', by: 'mallory', at: '2026-10-05T00:00:00Z' },
      ]);
      assert.deepStrictEqual(f.plans, []);
      assert.ok(github.requests.includes('GET /repos/acme/web/issues/7/events?per_page=100'));
    });

    it("brews a claimed target issue edited only before its label, by users and filter serve's config names (ADR 0368)", async () => {
      f.store = empty();
      f.setup = intakeSetup({}, target);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [],
          'acme/web': [
            {
              number: 7,
              labels: ['foedrum'],
              author: 'ann',
              title: 'Dark theme',
              body: 'Add a dark theme.',
              // Labelled when it was opened, on 2026-10-02; edited by a stranger the day before.
              created: '2026-10-02T00:00:00.000Z',
              edited: [{ by: 'mallory', at: '2026-10-01T12:00:00Z' }],
            },
          ],
        },
      });
      const done = () => {
        const opened = github.issue('acme/brewery', 1);
        if (opened !== undefined && !opened.labels.includes('recipe:stout')) {
          opened.labels.push('recipe:stout');
        }
        return f.plans.length > 0 || lane('web-7') === 'stuck';
      };
      assert.equal(await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(done) })), 0);
      assert.notEqual(lane('web-7'), 'stuck', f.lines.join('\n'));
      assert.match(f.plans[0]?.prompt ?? '', /Add a dark theme\./);
    });

    it("a stranger's comment before the label reaches the brewer, through serve's wiring (ADR 0373)", async () => {
      f.store = empty();
      f.setup = intakeSetup({}, target);
      const github = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [],
          'acme/web': [
            {
              number: 7,
              labels: ['foedrum'],
              author: 'ann',
              title: 'Dark theme',
              body: 'Add a dark theme.',
              // Labelled by ann when it was opened, on 2026-10-02; a stranger answered before.
              created: '2026-10-02T00:00:00.000Z',
            },
          ],
        },
      });
      github.comments.set('acme/web#7', [
        {
          id: 9101,
          author: 'mallory',
          body: 'THE-STRANGER-ANSWER',
          created: '2026-10-01T12:00:00Z',
        },
      ]);
      const done = () => {
        const opened = github.issue('acme/brewery', 1);
        if (opened !== undefined && !opened.labels.includes('recipe:stout')) {
          opened.labels.push('recipe:stout');
        }
        return f.plans.length > 0 || lane('web-7') === 'stuck';
      };
      assert.equal(await runServe(f.setup, shell({ fetch: github.fetch, ...ticking(done) })), 0);
      assert.notEqual(lane('web-7'), 'stuck', f.lines.join('\n'));
      assert.match(
        f.plans[0]?.prompt ?? '',
        /source="comment 9101 on acme\/web#7, by mallory \(NONE\), 2026-10-01T12:00:00Z" name="order">\nTHE-STRANGER-ANSWER\n/,
      );
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
