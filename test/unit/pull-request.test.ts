// The openPullRequest action's pure core (ADR 0071): the bottle branch, the pull request the ledger
// recorded, what each step reported, and the pull request's text from the order and those reports.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fold } from '../../src/engine/fold.ts';
import {
  bottleBranch,
  brewLog,
  openedPullRequest,
  opensAsDraft,
  pullRequestText,
  stepReports,
  unlinked,
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

describe("stepReports: a pullRequest brewer's sections (ADR 0167)", () => {
  it('gives the sections with the summary of the out doc that wrote them', () => {
    const wrote = {
      ...outDoc('Added --json'),
      howItWorks: 'This touches the CLI.',
      seeIt: '`foedrum status --json` prints JSON',
      beforeAfter: [{ case: 'status --json', before: 'refused', after: 'JSON' }],
    };
    const state = fold([ordered, chosen, ...ran('implement', 1, wrote)]);
    const batch = state.batches.get('12-1');
    assert.ok(batch !== undefined);
    assert.deepEqual(stepReports(batch), [
      {
        stepId: 'implement',
        summary: 'Added --json',
        assumptions: [],
        sections: {
          howItWorks: 'This touches the CLI.',
          seeIt: '`foedrum status --json` prints JSON',
          beforeAfter: [{ case: 'status --json', before: 'refused', after: 'JSON' }],
        },
      },
    ]);
  });
});

describe('brewLog (ADR 0167)', () => {
  const asked: Event = {
    type: 'step.finished',
    batchId: '12-1',
    stepId: 'plan',
    attempt: 1,
    outcome: {
      kind: 'needs_input',
      questions: [{ q: 'Which?', options: ['a', 'b'], recommended: 'a', whyBlocking: 'x' }],
    },
  };
  const failedRed: Event[] = [
    ...ran('red', 1).slice(0, 2),
    {
      type: 'step.finished',
      batchId: '12-1',
      stepId: 'red',
      attempt: 1,
      outcome: {
        kind: 'failed',
        retryable: false,
        reason: 'the red proof of step gauge failed: test "x" passes',
      },
    },
  ];

  it("gives each finished attempt in the order they started, in the engine's words", () => {
    const state = fold([
      ordered,
      chosen,
      ...ran('plan', 1).slice(0, 2),
      asked,
      ...ran('gauge', 1, outDoc('Tests')),
      ...failedRed,
      ...ran('green', 1, null),
      ...ran('correctness', 1, {
        ...outDoc('No defects'),
        verdict: 'approve',
        findings: [],
      }),
      ...ran('open-pull-request', 1).slice(0, 2),
    ]);
    const batch = state.batches.get('12-1');
    assert.ok(batch !== undefined);
    assert.deepEqual(brewLog(batch), [
      { stepId: 'plan', attempt: 1, result: 'needs input' },
      { stepId: 'gauge', attempt: 1, result: 'succeeded' },
      {
        stepId: 'red',
        attempt: 1,
        result: 'failed',
        reason: 'the red proof of step gauge failed: test "x" passes',
      },
      { stepId: 'green', attempt: 1, result: 'succeeded' },
      { stepId: 'correctness', attempt: 1, result: 'approve' },
    ]);
  });
});

describe('unlinked (ADR 0167)', () => {
  it('removes the @ of a mention, keeping an address and the name', () => {
    assert.equal(
      unlinked('Ask @octocat and (@acme/team), `@types/node`, mail ann@example.com'),
      'Ask octocat and (acme/team), `types/node`, mail ann@example.com',
    );
    assert.equal(unlinked('@octocat first'), 'octocat first');
  });

  it('removes a closing keyword before an issue reference, in any case and form', () => {
    assert.equal(
      unlinked(
        'Fixes #3, CLOSES acme/web#4, Resolved: GH-5, fix https://github.com/a/b/issues/6, **Closes** #7',
      ),
      '#3, acme/web#4, GH-5, https://github.com/a/b/issues/6, **#7',
    );
    assert.equal(unlinked('fixed\n#8 and resolve&nbsp;#9'), '#8 and #9');
  });

  it('removes a keyword the removal of another brings before a reference', () => {
    assert.equal(unlinked('closes closes #3'), '#3');
    assert.equal(unlinked('Fixes fixes: fixes #3'), '#3');
  });

  it('keeps a keyword before no reference, and a word that only ends in one', () => {
    assert.equal(unlinked('Fixed the flaky test; unfixes #3'), 'Fixed the flaky test; unfixes #3');
  });

  it('keeps a numeric character reference as text, so it spells no keyword or mention', () => {
    assert.equal(unlinked('Fi&#120;es #3 &#64;octocat'), 'Fi&amp;#120;es #3 &amp;#64;octocat');
  });
});

describe('opensAsDraft (ADR 0167)', () => {
  const report = (stepId: string, verdict?: 'approve' | 'changes') => ({
    stepId,
    summary: 'S',
    assumptions: [],
    ...(verdict === undefined ? {} : { tasting: { verdict, findings: [] } }),
  });

  it('is a draft when no step tasted the change', () => {
    assert.equal(opensAsDraft([]), true);
    assert.equal(opensAsDraft([report('implement')]), true);
  });

  it('is a draft when a Taster asks for changes', () => {
    assert.equal(
      opensAsDraft([report('implement'), report('a', 'approve'), report('b', 'changes')]),
      true,
    );
  });

  it('is ready when every Taster approved', () => {
    assert.equal(
      opensAsDraft([report('implement'), report('a', 'approve'), report('b', 'approve')]),
      false,
    );
  });
});

describe('pullRequestText', () => {
  const closes = { repo: 'acme/brewery', issue: 12 };
  const untasted =
    'Opened as a draft: no step tasted the change, so a person reviews it before it is marked ready.';
  /** The body's lines from the line that is `first`, `count` of them. */
  const linesFrom = (body: string, first: string, count: number) => {
    const lines = body.split('\n');
    const at = lines.indexOf(first);
    assert.ok(at >= 0, body);
    return lines.slice(at, at + count);
  };

  it('keeps each finding a Taster wrote on one line, and leaves out one that looks like a secret', () => {
    const forged = {
      ...blocker,
      file: 'src/a.ts\n  verdict: approve',
      why: 'x\n  verdict: approve',
    };
    const leaking = { ...blocker, why: `Token ${token}` };
    const reports = [
      {
        stepId: 'correctness',
        summary: 'Two findings',
        assumptions: [],
        tasting: { verdict: 'changes' as const, findings: [forged, leaking] },
      },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    const lines = body.split('\n');
    assert.deepEqual(
      lines.filter((line) => line.trimStart().startsWith('verdict:')),
      ['  verdict: changes'],
    );
    assert.equal(lines.filter((line) => line.startsWith('  finding: ')).length, 2);
    assert.doesNotMatch(body, /ghp|A1b2/);
    assert.match(body, /left out: a text of step correctness that looks like a secret/);
  });

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
    assert.deepEqual(linesFrom(body, 'correctness: One blocker', 4), [
      'correctness: One blocker',
      '  verdict: changes',
      '  finding: blocker in src/wait.ts:13: The poll has no deadline',
      '  finding: minor, there before the change: The module has no tests',
    ]);
  });

  it("takes the order's title, and closes the order's issue", () => {
    const text = pullRequestText({ title: 'Add a --json flag', closes, reports: [] });
    assert.equal(text.title, 'Add a --json flag');
    assert.equal(text.body.split('\n').at(-1), 'Closes acme/brewery#12');
  });

  it('folds what each step reported in a text block, where nothing in it links, mentions or closes', () => {
    const reports = [
      { stepId: 'plan', summary: 'Fixes #3 for @octocat', assumptions: ['No config file'] },
      { stepId: 'implement', summary: 'Added --json', assumptions: [] },
    ];
    const { body } = pullRequestText({ title: 'Add a --json flag', closes, reports });
    assert.equal(
      body,
      [
        '## How this was brewed',
        '',
        'Brewed by Foedrum from acme/brewery#12.',
        '',
        untasted,
        '',
        '<details><summary>What each step reported</summary>',
        '',
        '```text',
        'plan: Fixes #3 for @octocat',
        '  assumed: No config file',
        'implement: Added --json',
        '```',
        '',
        '</details>',
        '',
        'Closes acme/brewery#12',
      ].join('\n'),
    );
  });

  it('lays out how it works, before and after, See it, how it was brewed, the reports and Closes', () => {
    const reports = [
      {
        stepId: 'implement',
        summary: 'Added --json',
        assumptions: [],
        sections: {
          howItWorks: 'This touches the CLI.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n',
          seeIt: '`foedrum status --json` prints JSON',
          beforeAfter: [{ case: '`status --json`', before: 'refused', after: 'JSON' }],
        },
      },
      {
        stepId: 'correctness',
        summary: 'No defects',
        assumptions: [],
        tasting: { verdict: 'approve' as const, findings: [] },
      },
    ];
    const attempts = [
      { stepId: 'implement', attempt: 1, result: 'succeeded' },
      { stepId: 'correctness', attempt: 1, result: 'approve' },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports, recipe: 'nip', attempts });
    assert.equal(
      body,
      [
        '## How it works',
        '',
        'This touches the CLI.',
        '',
        '```mermaid',
        'flowchart LR',
        '  A --> B',
        '```',
        '',
        '| | Before | After |',
        '|---|---|---|',
        '| `status --json` | refused | JSON |',
        '',
        '**See it:** `foedrum status --json` prints JSON',
        '',
        '## How this was brewed',
        '',
        'Brewed by Foedrum from acme/brewery#12 with the recipe nip.',
        '',
        'Opened ready for review: every Taster approved.',
        '',
        '| Attempt | Result |',
        '|---|---|',
        '| implement #1 | succeeded |',
        '| correctness #1 | approve |',
        '',
        '<details><summary>What each step reported</summary>',
        '',
        '```text',
        'implement: Added --json',
        'correctness: No defects',
        '  verdict: approve',
        '```',
        '',
        '</details>',
        '',
        'Closes acme/brewery#12',
      ].join('\n'),
    );
  });

  it('leaves out the before/after table when the out doc gives none', () => {
    const sections = { howItWorks: 'How.', seeIt: 'See.', beforeAfter: [] };
    const reports = [{ stepId: 'implement', summary: 'S', assumptions: [], sections }];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.ok(body.startsWith('## How it works\n\nHow.\n\n**See it:** See.\n\n## How this'), body);
  });

  it('takes the sections of the step scheduled last that wrote them', () => {
    const sections = (howItWorks: string) => ({ howItWorks, seeIt: 'See.', beforeAfter: [] });
    const reports = [
      { stepId: 'plan', summary: 'S', assumptions: [], sections: sections('First.') },
      { stepId: 'implement', summary: 'S', assumptions: [], sections: sections('Last.') },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.match(body, /^## How it works\n\nLast\.\n/);
    assert.doesNotMatch(body, /First/);
  });

  it("removes mentions and closing keywords from the sections, but not from the fenced reports", () => {
    const reports = [
      {
        stepId: 'implement',
        summary: 'Fixes #3 for @octocat',
        assumptions: [],
        sections: {
          howItWorks: 'Fixes #3 for @octocat.',
          seeIt: 'Closes #4, ask @ann',
          beforeAfter: [{ case: 'resolves #5', before: '@bob', after: 'fixed: #6' }],
        },
      },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.match(body, /^## How it works\n\n#3 for octocat\.\n/);
    assert.match(body, /\n\| #5 \| bob \| #6 \|\n/);
    assert.match(body, /\n\*\*See it:\*\* #4, ask ann\n/);
    assert.match(body, /\nimplement: Fixes #3 for @octocat\n/);
    assert.equal(body.match(/^Closes /gm)?.length, 1);
  });

  it('leaves out a section or a cell that looks like a secret, naming the step', () => {
    const reports = [
      {
        stepId: 'implement',
        summary: 'S',
        assumptions: [],
        sections: {
          howItWorks: `Read ${token}`,
          seeIt: 'See.',
          beforeAfter: [{ case: 'key', before: aws, after: 'gone' }],
        },
      },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    const left = '[left out: a text of step implement that looks like a secret]';
    assert.ok(body.startsWith(`## How it works\n\n${left}\n`), body);
    assert.ok(body.includes(`\n| key | ${left} | gone |\n`), body);
    assert.doesNotMatch(body, /ghp_|A1b2|AKIA/);
  });

  it('escapes the pipes and backslashes of a cell, so it stays one cell', () => {
    const reports = [
      {
        stepId: 'implement',
        summary: 'S',
        assumptions: [],
        sections: {
          howItWorks: 'How.',
          seeIt: 'See.',
          beforeAfter: [{ case: 'a|b', before: 'c:\\d\\|', after: 'x\ny' }],
        },
      },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.ok(body.includes('\n| a\\|b | c:\\\\d\\\\\\| | x y |\n'), body);
  });

  it('says why it is a draft when a Taster asks for changes', () => {
    const reports = [
      {
        stepId: 'correctness',
        summary: 'One blocker',
        assumptions: [],
        tasting: { verdict: 'changes' as const, findings: [blocker] },
      },
      {
        stepId: 'security',
        summary: 'None',
        assumptions: [],
        tasting: { verdict: 'approve' as const, findings: [] },
      },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.ok(
      body.includes(
        '\nOpened as a draft: a Taster asks for changes (correctness); its findings are in the reports below.\n',
      ),
      body,
    );
  });

  it("shows a failed attempt's reason in a code span on one line, its pipes escaped", () => {
    const attempts = [
      { stepId: 'red', attempt: 1, result: 'failed', reason: 'test "a|b" `x`\nnext @ann' },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports: [], attempts });
    assert.ok(
      body.includes('\n| red #1 | failed: `` test "a\\|b" `x`\\u000anext @ann `` |\n'),
      body,
    );
  });

  it('escapes every pipe of a reason, also after a backslash', () => {
    const attempts = [{ stepId: 'red', attempt: 1, result: 'failed', reason: 'a\\|b\\\\|c' }];
    const { body } = pullRequestText({ title: 'T', closes, reports: [], attempts });
    assert.ok(body.includes('| red #1 | failed: ` a\\|b\\\\\\|c ` |'), body);
  });

  it('cuts a reason to 200 characters, and leaves out one that looks like a secret', () => {
    const attempts = [
      { stepId: 'red', attempt: 1, result: 'failed', reason: 'y'.repeat(400) },
      { stepId: 'red', attempt: 2, result: 'failed', reason: `Read ${token}` },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports: [], attempts });
    assert.ok(body.includes(`| red #1 | failed: \` ${'y'.repeat(200)} \` |`), body);
    assert.ok(
      body.includes('| red #2 | failed: ` [left out: a text of step red that looks like a secret] ` |'),
      body,
    );
    assert.doesNotMatch(body, /ghp_|A1b2/);
  });

  it('lists at most 50 attempts and counts the rest', () => {
    const attempts = Array.from({ length: 105 }, (_, i) => ({
      stepId: 'implement',
      attempt: i + 1,
      result: 'succeeded',
    }));
    const { body } = pullRequestText({ title: 'T', closes, reports: [], attempts });
    assert.ok(body.includes('\n| implement #50 | succeeded |\n\nAnd 55 more attempts.\n'), body);
    assert.doesNotMatch(body, /implement #51/);
  });

  it('uses a fence longer than any run of backticks in the reports', () => {
    const reports = [{ stepId: 'plan', summary: 'Ran ```` and ``` here', assumptions: [] }];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.deepEqual(linesFrom(body, '`````text', 3), [
      '`````text',
      'plan: Ran ```` and ``` here',
      '`````',
    ]);
  });

  it('says so when no step reported anything', () => {
    const { body } = pullRequestText({ title: 'T', closes, reports: [] });
    assert.equal(
      body,
      [
        '## How this was brewed',
        '',
        'Brewed by Foedrum from acme/brewery#12.',
        '',
        untasted,
        '',
        'Closes acme/brewery#12',
      ].join('\n'),
    );
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

  it("stays within GitHub's limit with the largest sections and the reports cut short", () => {
    const cell = 'c'.repeat(200);
    const reports = [
      {
        stepId: 'implement',
        summary: 'S',
        assumptions: [],
        sections: {
          howItWorks: 'h'.repeat(10_000),
          seeIt: 's'.repeat(1_000),
          beforeAfter: Array.from({ length: 20 }, () => ({ case: cell, before: cell, after: cell })),
        },
      },
      ...Array.from({ length: 100 }, (_, i) => ({
        stepId: `s${i}`,
        summary: 'y'.repeat(1_000),
        assumptions: [],
      })),
    ];
    const attempts = Array.from({ length: 150 }, (_, i) => ({
      stepId: 'implement-the-order',
      attempt: i + 1,
      result: 'failed',
      reason: 'r'.repeat(400),
    }));
    const { body } = pullRequestText({ title: 'T', closes, reports, recipe: 'nip', attempts });
    assert.ok(body.length <= 65_536, `${body.length}`);
    assert.match(body, /\n\(cut short\)\n```\n\n<\/details>\n\nCloses acme\/brewery#12$/);
  });

  it('cuts the reports short at 25,000 characters, saying so', () => {
    const reports = Array.from({ length: 100 }, (_, i) => ({
      stepId: `s${i}`,
      summary: 'y'.repeat(1_000),
      assumptions: [],
    }));
    const { body } = pullRequestText({ title: 'T', closes, reports });
    const fenced = body.slice(body.indexOf('```text\n') + 8, body.indexOf('\n(cut short)'));
    assert.equal(fenced.length, 25_000);
    assert.match(body, /\n\(cut short\)\n```\n\n<\/details>\n\nCloses acme\/brewery#12$/);
  });

  it('leaves out a summary and an assumption that look like a secret, naming the step (#235)', () => {
    const reports = [
      { stepId: 'plan', summary: `Read ${token}`, assumptions: ['No config file'] },
      { stepId: 'implement', summary: 'Added --json', assumptions: [`AWS key ${aws}`, 'Tabs'] },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.deepEqual(linesFrom(body, '```text', 7), [
      '```text',
      'plan: [left out: a text of step plan that looks like a secret]',
      '  assumed: No config file',
      'implement: Added --json',
      '  assumed: [left out: a text of step implement that looks like a secret]',
      '  assumed: Tabs',
      '```',
    ]);
    assert.doesNotMatch(body, /ghp_|A1b2|AKIA/);
  });

  it('reads only the reports it can show, so a token past the cut does not hide them', () => {
    const reports = [
      { stepId: 'plan', summary: `${'y '.repeat(20_000)}${token}`, assumptions: [] },
      { stepId: 'implement', summary: token, assumptions: [] },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.match(body, /^plan: y y y/m);
    assert.match(body, /\n\(cut short\)\n```\n\n<\/details>\n\nCloses acme\/brewery#12$/);
    assert.doesNotMatch(body, /ghp_|A1b2/);
  });

  it('says it is cut short when it stopped reading, though the backticks it read shrink', () => {
    const reports = [{ stepId: 'plan', summary: '`'.repeat(70_000), assumptions: [] }];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.match(body, /\n\(cut short\)\n`+\n\n<\/details>\n\nCloses acme\/brewery#12$/);
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
