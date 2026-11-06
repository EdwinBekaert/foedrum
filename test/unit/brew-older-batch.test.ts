// A batch that is not its issue's latest, waiting for a session (ADR 0339): what each line offers
// for it, and what that command opens. A batch on tap counts as ended, so a later batch can be
// ordered, and its failed pull request can then send it back along a route through an interactive
// step. serve's shell with an in-memory store, fake worktrees, a fake GitHub and the scripted runner;
// no process starts (ADR 0021).

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { runBrew } from '../../src/cli/brew.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { describeLane } from '../../src/cli/status.ts';
import { formatStuck } from '../../src/cli/stuck.ts';
import { calledAs } from '../../src/engine/claim-orders.ts';
import { foldedBatch } from '../../src/engine/fold.ts';
import { brewFixture, request, t0 } from '../helpers/brew-fixture.ts';
import { type Behaviour, behave } from '../helpers/fake-brewer-runner.ts';
import { fakeGitHubApi } from '../helpers/fake-github-api.ts';
import { fakeLock } from '../helpers/fake-lock.ts';
import { FAKE_COMMIT } from '../helpers/fake-worktrees.ts';
import { failedCheck } from '../helpers/open-pull-request.ts';
import { brewer, local, serveInputs } from '../helpers/serve-brewery.ts';

const RECIPE = JSON.stringify({
  name: 'lauter',
  description: 'A session, then a pull request whose failure goes back to the session.',
  steps: [
    { id: 'refine', brewer: 'steward', interactive: true, prompt: 'Refine it with me.' },
    { action: 'openPullRequest', onPullRequestFail: { goto: 'refine', maxRounds: 2 } },
  ],
  testFirst: false,
});
const STEWARD = brewer
  .replace('"cellarman"', '"steward"')
  .replace('"maxAttempts": 1', '"maxAttempts": 3');

describe('an older batch waiting for a session (ADR 0339)', () => {
  const f = brewFixture();
  const issued = { by: 'ann', via: 'terminal' } as const;

  const shell = (behaviour: Behaviour = behave.succeed('Refined')) =>
    f.shell(behaviour, { lock: () => fakeLock('ann') });

  /** Batch 12-1 sent back by its pull request and parked at refine, with 12-2 ordered after it. */
  const parked = async (): Promise<void> => {
    assert.equal(await runBrew(f.setup, shell(), request), 0, f.lines.join('\n'));
    const log = f.log();
    const onTap = foldedBatch(log.state(), '12-1');
    const [pullRequest] = onTap.lane.kind === 'on_tap' ? onTap.lane.pullRequests : [];
    assert.ok(pullRequest !== undefined, 'batch 12-1 opened its pull request');
    const accept = (command: Parameters<typeof log.issue>[0]): void => {
      const decision = log.issue(command, t0);
      assert.equal(decision.kind, 'accepted', JSON.stringify(decision));
    };
    accept({ kind: 'order', batchId: '12-2', order: { issue: 12 }, ...issued });
    accept({
      kind: 'record',
      event: {
        type: 'pull_request.checks_finished',
        batchId: '12-1',
        pullRequest,
        head: FAKE_COMMIT,
        checks: [failedCheck],
      },
    });
    const cause = { kind: 'checks' } as const;
    const head = FAKE_COMMIT;
    accept({ kind: 'fix_pull_request', batchId: '12-1', pullRequest, head, cause });
    accept({ kind: 'await_session', batchId: '12-1', stepId: 'refine', attempt: 2 });
    f.lines.length = 0;
  };

  beforeEach(() => {
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
          recipes: [...brewery.recipes, { path: 'recipes/lauter.jsonc', text: RECIPE }],
          brewers: [...brewery.brewers, { path: 'brewers/steward.md', text: STEWARD }],
        },
      },
    });
    f.setup = result.kind === 'ready' ? result.setup : assert.fail(JSON.stringify(result));
    f.api = fakeGitHubApi({
      login: 'ann',
      issues: {
        'acme/brewery': [
          { number: 12, labels: ['recipe:lauter'], author: 'ann', title: 'L', body: 'Plan it.' },
        ],
      },
    });
  });

  describe('the lines that offer its session', () => {
    it('foedrum status names its id: regression test', async () => {
      await parked();
      const state = f.log().state();
      const older = foldedBatch(state, '12-1');
      assert.match(
        describeLane(older, calledAs(state, older)).detail,
        /^waiting for a session at refine: foedrum brew 12-1 --take opens it in a terminal/,
      );
    });

    it('foedrum stuck names its id: regression test', async () => {
      await parked();
      assert.match(formatStuck(f.log().state()), /foedrum brew 12-1 --take opens it in a terminal/);
    });
  });
});
