import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDraft } from '../../scripts/issue-draft/core.ts';

// GitHub's limits, written out so a changed limit in the check fails here.
const titleLimit = 256;
const bodyLimit = 65_536;

const draft = (value: unknown): string => JSON.stringify(value);
const problemsOf = (text: string): string[] => {
  const result = checkDraft(text);
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  return result.ok ? [] : result.problems;
};

describe('checkDraft', () => {
  it('accepts exactly a one-line title and a body, and gives the title', () => {
    const title = 'Leases are not released when a brewer is stopped';
    assert.deepEqual(checkDraft(draft({ title, body: 'Found in #262.\n\nScenario: …' })), {
      ok: true,
      title,
    });
  });

  it('accepts a body that is empty, and limits that are reached but not passed', () => {
    assert.deepEqual(checkDraft(draft({ title: 't'.repeat(titleLimit), body: '' })), {
      ok: true,
      title: 't'.repeat(titleLimit),
    });
    assert.equal(checkDraft(draft({ title: 't', body: 'b'.repeat(bodyLimit) })).ok, true);
  });

  it('tolerates a byte order mark and CRLF around the JSON', () => {
    assert.deepEqual(checkDraft(`\uFEFF${draft({ title: 't', body: 'b' })}\r\n`), {
      ok: true,
      title: 't',
    });
  });

  it('counts characters, not UTF-16 units, so an emoji title at the limit passes', () => {
    assert.equal(checkDraft(draft({ title: '🍺'.repeat(titleLimit), body: '' })).ok, true);
  });

  it('refuses text that is not JSON', () => {
    const [problem, ...rest] = problemsOf('{"title": "t",');
    assert.match(problem ?? '', /^the draft is not JSON: /);
    assert.deepEqual(rest, []);
  });

  it("quotes the parser's message, so the draft text it shows cannot forge a line or reach the terminal", () => {
    const rightToLeft = String.fromCodePoint(0x202e);
    const [problem] = problemsOf(`{"title": "t",\n"body": x\u001b[2J${rightToLeft}}`);
    assert.match(problem ?? '', /^the draft is not JSON: ".*"$/);
    assert.doesNotMatch(problem ?? '', /[\p{Cc}\p{Cf}]/u);
  });

  it("keeps the draft text the parser's message shows, escaped", () => {
    const rightToLeft = String.fromCodePoint(0x202e);
    const [problem] = problemsOf(`{"title": x\u001b[2J${rightToLeft}}`);
    assert.match(problem ?? '', /\\u001b\[2J\\u202e/);
  });

  it('refuses JSON that is not an object', () => {
    for (const value of [null, ['t', 'b'], 't', 1]) {
      assert.deepEqual(problemsOf(draft(value)), ['the draft is not a JSON object']);
    }
  });

  it('refuses every key besides title and body, one line each', () => {
    assert.deepEqual(
      problemsOf(draft({ title: 't', body: 'b', labels: ['bug'], assignees: ['someone'] })),
      ['unexpected key "labels"', 'unexpected key "assignees"'],
    );
  });

  it('quotes an unexpected key, so a line break in it cannot forge another line', () => {
    assert.deepEqual(problemsOf(draft({ title: 't', body: 'b', 'x\nok': 1 })), [
      'unexpected key "x\\nok"',
    ]);
  });

  it('escapes a format character in an unexpected key, so it cannot reorder the line', () => {
    const key = `a${String.fromCodePoint(0x202e)}b`;
    assert.deepEqual(problemsOf(draft({ title: 't', body: 'b', [key]: 1 })), [
      'unexpected key "a\\u202eb"',
    ]);
  });

  it('refuses a key given twice, since GitHub may keep another value than the check read', () => {
    assert.deepEqual(problemsOf('{"title": "a", "body": "b", "title": "c"}'), [
      'duplicate key "title"',
    ]);
    // An escaped name is the same key.
    assert.deepEqual(problemsOf('{"t\\u0069tle": "a\\nb", "body": "b", "title": "ok"}'), [
      'duplicate key "title"',
    ]);
  });

  it('looks for duplicates only among the keys of the draft itself', () => {
    assert.deepEqual(problemsOf('{"title": "a", "body": {"title": 1, "body": 2}}'), [
      '"body" is not a string',
    ]);
    assert.deepEqual(checkDraft('{"title": "a {\\"title\\": [1]}", "body": "\\"title\\":"}'), {
      ok: true,
      title: 'a {"title": [1]}',
    });
  });

  it('refuses a missing title and body', () => {
    assert.deepEqual(problemsOf(draft({})), ['"title" is missing', '"body" is missing']);
  });

  it('refuses a title or body that is not a string', () => {
    assert.deepEqual(problemsOf(draft({ title: ['t'], body: null })), [
      '"title" is not a string',
      '"body" is not a string',
    ]);
  });

  it('refuses an empty or blank title', () => {
    assert.deepEqual(problemsOf(draft({ title: '', body: 'b' })), ['"title" is empty']);
    assert.deepEqual(problemsOf(draft({ title: ' \t ', body: 'b' })), ['"title" is empty']);
  });

  it('refuses a title of more than one line, whatever the line break', () => {
    for (const lineBreak of ['\n', '\r', '\r\n', '\u2028', '\u2029', '\u0085', '\v', '\f']) {
      assert.deepEqual(
        problemsOf(draft({ title: `first${lineBreak}second`, body: 'b' })),
        ['"title" is more than one line'],
        JSON.stringify(lineBreak),
      );
    }
  });

  it('refuses a title with another control character, which would reach the terminal', () => {
    assert.deepEqual(problemsOf(draft({ title: 'red \u001b[31m title', body: 'b' })), [
      '"title" has a control character',
    ]);
  });

  it('refuses a title with a format character, which can show the user another title', () => {
    for (const codePoint of [0x202e, 0x2066, 0x200b, 0x200d, 0xfeff]) {
      const title = `safe${String.fromCodePoint(codePoint)}title`;
      assert.deepEqual(
        problemsOf(draft({ title, body: 'b' })),
        ['"title" has an invisible format character'],
        codePoint.toString(16),
      );
    }
  });

  it('refuses a title over 256 characters and a body over 65,536', () => {
    assert.deepEqual(
      problemsOf(draft({ title: 't'.repeat(titleLimit + 1), body: 'b'.repeat(bodyLimit + 1) })),
      [
        `"title" has ${titleLimit + 1} characters, more than ${titleLimit}`,
        `"body" has ${bodyLimit + 1} characters, more than ${bodyLimit}`,
      ],
    );
  });

  it('gives every problem of one draft, keys first', () => {
    assert.deepEqual(problemsOf(draft({ title: 'a\nb', milestone: 1 })), [
      'unexpected key "milestone"',
      '"title" is more than one line',
      '"body" is missing',
    ]);
  });
});
