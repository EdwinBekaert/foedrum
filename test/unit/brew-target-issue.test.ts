// `foedrum brew` of a target repository's issue (ADR 0105), through runBrew. serve's shell with an
// in-memory store, fake worktrees, a fake GitHub and the scripted runner; no process starts
// (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runBrew } from '../../src/cli/brew.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { brewFixture, request, t0 } from '../helpers/brew-fixture.ts';
import { behave } from '../helpers/fake-brewer-runner.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi, type Instead } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { config, local, serveInputs } from '../helpers/serve-brewery.ts';

describe('runBrew', () => {
  const f = brewFixture();
  const { log, shell } = f;

  describe('a target issue (ADR 0105)', () => {
    const web = { alias: 'web', intake: { labels: ['foedrum'] } };
    const targetSetup = (): ServeSetup => {
      const result = serveSetup(
        serveInputs({
          files: {
            ...serveInputs().files,
            config: config({}, web),
            local: local({ workRoot: f.dir.path }),
          },
        }),
      );
      return result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    };
    const github = () =>
      fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/web': [
            {
              number: 7,
              labels: ['foedrum', 'recipe:stout'],
              author: 'ann',
              title: 'Add a dark theme',
              body: 'Add a dark theme.',
            },
          ],
        },
      });
    const target = { ...request, target: { alias: 'web', issue: 7 } };

    /**
     * Brews the claimed web#7, which waits for its Brewery issue's label (ADR 0156), labels that
     * issue `recipe:stout`, and brews it again by it (ADR 0240): the second run's exit code.
     */
    const brewLabelled = async (host: FakeGitHubApi, brewing: ServeSetup): Promise<number> => {
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(brewing, claimed, target), 5, f.lines.join('\n'));
      const [order] = host.issues['acme/brewery'] ?? [];
      assert.ok(order !== undefined, 'its Brewery issue is opened');
      order.labels.push('recipe:stout');
      const again = shell(behave.succeed(), {
        gh: ghOver(host.fetch).exec,
        lock: () => fakeLock('ann'),
      });
      return runBrew(brewing, again, { ...request, target: { issue: order.number } });
    };

    it('claims it before it orders it, as foedrum order does, and brews it on tap by its Brewery issue: exit 0', async () => {
      const host = github();
      assert.equal(await brewLabelled(host, targetSetup()), 0, f.lines.join('\n'));
      assert.deepStrictEqual(host.created, ['acme/web refs/foedrum/claims/issues/7']);
      const batches = [...log().state().batches.values()];
      assert.deepStrictEqual(
        batches.map(({ id, repo, issue, lane }) => ({ id, repo, issue, lane: lane.kind })),
        [{ id: 'web-7', repo: 'acme/web', issue: 7, lane: 'on_tap' }],
      );
      assert.ok(f.lines.includes('foedrum brew: ordered web#7'), f.lines.join('\n'));
    });

    it("prints the link to the status comment on the claimed issue's Brewery issue (#413)", async () => {
      const host = github();
      const brewing = targetSetup();
      assert.equal(await brewLabelled(host, brewing), 0, f.lines.join('\n'));
      const [order] = host.issues['acme/brewery'] ?? [];
      const [comment] = host.comments.get(`acme/brewery#${order?.number}`) ?? [];
      assert.ok(comment !== undefined, 'a status comment on the Brewery issue');
      const link = `https://github.com/${brewing.brewery}/issues/${order?.number}#issuecomment-${comment.id}`;
      const shown = f.lines.filter((line) => line === `foedrum brew: status comment: ${link}`);
      assert.equal(shown.length, 1, f.lines.join('\n'));
    });

    it('brews a claimed order by its Brewery issue, as its claimed batch, on tap: exit 0 (ADR 0240)', async () => {
      const host = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            { number: 40, labels: ['recipe:stout'], author: 'ann', title: 'Dark', body: 'web#7' },
          ],
          'acme/web': [
            { number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark', body: 'Dark.' },
          ],
        },
      });
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      log().issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } }, t0);
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      const byOrder = { ...request, target: { issue: 40 } };
      assert.equal(await runBrew(targetSetup(), claimed, byOrder), 0, f.lines.join('\n'));
      const batches = [...log().state().batches.values()];
      assert.deepStrictEqual(
        batches.map(({ id, lane }) => ({ id, lane: lane.kind })),
        [{ id: 'web-7', lane: 'on_tap' }],
      );
    });

    it("routes an Ordered claimed batch by its recorded Brewery issue's label, never its target issue's: exit 0 (ADR 0156)", async () => {
      const host = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            { number: 40, labels: ['recipe:stout'], author: 'ann', title: 'Dark', body: 'web#7' },
          ],
          'acme/web': [
            { number: 7, labels: ['foedrum', 'recipe:nip'], author: 'ann', title: 'Dark' },
          ],
        },
      });
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      log().issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } }, t0);
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      const byOrder = { ...request, target: { issue: 40 } };
      assert.equal(await runBrew(targetSetup(), claimed, byOrder), 0, f.lines.join('\n'));
      assert.equal(log().state().batches.get('web-7')?.recipe?.name, 'stout');
    });

    it('brews a claimed batch routed before its Brewery issue is recorded, without waiting for a label: exit 0', async () => {
      const host = github();
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const route = { kind: 'route', batchId: 'web-7', recipe: 'stout', reason: 'label' } as const;
      log().issue({ ...route, source: 'label' }, t0);
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 0, f.lines.join('\n'));
      assert.equal(log().state().batches.get('web-7')?.lane.kind, 'on_tap');
      assert.ok(!f.lines.some((line) => line.includes('waits for')), f.lines.join('\n'));
    });

    it('orders a claimed issue, opens its Brewery issue and waits there for its recipe label, never routing by the target issue: exit 5 (ADR 0156)', async () => {
      const host = github();
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 5, f.lines.join('\n'));
      const [order] = host.issues['acme/brewery'] ?? [];
      assert.ok(order !== undefined, 'its Brewery issue is opened');
      const batch = log().state().batches.get('web-7');
      assert.deepStrictEqual(
        { lane: batch?.lane.kind, recipe: batch?.recipe },
        { lane: 'ordered', recipe: undefined },
      );
      assert.deepStrictEqual(f.started, []);
      assert.equal(
        f.lines.at(-1),
        `foedrum brew: web#7 waits for a recipe:<name> label on its Brewery issue #${order.number}; label it and brew ${order.number}, or foedrum mash ${order.number}`,
      );
    });

    it('never routes an Ordered claimed batch whose Brewery issue is not recorded yet by the label of its target issue (ADR 0156)', async () => {
      const host = github();
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 5, f.lines.join('\n'));
      // Its target issue carries recipe:stout: a run that read it to route would say so.
      assert.ok(!f.lines.some((line) => line.includes('routed')), f.lines.join('\n'));
      assert.equal(log().state().batches.get('web-7')?.recipe, undefined);
      const [order] = host.issues['acme/brewery'] ?? [];
      assert.equal(
        f.lines.at(-1),
        `foedrum brew: web#7 waits for a recipe:<name> label on its Brewery issue #${order?.number}; label it and brew ${order?.number}, or foedrum mash ${order?.number}`,
      );
    });

    /** The lines of a brew of web#7 that waits for its Brewery issue's label, on `host`. */
    const waiting = async (host: FakeGitHubApi): Promise<string[]> => {
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 5, f.lines.join('\n'));
      return f.lines;
    };

    it("a claimed order's line names a recipe label on its target issue, and does not read it", async () => {
      const host = github();
      const lines = await waiting(host);
      const [order] = host.issues['acme/brewery'] ?? [];
      assert.equal(
        lines.at(-2),
        `foedrum brew: web#7 carries recipe:stout, which Foedrum does not read; label #${order?.number}`,
      );
      assert.match(lines.at(-1) ?? '', /waits for a recipe:<name> label on its Brewery issue #/);
      assert.equal(log().state().batches.get('web-7')?.recipe, undefined);
    });

    it('names every recipe label a target issue carries', async () => {
      const host = github();
      host.issue('acme/web', 7)?.labels.push('recipe:nip');
      const lines = await waiting(host);
      assert.match(lines.at(-2) ?? '', /^foedrum brew: web#7 carries recipe:stout and recipe:nip,/);
    });

    it('says nothing of a recipe label when the target issue carries none', async () => {
      const host = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/web': [{ number: 7, labels: ['foedrum'], author: 'ann', title: 'Dark', body: 'x' }],
        },
      });
      const lines = await waiting(host);
      assert.match(lines.at(-1) ?? '', /waits for a recipe:<name> label on its Brewery issue #/);
      assert.ok(!lines.some((line) => line.includes('does not read')), lines.join('\n'));
    });

    it('leaves the line about a recipe label out when the target issue cannot be read then, and still refuses', async () => {
      const opened = () => (hosted?.issues['acme/brewery'] ?? []).length > 0;
      const hosted: FakeGitHubApi = fakeGitHubApi({
        login: 'ann',
        issues: github().issues,
        instead: (method, url) =>
          method === 'GET' && url.pathname.toLowerCase() === '/repos/acme/web/issues/7' && opened()
            ? { status: 500, body: { message: 'Server Error' } }
            : undefined,
      });
      const lines = await waiting(hosted);
      assert.match(lines.at(-1) ?? '', /waits for a recipe:<name> label on its Brewery issue #/);
      assert.ok(!lines.some((line) => line.includes('does not read')), lines.join('\n'));
    });

    it('fails, routing nothing, when the Brewery issue of a claimed order cannot be opened: exit 1', async () => {
      const host = fakeGitHubApi({
        login: 'ann',
        issues: github().issues,
        instead: (method, url) =>
          method === 'POST' && url.pathname.toLowerCase() === '/repos/acme/brewery/issues'
            ? { status: 500, body: { message: 'Server Error' } }
            : undefined,
      });
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 1, f.lines.join('\n'));
      assert.equal(log().state().batches.get('web-7')?.recipe, undefined);
      assert.deepStrictEqual(host.issues['acme/brewery'] ?? [], []);
      assert.ok(
        f.lines.some((line) => line.includes('"order.issue"] failed: GitHub answered 500')),
        f.lines.join('\n'),
      );
      assert.equal(
        f.lines.at(-1),
        'foedrum brew: web#7 waits for its Brewery issue, which is not open yet; brew web#7 again',
      );
    });

    it('foedrum brew of a target issue whose Brewery issue is open refuses and names the number', async () => {
      const host = github();
      log().issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } }, t0);
      const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
      log().issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } }, t0);
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 5, f.lines.join('\n'));
      assert.equal(f.lines.at(-1), 'foedrum brew: web#7 is Brewery issue #40; foedrum brew 40');
      assert.deepStrictEqual(host.created, []);
      assert.deepStrictEqual(f.started, []);
    });

    it('foedrum brew of a target issue whose Brewery issue was deleted claims again', async () => {
      const host = github();
      const issue = (command: Parameters<ReturnType<typeof log>['issue']>[0]) =>
        assert.equal(log().issue(command, t0).kind, 'accepted', JSON.stringify(command));
      const record = (effect: string, result: number | string) =>
        issue({
          kind: 'record',
          event: {
            type: 'effect.applied',
            key: effectKey.encode({ batchId: 'web-7', effect }),
            result,
          },
        });
      issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } });
      record('order.issue', 40);
      issue({ kind: 'cancel', batchId: 'web-7', by: 'ann', via: 'terminal' });
      for (const effect of ['release.label', 'release.comment', 'release.ref']) {
        record(effect, 'done');
      }
      record('release.order', 'gone');
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 5, f.lines.join('\n'));
      assert.deepStrictEqual(host.created, ['acme/web refs/foedrum/claims/issues/7']);
      assert.ok(log().state().batches.has('web-7-2'), f.lines.join('\n'));
    });

    describe('on tap, brewed again by its number (ADR 0336)', () => {
      const issue = (command: Parameters<ReturnType<typeof log>['issue']>[0]) =>
        assert.equal(log().issue(command, t0).kind, 'accepted', JSON.stringify(command));
      const merge = { sha: 'a'.repeat(40), at: '2026-10-22T13:00:00.000Z' };
      /** web#7 and another candidate, which no brew of web#7 may claim. */
      const two = (instead?: (method: string, url: URL) => Instead | undefined) =>
        fakeGitHubApi({
          login: 'ann',
          ...(instead === undefined ? {} : { instead }),
          issues: {
            'acme/web': [
              ...(github().issues['acme/web'] ?? []),
              { number: 8, labels: ['foedrum'], author: 'ann', title: 'Other', body: 'Other.' },
            ],
          },
        });
      /** Brews web#7 on tap on `host`, and runs brew by its number: the exit code and the number. */
      const brewAgain = async (host: FakeGitHubApi, between: (pull: number) => void) => {
        const brewing = targetSetup();
        assert.equal(await brewLabelled(host, brewing), 0, f.lines.join('\n'));
        const [pull] = host.pulls;
        const number = host.issues['acme/brewery']?.[0]?.number;
        assert.ok(pull !== undefined && number !== undefined);
        between(pull.number);
        const again = shell(behave.succeed(), {
          gh: ghOver(host.fetch).exec,
          lock: () => fakeLock('ann'),
        });
        const target = { ...request, target: { issue: number } };
        return { code: await runBrew(brewing, again, target), number, pull: pull.number };
      };
      const url = (pull: number) => `https://github.com/acme/web/pull/${pull}`;
      const claimRef = 'acme/web refs/foedrum/claims/issues/7';
      /** The lane labels on the Brewery issue `number`. */
      const laneLabelsOn = (host: FakeGitHubApi, number: number) =>
        (host.issue('acme/brewery', number)?.labels ?? []).filter((label) =>
          label.startsWith('foedrum:'),
        );
      const onlyWeb7 = () => {
        assert.deepStrictEqual(
          [...log().state().batches.keys()],
          ['web-7'],
          'no other order is claimed',
        );
      };

      it('a brew that ends on tap says what closes its Brewery issue', async () => {
        const host = github();
        assert.equal(await brewLabelled(host, targetSetup()), 0, f.lines.join('\n'));
        const number = host.issues['acme/brewery']?.[0]?.number;
        assert.equal(
          f.lines.at(-2),
          `foedrum brew: once they merge, foedrum brew ${number} or foedrum serve closes Brewery issue #${number} and releases its claim`,
        );
        assert.match(f.lines.at(-1) ?? '', /^foedrum brew: #\d+ is on tap: /);
      });

      it('a brew of a Brewery issue that ends on tap says what closes that issue, and names no claim', async () => {
        const brewing = shell(behave.succeed('Brewed'));
        assert.equal(await runBrew(f.setup, brewing, request), 0, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-2),
          'foedrum brew: once they merge, foedrum brew 12 or foedrum serve closes Brewery issue #12',
        );
        assert.match(f.lines.at(-1) ?? '', /^foedrum brew: #12 is on tap: /);
      });

      it('records a merge, closes the Brewery issue and releases the claim: exit 0', async () => {
        const host = two();
        const { code, number, pull } = await brewAgain(host, (made) =>
          host.merge('acme/web', made, merge),
        );
        assert.equal(code, 0, f.lines.join('\n'));
        assert.ok(
          f.lines.includes(`foedrum brew: applying what the end of #${number} leaves due as ann`),
          f.lines.join('\n'),
        );
        assert.equal(f.lines.filter((line) => line.startsWith('foedrum brew: brewing ')).length, 1);
        assert.equal(host.issue('acme/brewery', number)?.state, 'closed');
        assert.ok(!host.refs.has(claimRef), 'the claim ref is gone');
        assert.ok(!host.issue('acme/web', 7)?.labels.includes('foedrum:claimed'));
        assert.deepStrictEqual(laneLabelsOn(host, number), []);
        const comments = host.comments.get('acme/web#7') ?? [];
        assert.match(
          comments.at(-1)?.body ?? '',
          /released its claim.*its pull requests were merged/,
        );
        assert.deepStrictEqual(log().state().batches.get('web-7')?.pullRequestEnds, {
          [url(pull)]: 'merged',
        });
        onlyWeb7();
        assert.deepStrictEqual(host.created, [claimRef]);
        assert.equal(
          f.lines.at(-1),
          `foedrum brew: #${number} merged: ${url(pull)}; Brewery issue #${number} closed, claim on acme/web#7 released`,
        );
      });

      it('records a pull request closed unmerged, releases the claim and leaves the Brewery issue open: exit 0', async () => {
        let closed: number | undefined;
        const host = two((method, { pathname }) =>
          method === 'GET' && pathname === `/repos/acme/web/pulls/${closed}`
            ? { status: 200, body: { state: 'closed', merged: false, merged_at: null } }
            : undefined,
        );
        const { code, number, pull } = await brewAgain(host, (made) => {
          closed = made;
        });
        assert.equal(code, 0, f.lines.join('\n'));
        assert.notEqual(host.issue('acme/brewery', number)?.state, 'closed');
        assert.ok(!host.refs.has(claimRef), 'the claim ref is gone');
        const comments = host.comments.get('acme/web#7') ?? [];
        assert.match(comments.at(-1)?.body ?? '', /closed without being merged/);
        onlyWeb7();
        assert.equal(
          f.lines.at(-1),
          `foedrum brew: #${number} ended: ${url(pull)} not all merged; Brewery issue #${number} stays open, claim on acme/web#7 released, unassign it to make it available`,
        );
      });

      it('with one of two pull requests open records the other, releases nothing and names the open one: exit 5', async () => {
        const merged = url(101);
        const open = url(102);
        const answers = (method: string, { pathname }: URL): Instead | undefined => {
          if (method !== 'GET') return undefined;
          if (pathname === '/repos/acme/web/pulls/101') {
            return { status: 200, body: { state: 'closed', merged: true } };
          }
          return pathname === '/repos/acme/web/pulls/102'
            ? { status: 200, body: { state: 'open', merged: false } }
            : undefined;
        };
        const host = two(answers);
        const routeBy = new Date(t0.getTime() + 3_600_000).toISOString();
        const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
        const order = { issue: 7, repo: 'acme/web' };
        f.store.withTransaction((tx) => {
          tx.append({ type: 'batch.ordered', batchId: 'web-7', order, routeBy });
          tx.append({ type: 'batch.on_tap', batchId: 'web-7', pullRequests: [merged, open] });
        });
        issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } });
        const brewing = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
        const byNumber = { ...request, target: { issue: 40 } };
        assert.equal(await runBrew(targetSetup(), brewing, byNumber), 5, f.lines.join('\n'));
        assert.deepStrictEqual(log().state().batches.get('web-7')?.pullRequestEnds, {
          [merged]: 'merged',
        });
        const applied = [...log().state().effects.keys()];
        assert.ok(!applied.some((each) => each.includes('release.')), applied.join('\n'));
        assert.deepStrictEqual(host.comments.get('acme/web#7') ?? [], []);
        assert.equal(
          f.lines.at(-1),
          `foedrum brew: #40 is on tap and holds its claim until its pull requests end: ${open}; foedrum brew 40 reads them again`,
        );
      });

      it('foedrum mash of a batch whose pull request is still open reads nothing and says its claim is held', async () => {
        const host = github();
        const brewing = targetSetup();
        assert.equal(await brewLabelled(host, brewing), 0, f.lines.join('\n'));
        const number = host.issues['acme/brewery']?.[0]?.number;
        const [pull] = host.pulls;
        host.merge('acme/web', pull?.number ?? 0, merge);
        const mashing = shell(behave.succeed(), {
          gh: ghOver(host.fetch).exec,
          lock: () => fakeLock('ann'),
        });
        const mash = { ...request, mash: true as const, target: { issue: number ?? 0 } };
        assert.equal(await runBrew(brewing, mashing, mash), 5, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-1),
          `foedrum mash: #${number} is on tap and holds its claim until its pull requests end: ${url(pull?.number ?? 0)}; foedrum brew ${number} reads them again`,
        );
        assert.deepStrictEqual(log().state().batches.get('web-7')?.pullRequestEnds ?? {}, {});
      });

      it('finishes a release a run killed after the end left due: exit 0', async () => {
        const host = two();
        const brewing = targetSetup();
        assert.equal(await brewLabelled(host, brewing), 0, f.lines.join('\n'));
        const number = host.issues['acme/brewery']?.[0]?.number ?? 0;
        const [pull] = host.pulls;
        const event = {
          type: 'pull_request.ended',
          batchId: 'web-7',
          pullRequest: url(pull?.number ?? 0),
          state: 'merged',
        } as const;
        issue({ kind: 'record', event });
        const again = shell(behave.succeed(), {
          gh: ghOver(host.fetch).exec,
          lock: () => fakeLock('ann'),
        });
        const byNumber = { ...request, target: { issue: number } };
        assert.equal(await runBrew(brewing, again, byNumber), 0, f.lines.join('\n'));
        assert.equal(host.issue('acme/brewery', number)?.state, 'closed');
        assert.ok(!host.refs.has(claimRef), 'the claim ref is gone');
      });

      it('finishes a release still due of a batch on tap with no pull request: exit 0', async () => {
        const host = two();
        host.issues['acme/brewery'] = [{ number: 40, labels: [], author: 'ann', title: 'Dark' }];
        const routeBy = new Date(t0.getTime() + 3_600_000).toISOString();
        const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
        const order = { issue: 7, repo: 'acme/web' };
        f.store.withTransaction((tx) => {
          tx.append({ type: 'batch.ordered', batchId: 'web-7', order, routeBy });
          tx.append({ type: 'batch.on_tap', batchId: 'web-7', pullRequests: [] });
        });
        issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } });
        const brewing = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
        const byNumber = { ...request, target: { issue: 40 } };
        assert.equal(await runBrew(targetSetup(), brewing, byNumber), 0, f.lines.join('\n'));
        const comments = host.comments.get('acme/web#7') ?? [];
        assert.match(comments.at(-1)?.body ?? '', /ended without a pull request/);
        assert.equal(f.lines.at(-1), 'foedrum brew: #40 is on tap: no pull request');
      });

      it('fails, recording nothing, when its pull request cannot be read: exit 1', async () => {
        const reading = { fails: false };
        const host = two((method, { pathname }) =>
          reading.fails && method === 'GET' && /\/pulls\/\d+$/.test(pathname)
            ? { status: 500, body: { message: 'Server Error' } }
            : undefined,
        );
        const { code } = await brewAgain(host, () => {
          reading.fails = true;
        });
        assert.equal(code, 1, f.lines.join('\n'));
        assert.match(f.lines.at(-1) ?? '', /500/);
        assert.deepStrictEqual(log().state().batches.get('web-7')?.pullRequestEnds ?? {}, {});
      });

      it('one pull request merged and one closed unmerged says not all merged, and the Brewery issue stays open: exit 0', async () => {
        const answers = (method: string, { pathname }: URL): Instead | undefined => {
          if (method !== 'GET') return undefined;
          if (pathname === '/repos/acme/web/pulls/101') {
            return { status: 200, body: { state: 'closed', merged: true } };
          }
          return pathname === '/repos/acme/web/pulls/102'
            ? { status: 200, body: { state: 'closed', merged: false } }
            : undefined;
        };
        const host = two(answers);
        host.issues['acme/brewery'] = [{ number: 40, labels: [], author: 'ann', title: 'Dark' }];
        const routeBy = new Date(t0.getTime() + 3_600_000).toISOString();
        const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
        const order = { issue: 7, repo: 'acme/web' };
        f.store.withTransaction((tx) => {
          tx.append({ type: 'batch.ordered', batchId: 'web-7', order, routeBy });
          tx.append({ type: 'batch.on_tap', batchId: 'web-7', pullRequests: [url(101), url(102)] });
        });
        issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } });
        const brewing = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
        const byNumber = { ...request, target: { issue: 40 } };
        assert.equal(await runBrew(targetSetup(), brewing, byNumber), 0, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-1),
          `foedrum brew: #40 ended: ${url(101)} ${url(102)} not all merged; Brewery issue #40 stays open, claim on acme/web#7 released, unassign it to make it available`,
        );
        assert.notEqual(host.issue('acme/brewery', 40)?.state, 'closed');
      });

      it('brewed once more after its release finished, it refuses and reads no pull request: exit 5', async () => {
        const host = two();
        const { code, number } = await brewAgain(host, (made) =>
          host.merge('acme/web', made, merge),
        );
        assert.equal(code, 0, f.lines.join('\n'));
        const asked = host.requests.length;
        const again = shell(behave.succeed(), {
          gh: ghOver(host.fetch).exec,
          lock: () => fakeLock('ann'),
        });
        const byNumber = { ...request, target: { issue: number } };
        assert.equal(await runBrew(targetSetup(), again, byNumber), 5, f.lines.join('\n'));
        assert.match(f.lines.at(-1) ?? '', new RegExp(`foedrum order ${number} orders it again$`));
        const read = host.requests.slice(asked).filter((each) => /\/pulls\/\d+/.test(each));
        assert.deepStrictEqual(read, []);
      });

      it('a Cellar that records the same end first changes nothing: exit 0', async () => {
        let recorded = false;
        let pullNumber = 0;
        const host = two((method, { pathname }) => {
          if (method === 'GET' && pathname === `/repos/acme/web/pulls/${pullNumber}` && !recorded) {
            recorded = true;
            const pullRequest = url(pullNumber);
            f.store.withTransaction((tx) =>
              tx.append({
                type: 'pull_request.ended',
                batchId: 'web-7',
                pullRequest,
                state: 'merged',
              }),
            );
          }
          return undefined;
        });
        const { code, number } = await brewAgain(host, (made) => {
          pullNumber = made;
          host.merge('acme/web', made, merge);
        });
        assert.equal(code, 0, f.lines.join('\n'));
        assert.ok(recorded, 'the end was recorded by the other writer');
        assert.equal(host.issue('acme/brewery', number)?.state, 'closed');
      });

      it('foedrum brew --take of an on-tap batch another driver holds is refused, taking nothing and reading nothing: exit 5', async () => {
        const host = github();
        const brewing = targetSetup();
        assert.equal(await brewLabelled(host, brewing), 0, f.lines.join('\n'));
        const number = host.issues['acme/brewery']?.[0]?.number ?? 0;
        const expiresAt = new Date(t0.getTime() + 60_000);
        f.store.withTransaction((tx) =>
          tx.putBatchLease({ batchId: 'web-7', owner: 'cellar', expiresAt }),
        );
        const asked = host.requests.length;
        const again = shell(behave.succeed(), {
          gh: ghOver(host.fetch).exec,
          lock: () => fakeLock('ann'),
        });
        const taking = { ...request, take: true as const, target: { issue: number } };
        assert.equal(await runBrew(brewing, again, taking), 5, f.lines.join('\n'));
        assert.equal(webLease()?.owner, 'cellar');
        const read = host.requests.slice(asked).filter((each) => /\/pulls\/\d+/.test(each));
        assert.deepStrictEqual(read, []);
      });

      it('a pause of the whole Brewery refuses an on-tap batch, reading nothing, until it is continued: exit 5, then 0', async () => {
        const host = two();
        const brewing = targetSetup();
        assert.equal(await brewLabelled(host, brewing), 0, f.lines.join('\n'));
        const number = host.issues['acme/brewery']?.[0]?.number ?? 0;
        const [pull] = host.pulls;
        host.merge('acme/web', pull?.number ?? 0, merge);
        const shellAgain = () =>
          shell(behave.succeed(), { gh: ghOver(host.fetch).exec, lock: () => fakeLock('ann') });
        const byNumber = { ...request, target: { issue: number } };
        issue({ kind: 'pause', by: 'ann', via: 'terminal' });
        const asked = host.requests.length;
        assert.equal(await runBrew(brewing, shellAgain(), byNumber), 5, f.lines.join('\n'));
        assert.match(f.lines.at(-1) ?? '', /the Brewery is paused/);
        assert.deepStrictEqual(
          host.requests.slice(asked).filter((each) => /\/pulls\/\d+/.test(each)),
          [],
        );
        issue({ kind: 'continue', by: 'ann', via: 'terminal' });
        assert.equal(await runBrew(brewing, shellAgain(), byNumber), 0, f.lines.join('\n'));
        assert.equal(host.issue('acme/brewery', number)?.state, 'closed');
      });

      it('a batch of a Brewery issue records its merge and says so: exit 0', async () => {
        f.store.withTransaction((tx) => {
          const routeBy = new Date(t0.getTime() + 3_600_000).toISOString();
          tx.append({ type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy });
          tx.append({ type: 'batch.on_tap', batchId: '12-1', pullRequests: [url(90)] });
        });
        const host = fakeGitHubApi({
          login: 'ann',
          issues: { 'acme/brewery': [{ number: 12, labels: [], author: 'ann', title: 'T' }] },
          instead: (method, { pathname }) =>
            method === 'GET' && pathname === '/repos/acme/web/pulls/90'
              ? { status: 200, body: { state: 'closed', merged: true } }
              : undefined,
        });
        const own = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
        assert.equal(await runBrew(f.setup, own, request), 0, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-1),
          `foedrum brew: #12 merged: ${url(90)}; Brewery issue #12 closed`,
        );
        assert.equal(host.issue('acme/brewery', 12)?.state, 'closed');
        assert.deepStrictEqual(log().state().batches.get('12-1')?.pullRequestEnds, {
          [url(90)]: 'merged',
        });
      });

      it('a batch of a Brewery issue whose pull request closed unmerged says its issue stays open: exit 0', async () => {
        f.store.withTransaction((tx) => {
          const routeBy = new Date(t0.getTime() + 3_600_000).toISOString();
          tx.append({ type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy });
          tx.append({ type: 'batch.on_tap', batchId: '12-1', pullRequests: [url(90)] });
        });
        const host = fakeGitHubApi({
          login: 'ann',
          issues: { 'acme/brewery': [{ number: 12, labels: [], author: 'ann', title: 'T' }] },
          instead: (method, { pathname }) =>
            method === 'GET' && pathname === '/repos/acme/web/pulls/90'
              ? { status: 200, body: { state: 'closed', merged: false } }
              : undefined,
        });
        const own = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
        assert.equal(await runBrew(f.setup, own, request), 0, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-1),
          `foedrum brew: #12 ended: ${url(90)} not all merged; Brewery issue #12 stays open`,
        );
        assert.notEqual(host.issue('acme/brewery', 12)?.state, 'closed');
      });

      /** Batch 12-1 on tap, its pull request's merge recorded, and `applied` in the ledger. */
      const mergedWith = (applied: readonly string[]) => {
        f.store.withTransaction((tx) => {
          const routeBy = new Date(t0.getTime() + 3_600_000).toISOString();
          tx.append({ type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy });
          tx.append({ type: 'batch.on_tap', batchId: '12-1', pullRequests: [url(90)] });
        });
        const event = {
          type: 'pull_request.ended',
          batchId: '12-1',
          pullRequest: url(90),
          state: 'merged',
        } as const;
        issue({ kind: 'record', event });
        for (const effect of applied) {
          const key = effectKey.encode({ batchId: '12-1', effect });
          issue({ kind: 'record', event: { type: 'effect.applied', key, result: 1 } });
        }
        return fakeGitHubApi({
          login: 'ann',
          issues: { 'acme/brewery': [{ number: 12, labels: [], author: 'ann', title: 'T' }] },
        });
      };

      it("finishes a Brewery issue's close a run killed after its comment left due: exit 0", async () => {
        const host = mergedWith(['close.comment']);
        const own = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
        assert.equal(await runBrew(f.setup, own, request), 0, f.lines.join('\n'));
        assert.equal(host.issue('acme/brewery', 12)?.state, 'closed');
        assert.equal(
          f.lines.at(-1),
          `foedrum brew: #12 merged: ${url(90)}; Brewery issue #12 closed`,
        );
        const said = host.comments.get('acme/brewery#12') ?? [];
        assert.ok(!said.some(({ body }) => body.includes('Foedrum closes this issue')));
      });

      it("refuses a Brewery issue's batch whose close is all applied, reading no pull request: exit 5", async () => {
        const host = mergedWith(['close.comment', 'close.issue']);
        const own = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
        assert.equal(await runBrew(f.setup, own, request), 5, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-1),
          'foedrum brew: #12 is on tap; foedrum order 12 orders it again',
        );
        assert.deepStrictEqual(
          host.requests.filter((each) => /\/pulls\/\d+/.test(each)),
          [],
        );
      });

      it('a batch cancelled while another driver takes it offers no take-over: exit 5', async () => {
        const expiresAt = new Date(t0.getTime() + 60_000);
        let done = false;
        const running = behave.hang({ lastProgressAt: t0, turnsWithoutProgress: 0 });
        const taken = shell(running, {
          wait: async () => {
            if (done) return;
            done = true;
            issue({ kind: 'cancel', batchId: '12-1', by: 'ann', via: 'terminal' });
            f.store.withTransaction((tx) =>
              tx.putBatchLease({ batchId: '12-1', owner: 'cellar', expiresAt }),
            );
          },
        });
        assert.equal(await runBrew(f.setup, taken, request), 5, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-1),
          `foedrum brew: #12 is driven by cellar until ${expiresAt.toISOString()}, when its lease ends by itself; foedrum brew 12 tries again then`,
        );
      });

      it("finishes a Brewery issue's close a run killed after the end left due: exit 0", async () => {
        f.store.withTransaction((tx) => {
          const routeBy = new Date(t0.getTime() + 3_600_000).toISOString();
          tx.append({ type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy });
          tx.append({ type: 'batch.on_tap', batchId: '12-1', pullRequests: [url(90)] });
        });
        const event = {
          type: 'pull_request.ended',
          batchId: '12-1',
          pullRequest: url(90),
          state: 'merged',
        } as const;
        issue({ kind: 'record', event });
        const host = fakeGitHubApi({
          login: 'ann',
          issues: { 'acme/brewery': [{ number: 12, labels: [], author: 'ann', title: 'T' }] },
        });
        const own = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
        assert.equal(await runBrew(f.setup, own, request), 0, f.lines.join('\n'));
        assert.equal(host.issue('acme/brewery', 12)?.state, 'closed');
      });

      it('foedrum lauter of it keeps its own refusal and records no end', async () => {
        const host = github();
        const brewing = targetSetup();
        assert.equal(await brewLabelled(host, brewing), 0, f.lines.join('\n'));
        const number = host.issues['acme/brewery']?.[0]?.number;
        const [pull] = host.pulls;
        host.merge('acme/web', pull?.number ?? 0, merge);
        const correcting = shell(behave.succeed(), {
          gh: ghOver(host.fetch).exec,
          lock: () => fakeLock('ann'),
        });
        const lauter = { ...request, lauter: 'web-7', target: { issue: number ?? 0 } };
        assert.equal(await runBrew(brewing, correcting, lauter), 5, f.lines.join('\n'));
        assert.deepStrictEqual(log().state().batches.get('web-7')?.pullRequestEnds ?? {}, {});
      });

      it('a batch of a Brewery issue whose pull request is open keeps its line, foedrum order being open to it: exit 5', async () => {
        f.store.withTransaction((tx) => {
          const routeBy = new Date(t0.getTime() + 3_600_000).toISOString();
          tx.append({ type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy });
          tx.append({ type: 'batch.on_tap', batchId: '12-1', pullRequests: [url(90)] });
        });
        const host = fakeGitHubApi({
          login: 'ann',
          issues: { 'acme/brewery': [{ number: 12, labels: [], author: 'ann', title: 'T' }] },
          instead: (method, { pathname }) =>
            method === 'GET' && pathname === '/repos/acme/web/pulls/90'
              ? { status: 200, body: { state: 'open', merged: false } }
              : undefined,
        });
        const own = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
        assert.equal(await runBrew(f.setup, own, request), 5, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-1),
          'foedrum brew: #12 is on tap; foedrum order 12 orders it again',
        );
      });

      it('a batch another driver holds is refused before anything is read: exit 5', async () => {
        const host = github();
        const brewing = targetSetup();
        assert.equal(await brewLabelled(host, brewing), 0, f.lines.join('\n'));
        const number = host.issues['acme/brewery']?.[0]?.number ?? 0;
        const expiresAt = new Date(t0.getTime() + 60_000);
        f.store.withTransaction((tx) =>
          tx.putBatchLease({ batchId: 'web-7', owner: 'cellar', expiresAt }),
        );
        const asked = host.requests.length;
        const again = shell(behave.succeed(), {
          gh: ghOver(host.fetch).exec,
          lock: () => fakeLock('ann'),
        });
        const byNumber = { ...request, target: { issue: number } };
        assert.equal(await runBrew(brewing, again, byNumber), 5, f.lines.join('\n'));
        // A take-over of a batch on tap is refused (ADR 0124), so the line never offers one.
        assert.equal(
          f.lines.at(-1),
          `foedrum brew: #${number} is driven by cellar until ${expiresAt.toISOString()}, when its lease ends by itself; foedrum brew ${number} tries again then`,
        );
        const read = host.requests.slice(asked).filter((each) => /\/pulls\/\d+/.test(each));
        assert.deepStrictEqual(read, []);
      });
    });

    describe('brewed by its number (ADR 0329)', () => {
      const issue = (command: Parameters<ReturnType<typeof log>['issue']>[0]) =>
        assert.equal(log().issue(command, t0).kind, 'accepted', JSON.stringify(command));
      const opened = () => {
        issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } });
        const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
        issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } });
      };
      const byNumber = { ...request, target: { issue: 40 } };

      it('finishes the release a cancelled batch left due, and still says it was cancelled: exit 6', async () => {
        const host = fakeGitHubApi({
          login: 'ann',
          issues: {
            ...github().issues,
            'acme/brewery': [{ number: 40, labels: [], author: 'ann', title: 'Dark' }],
          },
        });
        host.issue('acme/web', 7)?.labels.push('foedrum:claimed');
        opened();
        issue({ kind: 'cancel', batchId: 'web-7', by: 'ann', via: 'terminal' });
        const brewing = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
        assert.equal(await runBrew(targetSetup(), brewing, byNumber), 6, f.lines.join('\n'));
        const comments = host.comments.get('acme/web#7') ?? [];
        assert.match(comments.at(-1)?.body ?? '', /released its claim.*was cancelled/);
        assert.ok(!host.issue('acme/web', 7)?.labels.includes('foedrum:claimed'));
        assert.notEqual(host.issue('acme/brewery', 40)?.state, 'closed');
        assert.deepStrictEqual([...log().state().batches.keys()], ['web-7']);
        assert.deepStrictEqual(host.created, []);
        assert.equal(
          f.lines.at(-2),
          'foedrum brew: claim on acme/web#7 released; Brewery issue #40 stays open, unassign it to make it available',
        );
        assert.match(f.lines.at(-1) ?? '', /^foedrum brew: #40 was cancelled/);
      });

      it('foedrum mash of a batch whose release is still due names foedrum brew', async () => {
        opened();
        f.store.withTransaction((tx) =>
          tx.append({ type: 'batch.on_tap', batchId: 'web-7', pullRequests: [] }),
        );
        const mash = { ...byNumber, mash: true as const };
        const mashing = () =>
          shell(behave.succeed(), { gh: ghOver(github().fetch).exec, lock: () => fakeLock('ann') });
        assert.equal(await runBrew(targetSetup(), mashing(), mash), 5, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-1),
          'foedrum mash: #40 is on tap; its release is still due, and foedrum brew 40 finishes it',
        );
      });

      it('says foedrum order of the number for an ended batch', async () => {
        opened();
        issue({ kind: 'cancel', batchId: 'web-7', by: 'ann', via: 'terminal' });
        for (const effect of ['release.label', 'release.comment', 'release.ref']) {
          const key = effectKey.encode({ batchId: 'web-7', effect });
          issue({ kind: 'record', event: { type: 'effect.applied', key, result: 'done' } });
        }
        const brewing = shell(behave.succeed(), { gh: ghOver(github().fetch).exec });
        assert.equal(await runBrew(targetSetup(), brewing, byNumber), 5, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-1),
          'foedrum brew: #40 is cancelled; foedrum order 40 orders it again',
        );
      });

      it('says foedrum continue of the number for a paused claimed order, never that it is a sub-order', async () => {
        opened();
        issue({ kind: 'pause', order: { issue: 7, repo: 'acme/web' }, by: 'ann', via: 'terminal' });
        const brewing = shell(behave.succeed(), { gh: ghOver(github().fetch).exec });
        assert.equal(await runBrew(targetSetup(), brewing, byNumber), 5, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-1),
          'foedrum brew: #40 is paused; foedrum continue 40 lets it brew',
        );
      });
    });

    it('foedrum brew claims again when a batch ordered again found its Brewery issue deleted: regression test', async () => {
      const host = github();
      const issue = (command: Parameters<ReturnType<typeof log>['issue']>[0]) =>
        assert.equal(log().issue(command, t0).kind, 'accepted', JSON.stringify(command));
      const record = (batchId: string, effect: string, result: number | string) =>
        issue({
          kind: 'record',
          event: { type: 'effect.applied', key: effectKey.encode({ batchId, effect }), result },
        });
      const order = { issue: 7, repo: 'acme/web' };
      issue({ kind: 'order', batchId: 'web-7', order });
      record('web-7', 'order.issue', 40);
      issue({ kind: 'cancel', batchId: 'web-7', by: 'ann', via: 'terminal' });
      for (const effect of ['release.label', 'release.comment', 'release.ref']) {
        record('web-7', effect, 'done');
      }
      issue({ kind: 'order_again', batchId: 'web-7-2', order, by: 'ann', via: 'terminal' });
      record('web-7-2', 'order.reopen', 'gone');
      issue({ kind: 'cancel', batchId: 'web-7-2', by: 'ann', via: 'terminal' });
      for (const effect of ['release.label', 'release.comment', 'release.ref']) {
        record('web-7-2', effect, 'done');
      }
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 5, f.lines.join('\n'));
      assert.ok(log().state().batches.has('web-7-3'), f.lines.join('\n'));
    });

    /** The live lease of the claimed batch web-7. */
    const webLease = () => f.store.batchLeases(t0).find(({ batchId }) => batchId === 'web-7');

    it('lets a claimed batch go once it waits for a label on its Brewery issue, holding no lease: exit 5 (ADR 0123)', async () => {
      const host = github();
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 5, f.lines.join('\n'));
      assert.match(f.lines.at(-1) ?? '', /waits for a recipe:<name> label on its Brewery issue #/);
      assert.equal(webLease(), undefined);
    });

    it('lets a claimed batch go when its Brewery issue is not open yet, holding no lease: exit 1 (ADR 0123)', async () => {
      const host = fakeGitHubApi({
        login: 'ann',
        issues: github().issues,
        instead: (method, url) =>
          method === 'POST' && url.pathname.toLowerCase() === '/repos/acme/brewery/issues'
            ? { status: 500, body: { message: 'Server Error' } }
            : undefined,
      });
      const claimed = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), claimed, target), 1, f.lines.join('\n'));
      assert.match(f.lines.at(-1) ?? '', /waits for its Brewery issue, which is not open yet/);
      assert.equal(webLease(), undefined);
    });

    it('refuses it, ordering nothing, when another holds its claim: exit 5', async () => {
      const host = github();
      // Another Brewery's claim: its record as a commit, and the ref at it (ADR 0043).
      const api = 'https://api.github.com/repos/acme/web/git';
      const claimedAt = t0.toISOString();
      const record = JSON.stringify({ brewery: 'other/brewery', issue: 7, claimedAt });
      const commit = await host.fetch(`${api}/commits`, {
        method: 'POST',
        body: JSON.stringify({ message: record, tree: 'x', parents: [] }),
      });
      const { sha } = (await commit.json()) as { sha: string };
      await host.fetch(`${api}/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: 'refs/foedrum/claims/issues/7', sha }),
      });
      const taken = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
      assert.equal(await runBrew(targetSetup(), taken, target), 5, f.lines.join('\n'));
      assert.equal(log().state().batches.size, 0);
      assert.equal(f.lines.at(-1), 'foedrum brew: acme/web#7 is claimed by other/brewery');
    });
  });
});
