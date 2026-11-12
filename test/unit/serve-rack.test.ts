// Serve opens a Brewery issue labelled recipe:rack every 4 weeks (ADR 0387): it reads the newest
// one, open or closed, at its start and then at most once an hour, and opens one when there is
// none and the oldest batch is 28 days old, or the newest was opened 28 days ago or more and none
// is open. An in-memory store, fake
// worktrees and a fake GitHub; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { runServe } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import type { BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { createCommandLog } from '../../src/engine/command-log.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { type FakeApiIssue, fakeGitHubApi, type Instead } from '../helpers/fake-github-api.ts';
import { config, local, serveInputs } from '../helpers/serve-brewery.ts';
import { serveFixture, t0 } from '../helpers/serve-fixture.ts';

const DAY = 86_400_000;

describe('runServe', () => {
  const f = serveFixture();
  const { shell } = f;

  describe('the rack issue every 4 weeks (ADR 0387)', () => {
    // The Brewery's own rack.jsonc: Foedrum's default with other ages, so the issue's text can only
    // have them from the Brewery's own steps.
    const rack = readFileSync(
      join(import.meta.dirname, '..', '..', 'defaults', 'recipes', 'rack.jsonc'),
      'utf8',
    )
      .replace('"180d"', '"90d"')
      .replace('"2d"', '"36h"');
    beforeEach(() => {
      const files = serveInputs().files;
      const result = serveSetup(
        serveInputs({
          files: {
            ...files,
            config: config({ concurrency: 1 }, {}),
            local: local({ workRoot: f.dir.path }),
            brewery: {
              ...files.brewery,
              recipes: [...files.brewery.recipes, { path: 'recipes/rack.jsonc', text: rack }],
            },
          },
        }),
      );
      f.setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
      // The Brewery's oldest batch, ordered 30 days ago: a first rack issue is due (ADR 0387).
      ordered(f.store, '9-1', 9, 30);
    });
    /** Orders the Brewery issue `issue` as `batchId`, `daysAgo` days before t0. */
    const ordered = (store: EventStore, batchId: string, issue: number, daysAgo: number) => {
      const log = createCommandLog({ store, recipes: f.setup.recipes });
      const at = new Date(t0.getTime() - daysAgo * DAY);
      assert.equal(log.issue({ kind: 'order', batchId, order: { issue } }, at).kind, 'accepted');
    };
    const hanging: BrewerRunner = {
      start: () => ({ ended: new Promise(() => {}), stop: () => {} }),
      progress: () => undefined,
    };
    /** Whether `request` is serve's read of the Brewery's rack issues. */
    const rackRead = (request: string): boolean => {
      const [method, path = ''] = request.split(' ');
      const url = new URL(path, 'https://api.github.com');
      return (
        method === 'GET' &&
        url.pathname.toLowerCase() === '/repos/acme/brewery/issues' &&
        url.searchParams.get('labels') === 'recipe:rack' &&
        url.searchParams.get('state') === 'all'
      );
    };
    /** Runs serve on a Brewery with `issues`, `waits` waits of `stepMs` each. */
    const serve = async (
      issues: FakeApiIssue[],
      options: {
        waits?: number;
        stepMs?: number;
        /** The answer instead of the fake's own, given the minute of serve's clock. */
        instead?: (method: string, url: URL, minute: number) => Instead | undefined;
      } = {},
    ) => {
      const { waits = 4, stepMs = 5000, instead } = options;
      let now = t0.getTime();
      const minute = () => (now - t0.getTime()) / 60_000;
      const github = fakeGitHubApi({
        login: 'ann',
        issues: { 'acme/brewery': issues },
        ...(instead === undefined
          ? {}
          : { instead: (method: string, url: URL) => instead(method, url, minute()) }),
      });
      // The minute of serve's clock at which each rack read went out.
      const readAt: number[] = [];
      let waited = 0;
      const ran = await runServe(
        f.setup,
        shell({
          fetch: (input, init) => {
            const url = new URL(String(input));
            if (rackRead(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)) {
              readAt.push(minute());
            }
            return github.fetch(input, init);
          },
          runner: () => hanging,
          clock: () => new Date(now),
          wait: async () => {
            now += stepMs;
            // Lets the reads underway go on between ticks, as the real wait does.
            await new Promise((resolve) => setTimeout(resolve, 1));
            if (++waited >= waits) f.controller.abort();
          },
        }),
      );
      assert.equal(ran, 0, f.lines.join('\n'));
      const opened = github.requests.filter(
        (request) => request.toLowerCase() === 'post /repos/acme/brewery/issues',
      );
      const rackIssues = github.issues['acme/brewery'] ?? [];
      const reads = github.requests.filter(rackRead).length;
      return { github, reads, readAt, opened, rackIssues };
    };
    const rackIssue = (
      number: number,
      daysAgo: number,
      state: 'open' | 'closed',
    ): FakeApiIssue => ({
      number,
      labels: ['recipe:rack'],
      author: 'ann',
      title: 'Rack: clean up the Brewery',
      body: 'An older one.',
      state,
      created: new Date(t0.getTime() - daysAgo * DAY).toISOString(),
    });

    it('serve opens a rack issue when the Brewery has none', async () => {
      const { opened, rackIssues } = await serve([
        // An issue with another recipe, which is no rack issue.
        { number: 7, labels: ['recipe:stout'], author: 'ann', state: 'closed', body: 'It.' },
      ]);
      assert.equal(opened.length, 1, f.lines.join('\n'));
      const made = rackIssues.find((issue) => issue.number === 8);
      assert.ok(made !== undefined);
      assert.deepStrictEqual(made.labels, ['recipe:rack']);
      assert.equal(made.title, 'Rack: clean up the Brewery');
      // The ages of the Brewery's own rack steps, in words.
      assert.match(made.body ?? '', /archives the finished batches on the state branch/);
      assert.match(made.body ?? '', /archive folders older than 90 days/);
      assert.match(made.body ?? '', /older than 36 hours/);
      assert.match(made.body ?? '', /foedrum approve <n>/);
      assert.match(made.body ?? '', /close the issue/);
      assert.ok(
        f.lines.includes('foedrum serve: opened the rack issue Acme/Brewery#8'),
        f.lines.join('\n'),
      );
    });

    it("serve opens no first rack issue before the Brewery's oldest batch is 28 days old", async () => {
      // Its only batch was ordered 27 days ago.
      f.store = openSqliteEventStore(':memory:');
      ordered(f.store, '9-1', 9, 27);
      const { reads, opened } = await serve([]);
      assert.ok(reads > 0, 'serve read the rack issues');
      assert.deepStrictEqual(opened, []);
    });

    it('serve opens a rack issue when the newest is 28 days old and closed', async () => {
      const { opened } = await serve([rackIssue(3, 60, 'closed'), rackIssue(5, 28, 'closed')]);
      assert.equal(opened.length, 1, f.lines.join('\n'));
    });

    it('serve opens no rack issue while one is open', async () => {
      // Opened 40 days ago and still open: only its being open holds the next one off.
      const { reads, opened } = await serve([rackIssue(5, 40, 'open')]);
      assert.ok(reads > 0, 'serve read the rack issues');
      assert.deepStrictEqual(opened, []);
    });

    it('serve opens no rack issue when the newest is younger than 28 days', async () => {
      const { reads, opened } = await serve([
        rackIssue(3, 60, 'closed'),
        rackIssue(5, 28 - 1 / (24 * 60), 'closed'),
      ]);
      assert.ok(reads > 0, 'serve read the rack issues');
      assert.deepStrictEqual(opened, []);
    });

    it("serve opens no rack issue when it cannot read the Brewery's issues", async () => {
      const { reads, opened } = await serve([], {
        instead: (method, url) =>
          rackRead(`${method} ${url.pathname}${url.search}`)
            ? { status: 500, body: { message: 'Server Error' } }
            : undefined,
      });
      assert.ok(reads > 0, 'serve read the rack issues');
      assert.deepStrictEqual(opened, []);
      assert.ok(
        f.lines.some((line) => line.startsWith('foedrum serve: the rack check failed: ')),
        f.lines.join('\n'),
      );
    });

    it('serve says the rack check failed when GitHub refuses the open, and goes on', async () => {
      const { opened } = await serve([], {
        instead: (method, url) =>
          method === 'POST' && url.pathname.toLowerCase() === '/repos/acme/brewery/issues'
            ? { status: 403, body: { message: 'Resource not accessible by integration' } }
            : undefined,
      });
      assert.equal(opened.length, 1);
      assert.ok(
        f.lines.some((line) =>
          line.startsWith(
            'foedrum serve: the rack check failed: GitHub answered 403 to opening the rack issue in Acme/Brewery',
          ),
        ),
        f.lines.join('\n'),
      );
      assert.ok(f.lines.includes('foedrum serve: stopped'), f.lines.join('\n'));
    });

    it('serve opens a rack issue beside a pull request labelled recipe:rack', async () => {
      const { opened } = await serve([{ ...rackIssue(5, 1, 'open'), pullRequest: true }]);
      assert.equal(opened.length, 1, f.lines.join('\n'));
    });

    it('serve neither reads nor opens a rack issue in a Brewery without a rack recipe', async () => {
      const files = serveInputs().files;
      const result = serveSetup(
        serveInputs({
          files: {
            ...files,
            config: config({ concurrency: 1 }, {}),
            local: local({ workRoot: f.dir.path }),
          },
        }),
      );
      f.setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
      const { github, reads, opened } = await serve([]);
      // Serve ran: it read its login and stopped.
      assert.ok(github.requests.includes('GET /user'), github.requests.join('\n'));
      assert.ok(f.lines.includes('foedrum serve: stopped'), f.lines.join('\n'));
      assert.equal(reads, 0);
      assert.deepStrictEqual(opened, []);
    });

    it('serve says no rack check failed when it stops during the read', async () => {
      // The read answers only once serve's stop aborts it.
      const { reads, opened } = await serve([], {
        waits: 2,
        instead: (method, url) =>
          rackRead(`${method} ${url.pathname}${url.search}`) ? 'hang' : undefined,
      });
      assert.ok(reads > 0, 'serve read the rack issues');
      assert.deepStrictEqual(opened, []);
      assert.ok(f.lines.includes('foedrum serve: stopped'), f.lines.join('\n'));
      assert.deepStrictEqual(
        f.lines.filter((line) => line.includes('rack check failed')),
        [],
      );
    });

    it("serve's rate-limited rack read holds the intake off, and a pause holds the next read off", async () => {
      // The rack read at 0 is refused until 30 minutes in; the intake's listing at 55 minutes until
      // 80, so the hourly read at 60 waits until then.
      const limited = (minute: number) => ({
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor((t0.getTime() + minute * 60_000) / 1000)),
        },
      });
      let rackRefused = false;
      let listingRefused = false;
      const { readAt } = await serve([rackIssue(5, 1, 'closed')], {
        waits: 20,
        stepMs: 5 * 60_000,
        instead: (method, url, minute) => {
          if (rackRead(`${method} ${url.pathname}${url.search}`)) {
            if (rackRefused) return undefined;
            rackRefused = true;
            return limited(30);
          }
          const listing = url.pathname.toLowerCase() === '/repos/acme/brewery/issues';
          if (!listing || listingRefused || minute < 55) return undefined;
          listingRefused = true;
          return limited(80);
        },
      });
      assert.deepStrictEqual(readAt, [0, 80], f.lines.join('\n'));
      assert.equal(f.lines.filter((line) => line.includes('rack check failed')).length, 1);
      // Only the listing refused at 55 minutes: no pass started while the rack read's pause held.
      assert.equal(
        f.lines.filter((line) => line.includes('the intake failed')).length,
        1,
        f.lines.join('\n'),
      );
    });

    it('serve waits for the rack read underway before it returns from a stop', async () => {
      const github = fakeGitHubApi({ login: 'ann', issues: { 'acme/brewery': [] } });
      const events: string[] = [];
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The rack read answers only once serve said it stopped, whatever the stop's signal says.
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (!rackRead(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)) {
          return github.fetch(input, init);
        }
        await held;
        const { signal: _stop, ...rest } = init ?? {};
        const answer = await github.fetch(input, rest);
        events.push('answered');
        return answer;
      };
      let waited = 0;
      const ran = await runServe(
        f.setup,
        shell({
          fetch,
          runner: () => hanging,
          out: (line) => {
            f.lines.push(line);
            if (line === 'foedrum serve: stopped') setTimeout(release, 0);
          },
          wait: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            if (++waited >= 2) f.controller.abort();
          },
        }),
      );
      events.push('returned');
      assert.equal(ran, 0, f.lines.join('\n'));
      assert.deepStrictEqual(events, ['answered', 'returned']);
    });

    it('serve reads the rack issues at its start and then at most once an hour', async () => {
      // 20 minutes a wait, 7 waits: the reads come at 0, 60 and 120 minutes.
      const { reads, opened } = await serve([rackIssue(5, 1, 'closed')], {
        waits: 7,
        stepMs: 20 * 60_000,
      });
      assert.equal(reads, 3, f.lines.join('\n'));
      assert.deepStrictEqual(opened, []);
    });
  });
});
