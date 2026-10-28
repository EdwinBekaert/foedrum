import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dispositionsOf,
  lensOfFinding,
  MAX_DISPOSITION_FILE,
  MAX_DISPOSITION_WHY,
  MAX_RISK_LEFT,
  MOST_DISPOSITIONS,
  MOST_RISKS_LEFT,
  OutDocFrontmatter,
  outDocFrontmatter,
  PullRequestOutDoc,
  readOutDoc,
  TastingOutDoc,
  tastingOf,
  tastingOutDocOf,
} from '../../src/schemas/out-doc.ts';
import { z } from '../../src/schemas/zod.ts';

const question = {
  q: 'Keep the v1 endpoint?',
  options: ['keep', 'remove'],
  recommended: 'keep',
  whyBlocking: 'Removing it breaks the mobile app',
};

const outDoc = (frontmatter: unknown, body = '# Report\n'): string =>
  `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;

describe('OutDocFrontmatter', () => {
  // Typed as a record so that adding or removing a status fails the typecheck until this list follows.
  const valid: Record<OutDocFrontmatter['status'], OutDocFrontmatter> = {
    done: { status: 'done', summary: 'Added the retry cap', assumptions: ['Cap of 5 tries'] },
    needs_input: {
      status: 'needs_input',
      summary: 'Unsure about the v1 endpoint',
      assumptions: [],
      questions: [question],
    },
    blocked: {
      status: 'blocked',
      summary: 'Tests cannot start: no database',
      assumptions: [],
      blockerKind: 'environment',
    },
    failed: { status: 'failed', summary: 'Could not reproduce the bug', assumptions: [] },
  };
  for (const [status, frontmatter] of Object.entries(valid)) {
    it(`accepts ${status}`, () => {
      assert.deepEqual(OutDocFrontmatter.parse(frontmatter), frontmatter);
    });
  }

  it('defaults assumptions to an empty list', () => {
    assert.deepEqual(OutDocFrontmatter.parse({ status: 'done', summary: 'No change needed' }), {
      status: 'done',
      summary: 'No change needed',
      assumptions: [],
    });
  });

  it('accepts every blocker kind', () => {
    for (const blockerKind of ['findings', 'environment', 'divergence']) {
      const frontmatter = { status: 'blocked', summary: 'Blocked', blockerKind };
      assert.equal(OutDocFrontmatter.safeParse(frontmatter).success, true, blockerKind);
    }
  });

  const invalid: [string, unknown][] = [
    ['an unknown status', { status: 'partial', summary: 'Half done' }],
    ['no status', { summary: 'Done' }],
    ['no summary', { status: 'done' }],
    ['an empty summary', { status: 'done', summary: ' ' }],
    ['a summary of more than one line', { status: 'done', summary: 'One\nTwo' }],
    ['an empty assumption', { status: 'done', summary: 'Done', assumptions: [''] }],
    ['questions with done', { status: 'done', summary: 'Done', questions: [question] }],
    ['blockerKind with done', { status: 'done', summary: 'Done', blockerKind: 'findings' }],
    ['needs_input without questions', { status: 'needs_input', summary: 'Asking' }],
    ['needs_input with no questions', { status: 'needs_input', summary: 'Asking', questions: [] }],
    [
      'blockerKind with needs_input',
      { status: 'needs_input', summary: 'x', questions: [question], blockerKind: 'findings' },
    ],
    ['blocked without blockerKind', { status: 'blocked', summary: 'Blocked' }],
    ['an unknown blockerKind', { status: 'blocked', summary: 'Blocked', blockerKind: 'weather' }],
    [
      'questions with blocked',
      { status: 'blocked', summary: 'x', blockerKind: 'findings', questions: [question] },
    ],
    ['questions with failed', { status: 'failed', summary: 'Failed', questions: [question] }],
    ['an unknown field', { status: 'done', summary: 'Done', verdict: 'approve' }],
    ['an array', [{ status: 'done', summary: 'Done' }]],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => {
      assert.equal(OutDocFrontmatter.safeParse(value).success, false);
    });
  }
});

describe('outDocFrontmatter with brewer-specific fields', () => {
  const Review = outDocFrontmatter({ verdict: z.enum(['approve', 'changes']).optional() });

  it('accepts the brewer-specific fields with every status', () => {
    assert.deepEqual(Review.parse({ status: 'done', summary: 'Looks good', verdict: 'approve' }), {
      status: 'done',
      summary: 'Looks good',
      assumptions: [],
      verdict: 'approve',
    });
    const blocked = {
      status: 'blocked',
      summary: 'x',
      blockerKind: 'findings',
      verdict: 'changes',
    };
    assert.equal(Review.safeParse(blocked).success, true);
  });

  it('validates the brewer-specific fields', () => {
    assert.equal(
      Review.safeParse({ status: 'done', summary: 'x', verdict: 'maybe' }).success,
      false,
    );
  });

  it('still enforces the shared contract', () => {
    assert.equal(
      Review.safeParse({ status: 'blocked', summary: 'x', verdict: 'changes' }).success,
      false,
    );
  });

  for (const field of ['status', 'summary', 'assumptions', 'questions', 'blockerKind']) {
    it(`refuses a brewer-specific field that replaces ${field}`, () => {
      assert.throws(() => outDocFrontmatter({ [field]: z.string().optional() }), {
        message: new RegExp(field),
      });
    });
  }
});

describe('readOutDoc', () => {
  it('returns the validated frontmatter and the body', () => {
    const text = outDoc({ status: 'done', summary: 'Added the cap' }, '# Report\n\nDetails\n');
    assert.deepEqual(readOutDoc(text, OutDocFrontmatter), {
      valid: true,
      frontmatter: { status: 'done', summary: 'Added the cap', assumptions: [] },
      body: '# Report\n\nDetails\n',
    });
  });

  it('accepts comments and trailing commas in the frontmatter (ADR 0020)', () => {
    const text =
      '---\n{\n  // written by a model\n  "status": "done",\n  "summary": "Done",\n}\n---\n';
    const result = readOutDoc(text, OutDocFrontmatter);
    assert.equal(result.valid, true);
  });

  it('validates against a brewer-specific schema', () => {
    const Review = outDocFrontmatter({ verdict: z.enum(['approve', 'changes']) });
    const result = readOutDoc(outDoc({ status: 'done', summary: 'x', verdict: 'approve' }), Review);
    assert.deepEqual(result.valid && result.frontmatter.verdict, 'approve');
  });

  const invalid: [string, string, RegExp][] = [
    ['no frontmatter', '# Report\n', /line 1, column 1/],
    ['malformed JSON', '---\n{"status": "done",, }\n---\n', /line 2/],
    [
      'a frontmatter that breaks the contract',
      outDoc({ status: 'blocked', summary: 'x' }),
      /blockerKind/,
    ],
    ['a frontmatter with an unknown status', outDoc({ status: 'partial', summary: 'x' }), /status/],
  ];
  for (const [name, text, reason] of invalid) {
    it(`is invalid, with a reason, for ${name}`, () => {
      const result = readOutDoc(text, OutDocFrontmatter);
      assert.equal(result.valid, false);
      assert.match(result.valid ? '' : result.reason, reason);
    });
  }
});

describe('dispositions (ADR 0191)', () => {
  const done = { status: 'done', summary: 'Fixed what round 1 found' } as const;
  const fixed = { file: 'src/a.ts', line: 12, disposition: 'fixed' } as const;
  const dismissed = { file: 'src/b.ts', disposition: 'dismissed', why: 'The cap is the spec' };
  const preExisting = { disposition: 'pre-existing', why: 'The retry loop was there before' };

  it('accepts each disposition with every status, in the contract and a brewer schema', () => {
    const dispositions = [fixed, dismissed, preExisting];
    for (const status of ['done', 'failed'] as const) {
      const doc = { status, summary: 'x', dispositions };
      assert.deepEqual(OutDocFrontmatter.parse(doc), { ...doc, assumptions: [] }, status);
    }
    const blocked = { status: 'blocked', summary: 'x', blockerKind: 'findings', dispositions };
    assert.deepEqual(PullRequestOutDoc.parse(blocked), {
      ...blocked,
      assumptions: [],
      beforeAfter: [],
    });
  });

  it('takes a why on a fixed finding too, and leaves an out doc without them as it was', () => {
    const said = { ...fixed, why: 'Capped at five' };
    const doc = { ...done, dispositions: [said] };
    assert.deepEqual(OutDocFrontmatter.parse(doc), { ...doc, assumptions: [] });
    assert.deepEqual(OutDocFrontmatter.parse(done), { ...done, assumptions: [] });
  });

  const invalid: [string, unknown][] = [
    ['a dismissal without a why', { file: 'a.ts', disposition: 'dismissed' }],
    ['a pre-existing finding without a why', { disposition: 'pre-existing' }],
    ['an empty why', { disposition: 'dismissed', why: ' ' }],
    ['an unknown disposition', { file: 'a.ts', disposition: 'ignored', why: 'x' }],
    ['a line that is not a positive whole number', { ...fixed, line: 0 }],
    ['a file of two lines', { ...fixed, file: 'a.ts\nb.ts' }],
    ['an unknown key', { ...fixed, severity: 'major' }],
  ];
  for (const [name, disposition] of invalid) {
    it(`rejects ${name}`, () => {
      const doc = { ...done, dispositions: [disposition] };
      assert.equal(OutDocFrontmatter.safeParse(doc).success, false);
    });
  }

  it(`takes ${MOST_DISPOSITIONS} dispositions, and no more`, () => {
    const many = (count: number) => ({ ...done, dispositions: Array(count).fill(fixed) });
    assert.equal(OutDocFrontmatter.safeParse(many(MOST_DISPOSITIONS)).success, true);
    assert.equal(OutDocFrontmatter.safeParse(many(MOST_DISPOSITIONS + 1)).success, false);
  });

  it(`takes a why of ${MAX_DISPOSITION_WHY} characters and a file of ${MAX_DISPOSITION_FILE}, and no more`, () => {
    const sized = (file: number, why: number) => ({
      ...done,
      dispositions: [{ file: 'f'.repeat(file), disposition: 'dismissed', why: 'w'.repeat(why) }],
    });
    const parses = (doc: unknown) => OutDocFrontmatter.safeParse(doc).success;
    assert.equal(parses(sized(MAX_DISPOSITION_FILE, MAX_DISPOSITION_WHY)), true);
    assert.equal(parses(sized(MAX_DISPOSITION_FILE + 1, MAX_DISPOSITION_WHY)), false);
    assert.equal(parses(sized(MAX_DISPOSITION_FILE, MAX_DISPOSITION_WHY + 1)), false);
  });

  it('refuses a brewer-specific field that replaces them', () => {
    assert.throws(() => outDocFrontmatter({ dispositions: z.string().optional() }), {
      message: /dispositions/,
    });
  });

  it("reads them from any out doc's output, and none from one without them", () => {
    assert.deepEqual(dispositionsOf({ ...done, dispositions: [fixed, dismissed] }), [
      fixed,
      dismissed,
    ]);
    assert.deepEqual(dispositionsOf({ ...done, verdict: 'approve' }), []);
    assert.deepEqual(dispositionsOf({ ...done, dispositions: [{ disposition: 'maybe' }] }), []);
    assert.deepEqual(dispositionsOf(null), []);
  });
});

describe("a Taster's riskLeft (ADR 0214)", () => {
  const approved = { status: 'done', summary: 'Tasted', verdict: 'approve' } as const;
  const risks = ['The retry path only shows in a run', 'Could not read src/vendor/big.ts'];

  it('takes a list of one-line items, and reads an out doc without it as before', () => {
    const doc = { ...approved, riskLeft: risks };
    assert.deepEqual(TastingOutDoc.parse(doc), { ...doc, assumptions: [], findings: [] });
    assert.deepEqual(TastingOutDoc.parse(approved), { ...approved, assumptions: [], findings: [] });
    assert.equal(TastingOutDoc.safeParse({ ...approved, riskLeft: [] }).success, true);
  });

  /** The one issue a refused out doc has, at its path. */
  const refusal = (riskLeft: unknown) => {
    const read = TastingOutDoc.safeParse({ ...approved, riskLeft });
    assert.equal(read.success, false);
    assert.equal(read.error?.issues.length, 1, JSON.stringify(read.error?.issues));
    return read.error?.issues[0]?.path;
  };

  it(`takes an item of ${MAX_RISK_LEFT} characters, and refuses a longer one with one line`, () => {
    const sized = (length: number) => ({ ...approved, riskLeft: ['r'.repeat(length)] });
    assert.equal(TastingOutDoc.safeParse(sized(MAX_RISK_LEFT)).success, true);
    assert.deepEqual(refusal(['r'.repeat(MAX_RISK_LEFT + 1)]), ['riskLeft', 0]);
  });

  it(`takes ${MOST_RISKS_LEFT} items, and refuses more with one line`, () => {
    const many = (count: number) => Array(count).fill('One risk');
    assert.equal(
      TastingOutDoc.safeParse({ ...approved, riskLeft: many(MOST_RISKS_LEFT) }).success,
      true,
    );
    assert.deepEqual(refusal(many(MOST_RISKS_LEFT + 1)), ['riskLeft']);
  });

  it('refuses an item of two lines, an empty one, and a list that is not one', () => {
    assert.deepEqual(refusal(['one\ntwo']), ['riskLeft', 0]);
    assert.deepEqual(refusal([' ']), ['riskLeft', 0]);
    assert.deepEqual(refusal('one risk'), ['riskLeft']);
  });

  it('is given back by tastingOf beside the verdict and findings, and not when empty', () => {
    assert.deepEqual(tastingOf({ ...approved, riskLeft: risks }), {
      verdict: 'approve',
      findings: [],
      riskLeft: risks,
    });
    assert.deepEqual(tastingOf({ ...approved, riskLeft: [] }), {
      verdict: 'approve',
      findings: [],
    });
    assert.deepEqual(tastingOf(approved), { verdict: 'approve', findings: [] });
  });
});

describe("a finding's lens (#560, ADR 0220)", () => {
  const finding = { file: 'src/a.ts', line: 3, severity: 'major', why: 'Wrong', introduced: true };
  const changes = { status: 'done', summary: 'Tasted', verdict: 'changes' } as const;

  it('takes a finding that names its lens, and reads one without it as before', () => {
    const named = { ...finding, lens: 'diff/security' };
    const doc = { ...changes, findings: [named, finding] };
    assert.deepEqual(TastingOutDoc.safeParse(doc).data?.findings, [named, finding]);
    assert.equal(
      TastingOutDoc.safeParse({ ...doc, findings: [{ ...finding, lens: 'security' }] }).success,
      false,
    );
  });

  it("reads a finding without a lens as its step's", () => {
    assert.equal(
      lensOfFinding({ ...finding, severity: 'major' }, 'diff/correctness'),
      'diff/correctness',
    );
    assert.equal(
      lensOfFinding({ ...finding, severity: 'major', lens: 'diff/security' }, 'diff/correctness'),
      'diff/security',
    );
  });

  describe("the out doc of a step's lenses together", () => {
    const schema = () => tastingOutDocOf(['diff/correctness', 'diff/security']);
    const issuesOf = (findings: readonly unknown[]) => {
      const read = schema().safeParse({ ...changes, findings });
      assert.equal(read.success, false, 'the out doc should be refused');
      return read.error?.issues.map(({ path, message }) => ({ path, message }));
    };

    it("takes findings that each name one of the step's lenses", () => {
      const findings = [
        { ...finding, lens: 'diff/security' },
        { ...finding, lens: 'diff/correctness' },
      ];
      assert.deepEqual(schema().parse({ ...changes, findings }).findings, findings);
    });

    it('refuses a finding without a lens, at its path', () => {
      assert.deepEqual(issuesOf([{ ...finding, lens: 'diff/security' }, finding]), [
        {
          path: ['findings', 1, 'lens'],
          message: 'Must name the lens it was found through: diff/correctness or diff/security',
        },
      ]);
    });

    it("refuses a finding of a lens not of the step's, at its path", () => {
      assert.deepEqual(issuesOf([{ ...finding, lens: 'diff/acceptance' }]), [
        {
          path: ['findings', 0, 'lens'],
          message: 'Must name the lens it was found through: diff/correctness or diff/security',
        },
      ]);
    });

    it('still holds the verdict to the findings of every lens', () => {
      const minor = { ...finding, severity: 'minor', lens: 'diff/security' };
      const read = schema().safeParse({ ...changes, findings: [minor] });
      assert.deepEqual(
        read.error?.issues.map(({ path }) => path),
        [['verdict']],
      );
    });
  });
});
