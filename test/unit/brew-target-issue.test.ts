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
import { type FakeGitHubApi, fakeGitHubApi } from '../helpers/fake-github-api.ts';
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
      assert.ok(
        f.lines.includes('foedrum brew: ordered acme/web#7 as batch web-7'),
        f.lines.join('\n'),
      );
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
        `foedrum brew: acme/web#7 waits for a recipe:<name> label on its Brewery issue #${order.number}; label it and brew ${order.number}, or foedrum mash ${order.number}`,
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
        `foedrum brew: acme/web#7 waits for a recipe:<name> label on its Brewery issue #${order?.number}; label it and brew ${order?.number}, or foedrum mash ${order?.number}`,
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
        'foedrum brew: acme/web#7 waits for its Brewery issue, which is not open yet; brew web#7 again',
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

    describe('brewed by its number (ADR 0329)', () => {
      const issue = (command: Parameters<ReturnType<typeof log>['issue']>[0]) =>
        assert.equal(log().issue(command, t0).kind, 'accepted', JSON.stringify(command));
      const opened = () => {
        issue({ kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } });
        const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
        issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } });
      };
      const byNumber = { ...request, target: { issue: 40 } };

      it('says foedrum order of the number for an ended batch', async () => {
        opened();
        issue({ kind: 'cancel', batchId: 'web-7', by: 'ann', via: 'terminal' });
        const brewing = shell(behave.succeed(), { gh: ghOver(github().fetch).exec });
        assert.equal(await runBrew(targetSetup(), brewing, byNumber), 5, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-1),
          'foedrum brew: batch web-7 of #40 is cancelled; foedrum order 40 orders it again',
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
