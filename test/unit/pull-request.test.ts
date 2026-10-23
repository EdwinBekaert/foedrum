// The openPullRequest action's pure core (ADR 0071): the bottle branch, the pull request the ledger
// recorded, what each step reported, and the pull request's text from the order and those reports.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fold } from '../../src/engine/fold.ts';
import {
  bottleBranch,
  openedPullRequest,
  pullRequestText,
  stepReports,
} from '../../src/engine/pull-request.ts';
import type { Event } from '../../src/schemas/events.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';

type Output = Extract<StepOutcome, { kind: 'succeeded' }>['output'];

// Built at run time, so no scanner takes this file for one that holds a token.
const token = ['ghp', 'A1b2'.repeat(9)].join('_');
const aws = ['AKIA', 'Z'.repeat(16)].join('');

const ordered: Event = {
  type: 'batch.ordered',
  batchId: '12-1',
  order: { issue: 12 },
  routeBy: '2026-12-31T00:00:00.000Z',
};
const chosen: Event = {
  type: 'batch.recipe_chosen',
  batchId: '12-1',
  recipe: 'ale',
  reason: 'label',
  source: 'label',
};
/** Attempt `attempt` of `stepId`, scheduled, started and finished with `output` or a failure. */
const ran = (stepId: string, attempt: number, output?: Output): Event[] => [
  {
    type: 'step.scheduled',
    batchId: '12-1',
    stepId,
    attempt,
    deadlineAt: '2026-10-15T13:00:00.000Z',
  },
  { type: 'step.started', batchId: '12-1', stepId, attempt },
  {
    type: 'step.finished',
    batchId: '12-1',
    stepId,
    attempt,
    outcome:
      output === undefined
        ? { kind: 'failed', retryable: true, reason: 'crashed' }
        : { kind: 'succeeded', output },
  },
];
const outDoc = (summary: string, assumptions: string[] = []) => ({
  status: 'done',
  summary,
  assumptions,
});

describe('bottleBranch', () => {
  it("is the batch's branch for the repository, outside the attempts' branches", () => {
    assert.equal(bottleBranch('12-1', 'Acme/API'), 'foedrum/12-1/acme.api');
  });
});

describe('openedPullRequest', () => {
  it("is the URL the ledger recorded under the batch's pull_request key", () => {
    const url = 'https://github.com/acme/api/pull/9';
    const applied: Event = {
      type: 'effect.applied',
      key: JSON.stringify(['12-1', 'pull_request']),
      result: url,
    };
    assert.equal(openedPullRequest(fold([ordered, applied]), '12-1'), url);
  });

  it('is undefined before it is recorded, and for another batch or effect', () => {
    const applied: Event = {
      type: 'effect.applied',
      key: JSON.stringify(['12-1', 'push']),
      result: { commit: 'a'.repeat(40) },
    };
    assert.equal(openedPullRequest(fold([ordered]), '12-1'), undefined);
    assert.equal(openedPullRequest(fold([ordered, applied]), '12-1'), undefined);
    assert.equal(openedPullRequest(fold([ordered, applied]), '13-1'), undefined);
  });
});

describe('stepReports', () => {
  it("gives each step's latest succeeded out doc, in the order the steps were first scheduled", () => {
    const state = fold([
      ordered,
      chosen,
      ...ran('plan', 1, outDoc('Planned the flag', ['No config file'])),
      ...ran('implement', 1, outDoc('First try')),
      ...ran('implement', 2),
      ...ran('implement', 3, outDoc('Added --json')),
      ...ran('plan', 2, outDoc('Planned again')),
    ]);
    const batch = state.batches.get('12-1');
    assert.ok(batch !== undefined);
    assert.deepEqual(stepReports(batch), [
      { stepId: 'plan', summary: 'Planned again', assumptions: [] },
      { stepId: 'implement', summary: 'Added --json', assumptions: [] },
    ]);
  });

  it('leaves out a step without an out doc: a check, or one that never succeeded', () => {
    const state = fold([
      ordered,
      chosen,
      ...ran('plan', 1, outDoc('Planned', ['Keep v1'])),
      ...ran('green', 1, null),
      ...ran('review', 1),
    ]);
    const batch = state.batches.get('12-1');
    assert.ok(batch !== undefined);
    assert.deepEqual(stepReports(batch), [
      { stepId: 'plan', summary: 'Planned', assumptions: ['Keep v1'] },
    ]);
  });
});

const blocker = {
  file: 'src/wait.ts',
  line: 13,
  severity: 'blocker' as const,
  why: 'The poll has no deadline',
  introduced: true,
};
const before = { severity: 'minor' as const, why: 'The module has no tests', introduced: false };

describe("stepReports: a Taster's findings (ADR 0161)", () => {
  it("gives a Taster's verdict and findings with its summary", () => {
    const tasted = { ...outDoc('Tasted'), verdict: 'changes', findings: [blocker, before] };
    const state = fold([ordered, chosen, ...ran('correctness', 1, tasted)]);
    const batch = state.batches.get('12-1');
    assert.ok(batch !== undefined);
    assert.deepEqual(stepReports(batch), [
      {
        stepId: 'correctness',
        summary: 'Tasted',
        assumptions: [],
        tasting: { verdict: 'changes', findings: [blocker, before] },
      },
    ]);
  });
});

describe('pullRequestText', () => {
  const closes = { repo: 'acme/brewery', issue: 12 };

  it("lists a Taster's verdict and each finding under its step, saying which were there before", () => {
    const reports = [
      {
        stepId: 'correctness',
        summary: 'One blocker',
        assumptions: [],
        tasting: { verdict: 'changes' as const, findings: [blocker, before] },
      },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.equal(
      body.split('\n').slice(3, 7).join('\n'),
      [
        'correctness: One blocker',
        '  verdict: changes',
        '  finding: blocker in src/wait.ts:13: The poll has no deadline',
        '  finding, there before the change: minor: The module has no tests',
      ].join('\n'),
    );
  });

  it("takes the order's title, and closes the order's issue", () => {
    const text = pullRequestText({ title: 'Add a --json flag', closes, reports: [] });
    assert.equal(text.title, 'Add a --json flag');
    assert.equal(text.body.split('\n').at(-1), 'Closes acme/brewery#12');
  });

  it('quotes what each step reported as text, where nothing in it links, mentions or closes', () => {
    const reports = [
      { stepId: 'plan', summary: 'Fixes #3 for @octocat', assumptions: ['No config file'] },
      { stepId: 'implement', summary: 'Added --json', assumptions: [] },
    ];
    const { body } = pullRequestText({ title: 'Add a --json flag', closes, reports });
    assert.equal(
      body,
      [
        'Brewed by Foedrum from acme/brewery#12. What each step reported:',
        '',
        '```text',
        'plan: Fixes #3 for @octocat',
        '  assumed: No config file',
        'implement: Added --json',
        '```',
        '',
        'Closes acme/brewery#12',
      ].join('\n'),
    );
  });

  it('uses a fence longer than any run of backticks in the reports', () => {
    const reports = [{ stepId: 'plan', summary: 'Ran ```` and ``` here', assumptions: [] }];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    const lines = body.split('\n');
    assert.equal(lines[2], '`````text');
    assert.equal(lines[4], '`````');
  });

  it('says so when no step reported anything', () => {
    const { body } = pullRequestText({ title: 'T', closes, reports: [] });
    assert.equal(body, 'Brewed by Foedrum from acme/brewery#12.\n\nCloses acme/brewery#12');
  });

  it('keeps the title on one line of at most 256 characters, else names the order', () => {
    assert.equal(
      pullRequestText({ title: ' Fix\r\nit\t now ', closes, reports: [] }).title,
      'Fix it now',
    );
    assert.equal(
      pullRequestText({ title: 'x'.repeat(300), closes, reports: [] }).title.length,
      256,
    );
    assert.equal(pullRequestText({ title: ' \n ', closes, reports: [] }).title, 'acme/brewery#12');
  });

  it('stays within the limit when a report is one long run of backticks (review of #198)', () => {
    const reports = [{ stepId: 'plan', summary: '`'.repeat(30_000), assumptions: [] }];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.ok(body.length <= 65_536, `${body.length}`);
    assert.ok(body.endsWith('\nCloses acme/brewery#12'));
  });

  it("cuts the reports short within GitHub's limit of a body, saying so", () => {
    const reports = Array.from({ length: 100 }, (_, i) => ({
      stepId: `s${i}`,
      summary: 'y'.repeat(1_000),
      assumptions: [],
    }));
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.ok(body.length <= 65_536, `${body.length}`);
    assert.match(body, /\n\(cut short\)\n```\n\nCloses acme\/brewery#12$/);
  });

  it('leaves out a summary and an assumption that look like a secret, naming the step (#235)', () => {
    const reports = [
      { stepId: 'plan', summary: `Read ${token}`, assumptions: ['No config file'] },
      { stepId: 'implement', summary: 'Added --json', assumptions: [`AWS key ${aws}`, 'Tabs'] },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.equal(
      body,
      [
        'Brewed by Foedrum from acme/brewery#12. What each step reported:',
        '',
        '```text',
        'plan: [left out: a text of step plan that looks like a secret]',
        '  assumed: No config file',
        'implement: Added --json',
        '  assumed: [left out: a text of step implement that looks like a secret]',
        '  assumed: Tabs',
        '```',
        '',
        'Closes acme/brewery#12',
      ].join('\n'),
    );
    assert.doesNotMatch(body, /ghp_|A1b2|AKIA/);
  });

  it('reads only the reports it can show, so a token past the cut does not hide them', () => {
    const reports = [
      { stepId: 'plan', summary: `${'y '.repeat(40_000)}${token}`, assumptions: [] },
      { stepId: 'implement', summary: token, assumptions: [] },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.match(body, /^plan: y y y/m);
    assert.match(body, /\n\(cut short\)\n```\n\nCloses acme\/brewery#12$/);
    assert.doesNotMatch(body, /ghp_|A1b2/);
  });

  it('says it is cut short when it stopped reading, though the backticks it read shrink', () => {
    const reports = [{ stepId: 'plan', summary: '`'.repeat(70_000), assumptions: [] }];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.match(body, /\n\(cut short\)\n`+\n\nCloses acme\/brewery#12$/);
  });

  it('keeps a commit hash that `isCommit` knows, and leaves out one it does not', () => {
    const sha = 'a'.repeat(40);
    const reports = [{ stepId: 'plan', summary: `Reverted ${sha}`, assumptions: [] }];
    const known = pullRequestText({ title: 'T', closes, reports, isCommit: (w) => w === sha });
    assert.match(known.body, new RegExp(`plan: Reverted ${sha}`));
    const unknown = pullRequestText({ title: 'T', closes, reports });
    assert.doesNotMatch(unknown.body, new RegExp(sha));
  });
});
