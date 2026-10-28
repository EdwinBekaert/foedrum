// What an attempt a route schedules gets (#341, ADR 0128): the failed reading of the check that
// sent it back, or the findings of the out doc that blocked, as one tagged input. Pure: the events
// are folded, the out doc's read is given.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  keptMergeInput,
  MAX_ROUTE_INPUT_BYTES,
  type PlannedRoute,
  routeInput,
  routeOf,
} from '../../src/brewers/attempt-plan.ts';
import { fold } from '../../src/engine/fold.ts';
import { type Event, type GravityReading, MAX_TAIL_LENGTH } from '../../src/schemas/events.ts';
import type { KeptFile, MergeResult } from '../../src/schemas/store.ts';

const deadlineAt = '2026-10-22T13:00:00.000Z';
const worktreeOf = (name: string) => ({
  repo: 'acme/api',
  path: join('/work', name),
  branch: `foedrum/12-1/${name}`,
  commit: 'c'.repeat(40),
});
const outDocs: Record<string, string> = { implement: 'implement.md', gauge: 'gauge.md' };
const outDocOf = (stepId: string): string | undefined => outDocs[stepId];

const ordered: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'nip', reason: 'label', source: 'label' },
];

/** One attempt of `stepId` from schedule to finish, in a worktree of its own. */
const attempt = (
  stepId: string,
  number: number,
  finished: Partial<Extract<Event, { type: 'step.finished' }>> = {},
  route?: { from: string; why: 'failed' | 'findings' },
): Event[] => {
  const ref = { batchId: '12-1', stepId, attempt: number };
  return [
    { type: 'step.scheduled', ...ref, deadlineAt, ...(route === undefined ? {} : { route }) },
    { type: 'step.started', ...ref, worktree: worktreeOf(`${stepId}-${number}`) },
    {
      type: 'step.finished',
      ...ref,
      outcome: { kind: 'succeeded', output: null },
      ...finished,
    },
  ];
};

/** The attempt of `stepId` a route scheduled, started and not finished. */
const routed = (stepId: string, number: number, from: string, why: 'failed' | 'findings') =>
  attempt(stepId, number, {}, { from, why }).slice(0, 2);

const failedTest = (tail: string): GravityReading => ({
  result: 'exited',
  check: 'test',
  command: 'npm test',
  exitCode: 1,
  tail,
});
const greenFailed = (tail: string): Partial<Extract<Event, { type: 'step.finished' }>> => ({
  outcome: {
    kind: 'failed',
    retryable: false,
    reason: 'the check "test" (npm test) failed with exit code 1',
  },
  readings: [
    { result: 'exited', check: 'build', command: 'npm run build', exitCode: 0, tail: 'built' },
    failedTest(tail),
  ],
});

const batchOf = (events: readonly Event[]) => {
  const found = fold([...ordered, ...events]).batches.get('12-1');
  assert.ok(found !== undefined);
  return found;
};

const planned = (events: readonly Event[], stepId: string, number: number) =>
  routeOf(batchOf(events), { batchId: '12-1', stepId, attempt: number }, outDocOf);

describe('routeOf', () => {
  it("gives an attempt an onFail route scheduled the failed check's name, exit code and tail", () => {
    const route = planned(
      [
        ...attempt('implement', 1),
        ...attempt('green', 1, greenFailed('not ok 1 - adds the --json flag')),
        ...routed('implement', 2, 'green', 'failed'),
      ],
      'implement',
      2,
    );
    assert.ok(route !== undefined, 'the routed attempt gets no route input');
    assert.deepEqual(route.source, {
      kind: 'route',
      step: 'implement',
      from: 'green',
      why: 'failed',
    });
    assert.equal(route.outDoc, undefined);
    assert.match(route.text, /the check "test" \(npm test\) failed with exit code 1/);
    assert.match(route.text, /not ok 1 - adds the --json flag/);
    // A check that passed is not why the step runs again.
    assert.doesNotMatch(route.text, /npm run build|built/);
  });

  it('carries only the reading of the round that routed it, not an earlier one', () => {
    const route = planned(
      [
        ...attempt('implement', 1),
        ...attempt('green', 1, greenFailed('not ok 1 - the first round')),
        ...attempt('implement', 2, {}, { from: 'green', why: 'failed' }),
        ...attempt('green', 2, greenFailed('not ok 2 - the second round')),
        ...routed('implement', 3, 'green', 'failed'),
      ],
      'implement',
      3,
    );
    assert.match(route?.text ?? '', /the second round/);
    assert.doesNotMatch(route?.text ?? '', /the first round/);
  });

  it('gives nothing new to an attempt no route scheduled, after a round that was routed', () => {
    const events = [
      ...attempt('implement', 1),
      ...attempt('green', 1, greenFailed('not ok 1 - adds the --json flag')),
      ...attempt(
        'implement',
        2,
        { outcome: { kind: 'failed', retryable: true, reason: 'crashed' } },
        { from: 'green', why: 'failed' },
      ),
      ...attempt('implement', 3).slice(0, 2),
    ];
    assert.equal(planned(events, 'implement', 3), undefined);
    assert.equal(planned(attempt('implement', 1).slice(0, 2), 'implement', 1), undefined);
  });

  it('leaves out a reason line that looks like a secret (#188)', () => {
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`.slice(0, 40);
    const route = planned(
      [
        ...attempt('implement', 1),
        ...attempt('green', 1, {
          ...greenFailed('not ok 1'),
          outcome: { kind: 'failed', retryable: false, reason: `the run printed ${token}` },
        }),
        ...routed('implement', 2, 'green', 'failed'),
      ],
      'implement',
      2,
    );
    assert.ok(route !== undefined);
    assert.equal(route.text.includes(token), false, route.text);
    assert.match(route.text, /^Step green ended: \[left out: a reason that looks like a secret\]/);
    assert.match(route.text, /not ok 1/);
  });

  it('says how each check that did not pass ended, with its tail, and leaves out a skipped one', () => {
    const readings: GravityReading[] = [
      { result: 'skipped', check: 'lint' },
      { result: 'signaled', check: 'build', command: 'make', signal: 'SIGSEGV', tail: 'core' },
      { result: 'killed', check: 'test', command: 'npm test', killed: 'timed-out', tail: 'slow' },
      { result: 'unstarted', command: 'gradle check', tail: 'gradle: not found' },
    ];
    const route = planned(
      [
        ...attempt('implement', 1),
        ...attempt('green', 1, { ...greenFailed('unused'), readings }),
        ...routed('implement', 2, 'green', 'failed'),
      ],
      'implement',
      2,
    );
    const text = route?.text ?? '';
    for (const line of [
      'the check "build" (make) was ended by SIGSEGV. The end of its output:\ncore',
      'the check "test" (npm test) was killed by the process runner (timed-out). The end of its output:\nslow',
      'the check "gradle check" could not start. The end of its output:\ngradle: not found',
    ]) {
      assert.ok(text.includes(line), `${line} is not in ${text}`);
    }
    assert.doesNotMatch(text, /lint/);
  });

  it('says only that the step sent it back when that step has no finished attempt', () => {
    const route = planned(
      [
        ...attempt('implement', 1),
        ...attempt('green', 1).slice(0, 2),
        ...routed('implement', 2, 'green', 'failed'),
      ],
      'implement',
      2,
    );
    assert.equal(route?.text, 'Step green sent this step back.');
  });

  it('points an onBlocked route at no out doc when the attempt that blocked had no worktree', () => {
    const ref = { batchId: '12-1', stepId: 'implement', attempt: 1 };
    const route = planned(
      [
        ...attempt('gauge', 1),
        { type: 'step.scheduled', ...ref, deadlineAt },
        { type: 'step.started', ...ref },
        {
          type: 'step.finished',
          ...ref,
          outcome: { kind: 'failed', retryable: false, reason: 'blocked (findings): Wrong' },
        },
        ...routed('gauge', 2, 'implement', 'findings'),
      ],
      'gauge',
      2,
    );
    assert.equal(route?.outDoc, undefined);
    assert.match(route?.text ?? '', /Wrong/);
  });

  it('points an onBlocked route at no out doc when the step that blocked has none', () => {
    const route = routeOf(
      batchOf([
        ...attempt('gauge', 1),
        ...attempt('implement', 1, {
          outcome: { kind: 'failed', retryable: false, reason: 'blocked (findings): Wrong' },
        }),
        ...routed('gauge', 2, 'implement', 'findings'),
      ]),
      { batchId: '12-1', stepId: 'gauge', attempt: 2 },
      () => undefined,
    );
    assert.equal(route?.outDoc, undefined);
    assert.match(route?.text ?? '', /Wrong/);
  });

  it('points an onBlocked route at the out doc of the attempt that blocked, with its reason', () => {
    const route = planned(
      [
        ...attempt('gauge', 1),
        ...attempt('implement', 1, {
          outcome: {
            kind: 'failed',
            retryable: false,
            reason: 'blocked (findings): The test expects the wrong slug',
          },
        }),
        ...routed('gauge', 2, 'implement', 'findings'),
      ],
      'gauge',
      2,
    );
    assert.ok(route !== undefined);
    assert.deepEqual(route.source, {
      kind: 'route',
      step: 'gauge',
      from: 'implement',
      why: 'findings',
    });
    assert.deepEqual(route.outDoc, {
      path: join('/work', 'implement-1', 'implement.md'),
      root: join('/work', 'implement-1'),
    });
    assert.match(route.text, /The test expects the wrong slug/);
  });

  it('reads the out doc of a resumed attempt that blocked where it ran: its session worktree (ADR 0117)', () => {
    const id = '0f8fad5b-d9cb-469f-a165-708677289500';
    const first = { batchId: '12-1', stepId: 'implement', attempt: 1 };
    const second = { ...first, attempt: 2 };
    const ran = join('/work', 'implement-1');
    const route = planned(
      [
        ...attempt('gauge', 1),
        { type: 'step.scheduled', ...first, deadlineAt },
        {
          type: 'step.started',
          ...first,
          session: { id, worktree: ran },
          worktree: worktreeOf('implement-1'),
        },
        {
          type: 'step.finished',
          ...first,
          outcome: { kind: 'failed', retryable: true, reason: 'crashed' },
        },
        { type: 'step.scheduled', ...second, deadlineAt, retry: true },
        { type: 'step.started', ...second, session: { id, resumes: id, worktree: ran } },
        {
          type: 'step.finished',
          ...second,
          outcome: { kind: 'failed', retryable: false, reason: 'blocked (findings): Wrong slug' },
        },
        ...routed('gauge', 2, 'implement', 'findings'),
      ],
      'gauge',
      2,
    );
    assert.deepEqual(route?.outDoc, { path: join(ran, 'implement.md'), root: ran });
  });
});

describe('routeInput', () => {
  const findings: PlannedRoute = {
    source: { kind: 'route', step: 'gauge', from: 'implement', why: 'findings' },
    text: 'Step implement was blocked: blocked (findings): The test expects the wrong slug',
    outDoc: {
      path: join('/work', 'implement-1', 'implement.md'),
      root: join('/work', 'implement-1'),
    },
  };

  it('is the route input, with the reason and then the out doc that blocked', () => {
    const doc =
      '---\n{ "status": "blocked" }\n---\nThe slug test wants `a-b`, the order says `a_b`.';
    const input = routeInput(findings, { kind: 'text', text: doc });
    assert.equal(input.name, 'route');
    assert.deepEqual(input.source, findings.source);
    assert.ok(input.text.startsWith(findings.text), input.text);
    assert.ok(input.text.includes(doc), input.text);
  });

  it('says in one line that the out doc could not be read, keeping the reason', () => {
    for (const read of [
      { kind: 'missing' },
      { kind: 'unread', reason: 'it is not a regular file' },
    ] as const) {
      const input = routeInput(findings, read);
      assert.ok(input.text.startsWith(findings.text), input.text);
      assert.match(input.text, /out doc .*could not be read/);
    }
  });

  it(`holds the text to ${MAX_ROUTE_INPUT_BYTES} bytes, keeping its start and naming the limit`, () => {
    const replacement = String.fromCodePoint(0xfffd);
    // A 4-byte character after 0 to 3 more bytes puts the cut at every offset inside one.
    for (const shift of ['', 'x', 'xx', 'xxx']) {
      const doc = `---\n{}\n---\n${shift}${'🍺'.repeat(MAX_ROUTE_INPUT_BYTES / 4)}`;
      const { text } = routeInput(findings, { kind: 'text', text: doc });
      assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_ROUTE_INPUT_BYTES, `${text.length}`);
      assert.ok(text.startsWith(findings.text));
      assert.match(text, new RegExp(`\\n\\[cut: [^\\n]*${MAX_ROUTE_INPUT_BYTES} bytes\\]$`));
      assert.equal(text.includes(replacement), false, `a character was cut after "${shift}"`);
    }
  });

  it(`keeps a text of exactly ${MAX_ROUTE_INPUT_BYTES} bytes whole`, () => {
    const failed: PlannedRoute = {
      source: { kind: 'route', step: 'implement', from: 'green', why: 'failed' },
      text: 'x'.repeat(MAX_ROUTE_INPUT_BYTES),
    };
    assert.equal(routeInput(failed).text, failed.text);
  });

  it('is the text of a failed check as it is', () => {
    const failed: PlannedRoute = {
      source: { kind: 'route', step: 'implement', from: 'green', why: 'failed' },
      text: 'Step green failed.',
    };
    assert.deepEqual(routeInput(failed), {
      name: 'route',
      source: failed.source,
      text: 'Step green failed.',
    });
  });
});

describe('routeOf: a pull request that failed its checks (ADR 0219)', () => {
  const pullRequest = 'https://github.com/acme/api/pull/12';
  const head = 'c'.repeat(40);
  const open = 'open-pull-request';
  const failed = {
    name: 'ci / test',
    kind: 'check_run',
    conclusion: 'failure',
    url: 'https://github.com/acme/api/actions/runs/1/job/2',
  } as const;
  const status = { name: 'deploy', kind: 'status', conclusion: 'error' } as const;
  const passed = { name: 'ci / lint', kind: 'check_run', conclusion: 'success' } as const;
  const record = (checks: readonly unknown[], more?: number, of = head): Event =>
    ({
      type: 'pull_request.checks_finished',
      batchId: '12-1',
      pullRequest,
      head: of,
      checks,
      ...(more === undefined ? {} : { more }),
    }) as Event;
  const sentBack: Event = {
    type: 'step.scheduled',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 2,
    deadlineAt,
    route: { from: open, why: 'pull_request', pullRequest, head },
  };
  const opened = [...attempt('implement', 1), ...attempt(open, 1)];
  const told =
    "You cannot open these links. The recipe's own checks run on your change after this step.";

  it('names each failed check of the record the route names, and none that passed', () => {
    const route = planned([...opened, record([failed, status, passed]), sentBack], 'implement', 2);
    assert.deepEqual(route, {
      source: { kind: 'route', step: 'implement', from: open, why: 'pull_request', pullRequest },
      text: [
        `Pull request ${pullRequest} failed its checks on ${head}:`,
        `- ci / test (check run): failure, ${failed.url}`,
        '- deploy (commit status): error',
        told,
      ].join('\n'),
    });
  });

  it("shows the end of each failed Actions job's log under its check, or why it could not be read", () => {
    const route = planned(
      [
        ...opened,
        record([
          {
            ...failed,
            log: { excerpt: '##[group]Run npm test\nnot ok 1 - adds\n##[error]exit 1' },
          },
          { ...failed, name: 'ci / old', log: { unread: 'it has expired (410)' } },
          status,
          passed,
        ]),
        sentBack,
      ],
      'implement',
      2,
    );
    assert.equal(
      route?.text,
      [
        `Pull request ${pullRequest} failed its checks on ${head}:`,
        `- ci / test (check run): failure, ${failed.url}`,
        "  The end of its job's log, around its first error:",
        '  ##[group]Run npm test',
        '  not ok 1 - adds',
        '  ##[error]exit 1',
        `- ci / old (check run): failure, ${failed.url}`,
        "  Its job's log could not be read: it has expired (410).",
        '- deploy (commit status): error',
        told,
      ].join('\n'),
    );
  });

  it('holds five long excerpts to the limit of the input', () => {
    const excerpt = 'x'.repeat(MAX_TAIL_LENGTH);
    const checks = Array.from({ length: 5 }, (_, i) => ({
      ...failed,
      name: `t${i}`,
      log: { excerpt },
    }));
    const route = planned([...opened, record(checks), sentBack], 'implement', 2);
    assert.ok(route !== undefined);
    const text = routeInput(route).text;
    assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_ROUTE_INPUT_BYTES);
    assert.equal(text.split(excerpt).length, 6);
  });

  it('says how many checks the record left out', () => {
    const route = planned([...opened, record([failed], 3), sentBack], 'implement', 2);
    assert.match(route?.text ?? '', /\n- and 3 more checks the record left out\n/);
  });

  it('says so when the record of that head is no longer the latest', () => {
    const route = planned(
      [...opened, record([failed]), record([failed], undefined, 'd'.repeat(40)), sentBack],
      'implement',
      2,
    );
    assert.equal(
      route?.text,
      `Pull request ${pullRequest} failed its checks on ${head}; the record of them is no longer the latest.`,
    );
  });

  it('holds the input to its limit', () => {
    const long = Array.from({ length: 100 }, (_, i) => ({
      ...failed,
      name: `${'x'.repeat(190)} ${i}`,
      url: `https://github.com/acme/api/actions/runs/1/job/${'9'.repeat(1900)}${i}`,
    }));
    const route = planned([...opened, record(long), sentBack], 'implement', 2);
    assert.ok(route !== undefined);
    assert.ok(Buffer.byteLength(routeInput(route).text, 'utf8') <= MAX_ROUTE_INPUT_BYTES);
  });
});

describe('routeOf: a pull request that fails its checks on the merged tree (ADR 0226)', () => {
  const pullRequest = 'https://github.com/acme/api/pull/12';
  const head = 'c'.repeat(40);
  const tip = 'e'.repeat(40);
  const open = 'open-pull-request';
  const reading: GravityReading = {
    result: 'exited',
    check: 'test',
    command: 'npm test',
    exitCode: 1,
    tail: 'not ok 1 - adds\n# fail 1',
  };
  const checked = (of = head, at = tip): Event => ({
    type: 'pull_request.base_checked',
    batchId: '12-1',
    pullRequest,
    branch: 'main',
    tip: at,
    head: of,
    failed: reading,
  });
  const sentBack: Event = {
    type: 'step.scheduled',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 2,
    deadlineAt,
    route: { from: open, why: 'pull_request', pullRequest, head, cause: 'merged_check', tip },
  };
  const opened = [...attempt('implement', 1), ...attempt(open, 1)];
  const source = {
    kind: 'route',
    step: 'implement',
    from: open,
    why: 'pull_request',
    pullRequest,
    cause: 'merged_check',
  } as const;

  it('names the check that failed on the merged tree, its tail, and that the base is merged in', () => {
    const route = planned([...opened, checked(), sentBack], 'implement', 2);
    assert.deepEqual(route, {
      source,
      text: [
        `Pull request ${pullRequest} merges cleanly with main at ${tip} but fails its checks there:`,
        'the check "test" (npm test) exited with code 1. The end of its output:\nnot ok 1 - adds\n# fail 1',
        "The base is merged into this worktree. The recipe's own checks run on your change after this step.",
      ].join('\n\n'),
    });
  });

  it("names the route's tip's check when the same head failed again at another tip", () => {
    const later: Event = {
      ...checked(head, 'f'.repeat(40)),
      failed: { ...reading, tail: 'not ok 2 - later' },
    } as Event;
    const route = planned([...opened, checked(), later, sentBack], 'implement', 2);
    assert.match(route?.text ?? '', /not ok 1 - adds/);
    assert.doesNotMatch(route?.text ?? '', /not ok 2 - later/);
  });

  it('says so in one line when no check of that head and tip failed', () => {
    const route = planned([...opened, checked('d'.repeat(40)), sentBack], 'implement', 2);
    assert.deepEqual(route, {
      source,
      text: `Pull request ${pullRequest} failed its checks on the merged tree with main at ${tip}; the record of it is no longer there.`,
    });
  });
});

describe('routeOf: a pull request that conflicts with the moved base (ADR 0244)', () => {
  const pullRequest = 'https://github.com/acme/api/pull/12';
  const head = 'c'.repeat(40);
  const tip = 'e'.repeat(40);
  const newer = 'f'.repeat(40);
  const open = 'open-pull-request';
  const checked: Event = {
    type: 'pull_request.base_checked',
    batchId: '12-1',
    pullRequest,
    branch: 'main',
    tip,
    head,
    conflicts: ['src/a.ts', 'logo.png'],
  };
  const route = { from: open, why: 'pull_request', pullRequest, head, cause: 'conflict', tip };
  const sentBack: Event = {
    type: 'step.scheduled',
    batchId: '12-1',
    stepId: 'implement',
    attempt: 2,
    deadlineAt,
    route,
  } as Event;
  const opened = [...attempt('implement', 1), ...attempt(open, 1), checked];
  const source = {
    kind: 'route',
    step: 'implement',
    from: open,
    why: 'pull_request',
    pullRequest,
    cause: 'conflict',
    branch: 'main',
  } as const;
  const files: KeptFile[] = [
    { path: 'src/a.ts', status: 'both modified' },
    { path: 'logo.png', status: 'both modified', unmarked: true },
    { path: 'old.ts', status: 'deleted by them', unmarked: true },
    { path: 'new.ts', status: 'added by us' },
  ];
  const head1 = `Pull request ${pullRequest} no longer merges cleanly with main at ${newer}.`;
  const resolve =
    "Resolve each file, git add it, and git commit to conclude the merge; never abort it. The recipe's own checks run on your change after this step.";
  const plannedWith = (merge: MergeResult | undefined, events: Event[] = [sentBack]) =>
    routeOf(
      batchOf([...opened, ...events]),
      { batchId: '12-1', stepId: 'implement', attempt: 2 },
      outDocOf,
      () => merge,
    );

  for (const { name, merge, text } of [
    {
      name: 'names each file the kept merge left unmerged with its status, and the rest by count',
      merge: { base: newer, kept: { files, more: 3 } },
      text: [
        head1,
        [
          'The merge is in progress in this worktree, with conflict markers in the files git could mark. It left these files unmerged:',
          '- src/a.ts (both modified)',
          '- logo.png (both modified, without conflict markers: binary or unmarked)',
          '- old.ts (deleted by them, without conflict markers)',
          '- new.ts (added by us)',
          '- and 3 more',
        ].join('\n'),
        resolve,
      ],
    },
    {
      name: 'says so when the base merged cleanly at its start',
      merge: { base: newer, merged: 'a'.repeat(40) },
      text: [
        `Pull request ${pullRequest} conflicted with main at ${tip}; the base at ${newer} merged into this worktree without a conflict.`,
        "The recipe's own checks run on your change after this step.",
      ],
    },
    {
      name: 'says so when nothing was merged',
      merge: undefined,
      text: [
        `Pull request ${pullRequest} conflicted with main at ${tip}; the base is not merged into this worktree.`,
        "The recipe's own checks run on your change after this step.",
      ],
    },
  ] as const) {
    it(name, () => {
      assert.deepEqual(plannedWith(merge), { source, text: text.join('\n\n') });
    });
  }

  it('gives a fresh retry of the routed attempt the same input', () => {
    const merge = { base: newer, kept: { files: files.slice(0, 1), more: 0 } };
    const retried: Event[] = [
      sentBack,
      { type: 'step.started', batchId: '12-1', stepId: 'implement', attempt: 2 },
      {
        type: 'step.finished',
        batchId: '12-1',
        stepId: 'implement',
        attempt: 2,
        outcome: { kind: 'failed', retryable: true, reason: 'claude crashed' },
      },
      {
        type: 'step.scheduled',
        batchId: '12-1',
        stepId: 'implement',
        attempt: 3,
        deadlineAt,
        retry: true,
      },
    ];
    const got = routeOf(
      batchOf([...opened, ...retried]),
      { batchId: '12-1', stepId: 'implement', attempt: 3 },
      outDocOf,
      () => merge,
    );
    assert.deepEqual(got?.source, source);
    assert.match(got?.text ?? '', /- src\/a\.ts \(both modified\)/);
  });

  it('adds the kept files to a merged-tree route whose start merge conflicted', () => {
    const failed: Event = {
      ...checked,
      conflicts: undefined,
      failed: { result: 'exited', check: 'test', command: 'npm test', exitCode: 1, tail: 'not ok' },
    } as Event;
    const merged = { ...sentBack, route: { ...route, cause: 'merged_check' } } as Event;
    const got = routeOf(
      batchOf([...attempt('implement', 1), ...attempt(open, 1), failed, merged]),
      { batchId: '12-1', stepId: 'implement', attempt: 2 },
      outDocOf,
      () => ({ base: newer, kept: { files: files.slice(0, 1), more: 0 } }),
    );
    assert.match(got?.text ?? '', /fails its checks there/);
    assert.match(got?.text ?? '', /It left these files unmerged:\n- src\/a\.ts \(both modified\)/);
    assert.doesNotMatch(got?.text ?? '', /The base is merged into this worktree\./);
  });

  it('tells a resumed session the files still unmerged, and nothing once none are', () => {
    const merge = { base: newer, kept: { files: files.slice(2, 3), more: 0 } };
    assert.deepEqual(keptMergeInput(merge, 'main', 'implement'), {
      name: 'route',
      source: { kind: 'merge', step: 'implement', branch: 'main' },
      text: [
        `The merge of main at ${newer} is still in progress in this worktree. These files are still unmerged:\n- old.ts (deleted by them, without conflict markers)`,
        resolve,
      ].join('\n\n'),
    });
    assert.equal(
      keptMergeInput({ base: newer, merged: 'a'.repeat(40) }, 'main', 'implement'),
      undefined,
    );
  });
});
