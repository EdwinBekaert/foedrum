// An interactive step through runBrew (ADR 0222): its session in the foreground, and what brew does
// when the machine opens none. serve's shell with an in-memory store, fake worktrees, a fake GitHub
// and the scripted runner; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { runBrew } from '../../src/cli/brew.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { brewFixture, request, t0 } from '../helpers/brew-fixture.ts';
import { testGuidance } from '../helpers/brewery-files.ts';
import { behave } from '../helpers/fake-brewer-runner.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { brewer, config, local, serveInputs } from '../helpers/serve-brewery.ts';

describe('runBrew', () => {
  const f = brewFixture();
  const { log, shell } = f;

  describe('an interactive step (ADR 0222)', () => {
    // A cellarman with attempts to spare, whose refine step is a person's session.
    const lauter = JSON.stringify({
      name: 'lauter',
      type: 'brew',
      description: 'Refines an order with a person, then opens its pull request.',
      guidance: testGuidance,
      steps: [
        { id: 'refine', brewer: 'steward', interactive: true, prompt: 'Refine it with me.' },
        { action: 'openPullRequest' },
      ],
      testFirst: false,
    });
    const steward = brewer
      .replace('"cellarman"', '"steward"')
      .replace('"maxAttempts": 1', '"maxAttempts": 3');
    /** The Brewery with the lauter recipe and `stewardText` as its steward. */
    const lauterSetup = (stewardText: string): ServeSetup => {
      const inputs = serveInputs({
        files: { ...serveInputs().files, local: local({ workRoot: f.dir.path }) },
      });
      const { brewery } = inputs.files;
      const result = serveSetup({
        ...inputs,
        files: {
          ...inputs.files,
          brewery: {
            ...brewery,
            recipes: [...brewery.recipes, { path: 'recipes/lauter.jsonc', text: lauter }],
            brewers: [...brewery.brewers, { path: 'brewers/steward.md', text: stewardText }],
          },
        },
      });
      return result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    };
    beforeEach(() => {
      f.setup = lauterSetup(steward);
      f.api = fakeGitHubApi({
        login: 'ann',
        issues: {
          'acme/brewery': [
            {
              number: 12,
              labels: ['recipe:lauter'],
              author: 'ann',
              title: 'Lauter',
              body: 'Plan it.',
            },
          ],
        },
      });
    });
    describe("a claimed order's session (ADR 0329)", () => {
      const web = { alias: 'web', intake: { labels: ['foedrum'] } };
      const claimedSetup = (): ServeSetup => {
        const inputs = serveInputs({
          files: {
            ...serveInputs().files,
            config: config({}, web),
            local: local({ workRoot: f.dir.path }),
          },
        });
        const { brewery } = inputs.files;
        const result = serveSetup({
          ...inputs,
          files: {
            ...inputs.files,
            brewery: {
              ...brewery,
              recipes: [...brewery.recipes, { path: 'recipes/lauter.jsonc', text: lauter }],
              brewers: [...brewery.brewers, { path: 'brewers/steward.md', text: steward }],
            },
          },
        });
        return result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
      };
      const hosted = (brewery: { number: number; labels: string[] }[]) =>
        fakeGitHubApi({
          login: 'ann',
          issues: {
            'acme/brewery': brewery.map((issue) => ({
              ...issue,
              author: 'ann',
              title: 'Lauter',
              body: 'web#7',
            })),
            'acme/web': [
              { number: 7, labels: ['foedrum'], author: 'ann', title: 'Lauter', body: 'Plan it.' },
            ],
          },
        });
      const ordered = { kind: 'order', batchId: 'web-7', order: { issue: 7, repo: 'acme/web' } };
      const inside = { noSessions: 'claude-code' } as const;

      it('names its number in the line that opens it, the lane and the status comment', async () => {
        const host = hosted([{ number: 40, labels: ['recipe:lauter'] }]);
        log().issue({ ...ordered, kind: 'order' }, t0);
        const key = effectKey.encode({ batchId: 'web-7', effect: 'order.issue' });
        log().issue({ kind: 'record', event: { type: 'effect.applied', key, result: 40 } }, t0);
        const byOrder = { ...request, target: { issue: 40 }, ...inside };
        const parked = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
        assert.equal(await runBrew(claimedSetup(), parked, byOrder), 3, f.lines.join('\n'));
        assert.equal(
          f.lines.at(-1),
          'foedrum brew: run foedrum brew 40 in a terminal to open its session',
        );
        assert.match(f.lines.at(-3) ?? '', /foedrum brew 40 --take opens it in a terminal/);
        const [comment] = host.comments.get('acme/brewery#40') ?? [];
        assert.match(comment?.body ?? '', /run `foedrum brew 40 --take` in a terminal/);
      });

      it('names the number of a Brewery issue that opened during the run it was brewed by its target issue', async () => {
        const host = hosted([]);
        log().issue({ ...ordered, kind: 'order' }, t0);
        const route = {
          kind: 'route',
          batchId: 'web-7',
          recipe: 'lauter',
          reason: 'label',
          source: 'label',
        } as const;
        log().issue(route, t0);
        const byTarget = { ...request, target: { alias: 'web', issue: 7 }, ...inside };
        const parked = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
        assert.equal(await runBrew(claimedSetup(), parked, byTarget), 3, f.lines.join('\n'));
        const [order] = host.issues['acme/brewery'] ?? [];
        assert.ok(order !== undefined, 'its Brewery issue is opened');
        assert.equal(
          f.lines.at(-1),
          `foedrum brew: run foedrum brew ${order.number} in a terminal to open its session`,
        );
      });
    });

    const resumedBy = () =>
      f.store
        .eventsAfter(0)
        .flatMap(({ event }) =>
          event.type === 'batch.resumed' ? [`${event.action} by ${event.by} via ${event.via}`] : [],
        );

    it('opens the session on a terminal and goes on from its out doc to on tap: exit 0', async () => {
      assert.equal(await runBrew(f.setup, shell(behave.succeed('Refined')), request), 0);
      assert.deepStrictEqual(f.started, ['refine#1']);
      const opened = f.store
        .eventsAfter(0)
        .find(({ event }) => event.type === 'step.started' && event.stepId === 'refine');
      assert.equal(
        opened?.event.type === 'step.started' ? opened.event.interactiveSince : undefined,
        t0.toISOString(),
      );
    });

    it('parks the batch without a terminal, starting nothing, and says why: exit 3', async () => {
      const piped = { ...request, noSessions: 'no-terminal' } as const;
      assert.equal(await runBrew(f.setup, shell(behave.succeed()), piped), 3);
      assert.deepStrictEqual(f.started, []);
      assert.equal(
        f.lines.at(-3),
        'foedrum brew: #12 is waiting for you: open its session: step refine is done by a person in a session: foedrum brew 12 --take opens it in a terminal',
      );
      assert.equal(
        f.lines.at(-1),
        'foedrum brew: stdin is not a terminal, and claude needs one: run foedrum brew 12 in a terminal',
      );
    });

    it('opens nothing in the tick after a batch parks waiting for a session, and says it waits for you once: regression test (#863)', async () => {
      assert.equal(await runBrew(f.setup, shell(behave.fail(true)), request), 3);
      assert.deepStrictEqual(f.started, ['refine#1']);
      const stuck = f.lines.filter((line) => line.includes(' is waiting for you: '));
      assert.equal(stuck.length, 1, f.lines.join('\n'));
      assert.match(
        stuck[0] ?? '',
        /open its session: step refine is done by a person in a session/,
      );
      const body = f.api.comments.get('acme/brewery#12')?.[0]?.body ?? '';
      assert.match(
        body,
        /🔔 \*\*Waiting for you: open its session\*\*: step `refine` is done by a person in a session/,
      );
    });

    it('parks the batch inside Claude Code, and names the brew to run in a terminal: exit 3', async () => {
      const inside = { ...request, noSessions: 'claude-code' } as const;
      assert.equal(await runBrew(f.setup, shell(behave.succeed()), inside), 3);
      assert.equal(
        f.lines.at(-1),
        'foedrum brew: run foedrum brew 12 in a terminal to open its session',
      );
    });

    it('waits for a session again, never retrying by itself, when the session closes without an out doc: exit 3', async () => {
      assert.equal(await runBrew(f.setup, shell(behave.fail(true)), request), 3);
      assert.deepStrictEqual(f.started, ['refine#1']);
      assert.equal(log().state().batches.get('12-1')?.lane.kind, 'stuck');
      assert.equal(f.lines.at(-1), 'foedrum brew: run foedrum brew 12 again to reopen the session');
    });

    it('retries a batch it finds waiting for a session at its start, as the person, and opens the session: exit 0', async () => {
      const piped = { ...request, noSessions: 'no-terminal' } as const;
      assert.equal(await runBrew(f.setup, shell(behave.succeed()), piped), 3);
      const again = shell(behave.succeed('Refined'), { lock: () => fakeLock('ann') });
      assert.equal(await runBrew(f.setup, again, request), 0);
      assert.deepStrictEqual(resumedBy(), ['retry by ann via terminal']);
      assert.deepStrictEqual(f.started, ['refine#2']);
      assert.ok(
        f.lines.includes('foedrum brew: #12 waits for a session at refine; opening it'),
        String(f.lines),
      );
    });

    it('reopens the session fresh, with the whole prompt, also for a brewer with retryMode resume (ADR 0222)', async () => {
      f.setup = lauterSetup(
        steward.replace('"maxAttempts": 3', '"maxAttempts": 3,\n  "retryMode": "resume"'),
      );
      assert.equal(await runBrew(f.setup, shell(behave.fail(true)), request), 3);
      const again = shell(behave.succeed('Refined'), { lock: () => fakeLock('ann') });
      assert.equal(await runBrew(f.setup, again, request), 0, String(f.lines));
      const reopened = f.store
        .eventsAfter(0)
        .flatMap(({ event }) =>
          event.type === 'step.started' && event.stepId === 'refine' && event.attempt === 2
            ? [event]
            : [],
        );
      assert.equal(reopened.length, 1);
      assert.equal(reopened[0]?.session?.resumes, undefined);
      // Never even asked to resume: a fallback would say why it could not (ADR 0117).
      assert.equal(reopened[0]?.session?.fallback, undefined);
      assert.ok(reopened[0]?.worktree !== undefined, 'a fresh session gets a worktree of its own');
    });

    it('leaves a batch waiting for a session to the person when it opens none: exit 3', async () => {
      const piped = { ...request, noSessions: 'no-terminal' } as const;
      assert.equal(await runBrew(f.setup, shell(behave.succeed()), piped), 3);
      const again = shell(behave.succeed(), { lock: () => fakeLock('ann') });
      assert.equal(await runBrew(f.setup, again, piped), 3, String(f.lines));
      assert.deepStrictEqual(resumedBy(), []);
      assert.deepStrictEqual(f.started, []);
    });
  });
});
