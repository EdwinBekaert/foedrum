import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OutDocFrontmatter, outDocFrontmatter, readOutDoc } from '../../src/schemas/out-doc.ts';
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
