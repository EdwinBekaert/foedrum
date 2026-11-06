// Every line and question of a claimed order names its Brewery issue's number (ADR 0329, ADR 0334),
// from `foedrum brew web#7` to its pull request, through runBrew on the fake host. serve's shell
// with an in-memory store, fake worktrees and the scripted runner; no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runBrew } from '../../src/cli/brew.ts';
import { type ServeSetup, serveSetup } from '../../src/cli/serve-config.ts';
import { brewFixture, request, t0 } from '../helpers/brew-fixture.ts';
import { behave } from '../helpers/fake-brewer-runner.ts';
import { ghOver } from '../helpers/fake-gh.ts';
import { type FakeGitHubApi, fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { config, local, serveInputs } from '../helpers/serve-brewery.ts';

/** What each command a line offers is given: `answer 40`, `brew 40`. */
const offered = (lines: readonly string[]): string[] =>
  lines.flatMap((line) =>
    [...line.matchAll(/\bfoedrum ([a-z]+) (\S+)/g)].map(([, command, arg]) => `${command} ${arg}`),
  );

describe('every line names the number (ADR 0329, ADR 0334)', () => {
  const f = brewFixture();
  const { log, shell } = f;
  const web = { alias: 'web', intake: { labels: ['foedrum'] } };
  const claiming = (): ServeSetup => {
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
  const github = (): FakeGitHubApi =>
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
  const byAlias = { ...request, target: { alias: 'web', issue: 7 } };

  /** Claims web#7, and gives its fresh Brewery issue a label: that issue's number. */
  const claim = async (host: FakeGitHubApi, brewing: ServeSetup): Promise<number> => {
    const first = shell(behave.succeed(), { gh: ghOver(host.fetch).exec });
    assert.equal(await runBrew(brewing, first, byAlias), 5, f.lines.join('\n'));
    const [order] = host.issues['acme/brewery'] ?? [];
    assert.ok(order !== undefined, 'its Brewery issue is opened');
    // A number no target issue here has, so a line cannot get it from the claim.
    assert.notEqual(order.number, 7);
    order.labels.push('recipe:stout');
    return order.number;
  };
  const again = (host: FakeGitHubApi, brew = behave.succeed()) =>
    shell(brew, { gh: ghOver(host.fetch).exec, lock: () => fakeLock('ann') });

  it('the line after a claim offers only commands that use the number', async () => {
    const number = await claim(github(), claiming());
    assert.deepStrictEqual(offered(f.lines), [`mash ${number}`]);
    assert.ok(f.lines.at(-1)?.includes(`brew ${number},`), f.lines.join('\n'));
    assert.ok(!f.lines.some((line) => line.includes('web-7')), f.lines.join('\n'));
  });

  it('a question on a claimed order says the Brewery number', async () => {
    const host = github();
    const brewing = claiming();
    const number = await claim(host, brewing);
    f.lines.length = 0;
    const target = { ...request, target: { issue: number } };
    const asks = again(host, behave.needInput());
    assert.equal(await runBrew(brewing, asks, target), 4, f.lines.join('\n'));
    assert.ok(
      f.lines.includes(`foedrum brew: #${number} needs input at brew:`),
      f.lines.join('\n'),
    );
    assert.equal(
      f.lines.at(-1),
      `foedrum brew: answer them in order with foedrum answer ${number} <answer 1>, then brew again`,
    );
    const comments = host.comments.get(`acme/brewery#${number}`) ?? [];
    assert.ok(
      comments.some(({ body }) => body.includes(`\`foedrum answer ${number} <answer 1>\``)),
      comments.map(({ body }) => body).join('\n---\n'),
    );
  });

  it('a claimed order goes from foedrum brew web#7 to its pull request by its number alone', async () => {
    const host = github();
    const brewing = claiming();
    const number = await claim(host, brewing);
    f.lines.length = 0;
    const target = { ...request, target: { issue: number } };
    const asks = again(host, behave.needInput());
    assert.equal(await runBrew(brewing, asks, target), 4, f.lines.join('\n'));
    const batch = log().state().batches.get('web-7');
    const { lane } = batch ?? {};
    assert.ok(lane?.kind === 'stuck' && lane.reason.kind === 'needs_input');
    const answers = lane.reason.questions.map(({ q, recommended }) => ({ q, answer: recommended }));
    const answer = {
      kind: 'answer',
      batchId: 'web-7',
      by: 'ann',
      via: 'terminal',
      answers,
    } as const;
    const decided = log().issue(answer, t0);
    assert.equal(decided.kind, 'accepted', JSON.stringify(decided));
    assert.equal(await runBrew(brewing, again(host), target), 0, f.lines.join('\n'));
    // `foedrum serve closes` names no issue: the other way a merge is read.
    const commands = offered(f.lines).filter((each) => !each.startsWith('serve '));
    assert.deepStrictEqual([...new Set(commands)], [`answer ${number}`, `brew ${number}`]);
    // The driver's own notice of its cleanup keeps the id, with the folders it names (ADR 0334).
    const told = f.lines.filter((line) => !line.includes('cleaned batch'));
    assert.ok(!told.some((line) => line.includes('web-7')), f.lines.join('\n'));
    const said = new RegExp(`^foedrum brew: #${number} is on tap: `);
    assert.match(f.lines.at(-1) ?? '', said);
  });
});
