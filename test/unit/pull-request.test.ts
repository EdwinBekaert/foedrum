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
  const question = { q: 'Which?', options: ['a', 'b'], recommended: 'a', whyBlocking: 'x' };
  const asked: Event = {
    type: 'step.finished',
    batchId: '12-1',
    stepId: 'plan',
    attempt: 1,
    outcome: {
      kind: 'needs_input',
      questions: [question],
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

  it('gives an attempt that was cancelled, and one the batch abandoned when it got Stuck (review of #450)', () => {
    const cancelled: Event = {
      type: 'step.finished',
      batchId: '12-1',
      stepId: 'implement',
      attempt: 1,
      outcome: { kind: 'cancelled' },
    };
    const stuck: Event = {
      type: 'batch.stuck',
      batchId: '12-1',
      reason: { kind: 'needs_input', stepId: 'implement', questions: [question] },
      options: ['answer', 'cancel'],
      remindAt: '2026-10-16T12:00:00.000Z',
    };
    const state = fold([
      ordered,
      chosen,
      ...ran('implement', 1).slice(0, 2),
      cancelled,
      ...ran('implement', 2).slice(0, 2),
      stuck,
    ]);
    const batch = state.batches.get('12-1');
    assert.ok(batch !== undefined);
    assert.deepEqual(brewLog(batch), [
      { stepId: 'implement', attempt: 1, result: 'cancelled' },
      { stepId: 'implement', attempt: 2, result: 'abandoned' },
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
    assert.equal(unlinked('fixed\n#8 and resolve&nbsp;#9'), '#8 and resolve&amp;nbsp;#9');
  });

  it('removes every form of each keyword, before an http reference too (review of #450)', () => {
    assert.equal(
      unlinked('close #1, closed #2, resolve #3, Resolves #4, fixes http://x/y/issues/5'),
      '#1, #2, #3, #4, http://x/y/issues/5',
    );
  });

  it('reads a word boundary as GitHub does, in ASCII (review of #450)', () => {
    assert.equal(unlinked('café@octocat and éfixes #3'), 'caféoctocat and é#3');
    assert.equal(unlinked('ann@octocat.dev and prefixes #3'), 'ann@octocat.dev and prefixes #3');
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

  it('keeps a named character reference as text, but not a bare & (review of #450)', () => {
    assert.equal(
      unlinked('Ask &commat;ann, Fixes &num;3'),
      'Ask &amp;commat;ann, Fixes &amp;num;3',
    );
    assert.equal(unlinked('A & B, &amp; C'), 'A & B, &amp; C');
  });

  it('removes a mention and a keyword that emphasis with _ starts (review of #450)', () => {
    assert.equal(unlinked('Thanks _@ann_, __@bob__ and x_@eve'), 'Thanks _ann_, __bob__ and x_eve');
    assert.equal(unlinked('_fixes #3_ and __Closes #4__'), '_#3_ and __#4__');
  });

  it('keeps an @ that no name follows', () => {
    assert.equal(unlinked('3 @ 4, a @-sign'), '3 @ 4, a @-sign');
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
  const untasted = 'A person reviews this before it is marked ready: no step tasted the change.';
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
        'No How it works: the Cellarman wrote none.',
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
        'Ready for review: every Taster approved.',
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

  it("closes a fence how it works leaves open, so the rest of the body stays the engine's (review of #450)", () => {
    const fenced = (howItWorks: string) => {
      const sections = { howItWorks, seeIt: 'See.', beforeAfter: [] };
      const reports = [{ stepId: 'implement', summary: 'S', assumptions: [], sections }];
      return pullRequestText({ title: 'T', closes, reports }).body;
    };
    assert.ok(
      fenced('Pic:\n\n````mermaid\nflowchart LR\n```\n  A --> B').startsWith(
        '## How it works\n\nPic:\n\n````mermaid\nflowchart LR\n```\n  A --> B\n````\n\n**See it:** See.\n\n## How this',
      ),
    );
    assert.ok(fenced('~~~\ncode').startsWith('## How it works\n\n~~~\ncode\n~~~\n\n**See it:**'));
  });

  it('closes a fence only with a bare run of its own character, as long or longer (review of #450)', () => {
    const fenced = (howItWorks: string) => {
      const sections = { howItWorks, seeIt: 'See.', beforeAfter: [] };
      const reports = [{ stepId: 'implement', summary: 'S', assumptions: [], sections }];
      return pullRequestText({ title: 'T', closes, reports }).body;
    };
    const section = (body: string) => body.slice(0, body.indexOf('\n\n**See it:**'));
    assert.equal(
      section(fenced('```mermaid\nA\n~~~\n<!--')),
      '## How it works\n\n```mermaid\nA\n~~~\n<!--\n```',
    );
    assert.equal(
      section(fenced('```\na\n``` foo\nb')),
      '## How it works\n\n```\na\n``` foo\nb\n```',
    );
    assert.equal(section(fenced('```a`b\n<x>')), '## How it works\n\n```a`b\n&lt;x>');
  });

  it('reads a carriage return as a line end, and only spaces and tabs after a closing fence (review of #450)', () => {
    const fenced = (howItWorks: string) => {
      const sections = { howItWorks, seeIt: 'See.', beforeAfter: [] };
      const reports = [{ stepId: 'implement', summary: 'S', assumptions: [], sections }];
      return pullRequestText({ title: 'T', closes, reports }).body;
    };
    const section = (body: string) => body.slice(0, body.indexOf('\n\n**See it:**'));
    assert.equal(
      section(fenced('```mermaid\r\ngraph TD\rA-->B')),
      '## How it works\n\n```mermaid\ngraph TD\nA-->B\n```',
    );
    const nbsp = String.fromCodePoint(0xa0);
    assert.equal(
      section(fenced(`\`\`\`\na\n\`\`\`${nbsp}\nb`)),
      `## How it works\n\n\`\`\`\na\n\`\`\`${nbsp}\nb\n\`\`\``,
    );
    assert.equal(section(fenced('```\na\n```  \t\nb')), '## How it works\n\n```\na\n```  \t\nb');
  });

  it('leaves out how it works when a fence starts inside a list, a quote or an indent (review of #450)', () => {
    const left =
      '[left out: a text of step implement with a fence Foedrum cannot check outside its top level]';
    for (const howItWorks of [
      '1. Step\n   ```\n   code\n```',
      '- a\n\n  ~~~\n  b\n  ~~~',
      '> ```\n> x',
      'Intro\n    ```\n    x',
    ]) {
      const sections = { howItWorks, seeIt: 'See.', beforeAfter: [] };
      const reports = [{ stepId: 'implement', summary: 'S', assumptions: [], sections }];
      const { body } = pullRequestText({ title: 'T', closes, reports });
      assert.ok(body.startsWith(`## How it works\n\n${left}\n\n**See it:**`), body);
    }
  });

  it('keeps a fence line inside a top-level fence, indented or not (review of #450)', () => {
    const sections = { howItWorks: '````\n  ```\n> ```\n````', seeIt: 'See.', beforeAfter: [] };
    const reports = [{ stepId: 'implement', summary: 'S', assumptions: [], sections }];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.ok(body.startsWith('## How it works\n\n````\n  ```\n> ```\n````\n\n**See it:**'), body);
  });

  it('keeps how it works from starting an HTML block, outside a fence (review of #450)', () => {
    const sections = {
      howItWorks:
        'A <b>bold</b> word.\n\n<!-- hidden\n   <details>\n\n```mermaid\nA["x<br/>y"]\n<b>\n```',
      seeIt: 'See.',
      beforeAfter: [],
    };
    const reports = [{ stepId: 'implement', summary: 'S', assumptions: [], sections }];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    assert.ok(
      body.startsWith(
        '## How it works\n\nA <b>bold</b> word.\n\n&lt;!-- hidden\n   &lt;details>\n\n```mermaid\nA["x<br/>y"]\n<b>\n```\n\n**See it:**',
      ),
      body,
    );
  });

  it('leaves out a section that grows past its room once made safe (review of #450)', () => {
    const sections = { howItWorks: '&#'.repeat(5_000), seeIt: '&#'.repeat(500), beforeAfter: [] };
    const reports = [{ stepId: 'implement', summary: 'S', assumptions: [], sections }];
    const { body } = pullRequestText({ title: 'T', closes, reports });
    const left = '[left out: a text of step implement that is too long once made safe for GitHub]';
    assert.ok(body.startsWith(`## How it works\n\n${left}\n\n**See it:** ${left}\n\n`), body);
  });

  it('gives the reports only the room the rest of the body leaves (review of #450)', () => {
    const cell = 'c|'.repeat(100);
    const sections = {
      howItWorks: `${'h'.repeat(9_000)}${'&#'.repeat(500)}`,
      seeIt: 's'.repeat(1_000),
      beforeAfter: Array.from({ length: 20 }, () => ({ case: cell, before: cell, after: cell })),
    };
    const reports = [
      { stepId: 'implement', summary: 'S', assumptions: [], sections },
      ...Array.from({ length: 100 }, (_, i) => ({
        stepId: `s${i}`,
        summary: 'y'.repeat(1_000),
        assumptions: [],
      })),
    ];
    const attempts = Array.from({ length: 50 }, (_, i) => ({
      stepId: 'implement-the-order',
      attempt: i + 1,
      result: 'failed',
      reason: '`|'.repeat(200),
    }));
    const { body } = pullRequestText({ title: 'T', closes, reports, recipe: 'nip', attempts });
    assert.ok(body.length <= 65_536, `${body.length}`);
    const fenced = body.slice(body.indexOf('```text\n') + 8, body.indexOf('\n(cut short)'));
    assert.ok(fenced.length < 25_000, `${fenced.length}`);
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

  it('removes mentions and closing keywords from the sections, but not from the fenced reports', () => {
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

  it('opens as a draft without how it works, whatever the Tasters say, saying why (#450)', () => {
    const reports = [
      { stepId: 'implement', summary: 'S', assumptions: [] },
      {
        stepId: 'correctness',
        summary: 'No defects',
        assumptions: [],
        tasting: { verdict: 'approve' as const, findings: [] },
      },
    ];
    const text = pullRequestText({ title: 'T', closes, reports });
    assert.equal(text.draft, true);
    assert.ok(
      text.body.includes(
        '\nNo How it works: the Cellarman wrote none.\n\nA person reviews this before it is marked ready: every Taster approved, but it has no How it works.\n',
      ),
      text.body,
    );
    const [implement, ...tasted] = reports;
    assert.ok(implement !== undefined);
    const written = [
      { ...implement, sections: { howItWorks: 'How.', beforeAfter: [] } },
      ...tasted,
    ];
    assert.equal(pullRequestText({ title: 'T', closes, reports: written }).draft, false);
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
        '\nA person reviews this before it is marked ready: a Taster asks for changes (correctness); its findings are in the reports below.\n',
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

  it("cuts a reason's runs of backticks to three, so its code span stays short (review of #450)", () => {
    const attempts = [
      { stepId: 'red', attempt: 1, result: 'failed', reason: `a${'`'.repeat(50)}b` },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports: [], attempts });
    assert.ok(body.includes('| red #1 | failed: ```` a```b ```` |'), body);
  });

  it('cuts a reason to 200 characters, and leaves out one that looks like a secret', () => {
    const attempts = [
      { stepId: 'red', attempt: 1, result: 'failed', reason: 'y'.repeat(400) },
      { stepId: 'red', attempt: 2, result: 'failed', reason: `Read ${token}` },
    ];
    const { body } = pullRequestText({ title: 'T', closes, reports: [], attempts });
    assert.ok(body.includes(`| red #1 | failed: \` ${'y'.repeat(200)} \` |`), body);
    assert.ok(
      body.includes(
        '| red #2 | failed: ` [left out: a text of step red that looks like a secret] ` |',
      ),
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
        'No How it works: the Cellarman wrote none.',
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
          beforeAfter: Array.from({ length: 20 }, () => ({
            case: cell,
            before: cell,
            after: cell,
          })),
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
