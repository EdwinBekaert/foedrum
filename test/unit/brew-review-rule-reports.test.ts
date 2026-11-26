// /brew-review lets a reviewer report a house-yeast rule as wrong, as a batch's Taster may (#1162):
// the lens reviewers are told a rule can be wrong, the session handles such a finding like any other,
// and a new lesson is worded with the situation it holds in.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (...path: string[]): string => readFileSync(join(root, ...path), 'utf8');
const skill = () => read('.claude', 'skills', 'brew-review', 'SKILL.md');

describe('/brew-review and a house-yeast rule that is wrong (#1162)', () => {
  it("tells its lens reviewers that a rule can be wrong or out of date, and to report the rule's id instead of holding the change to it", () => {
    const prompt = read('.claude', 'skills', 'brew-review', 'reviewer-prompt.md');
    const lens = prompt.slice(prompt.indexOf('**For a lens**'), prompt.indexOf('```json'));
    assert.ok(lens.length > 0, 'the reviewer prompt has no "For a lens" paragraph');
    assert.match(lens, /can be wrong or out of date/);
    assert.match(lens, /report[^.\n]*the rule itself[^.\n]*as a finding[^.\n]*its id/);
    assert.match(lens, /holding the change to (it|the rule)/);
  });

  it("fixes such a finding by narrowing the rule's text or scope or by retiring it in the same pull request, then regenerates the rules", () => {
    const text = skill();
    const dispositions = text.slice(
      text.indexOf('Then go through every finding'),
      text.indexOf('**House-yeast candidates**'),
    );
    assert.ok(dispositions.length > 0, 'stage 3 was not found');
    assert.match(dispositions, /narrow(ing)? the rule/);
    assert.match(dispositions, /`retired`/);
    assert.match(dispositions, /npm run house-yeast:rules/);
  });

  it('asks that a lesson be worded with the situation it holds in, its globs matching that situation, not only the files of the change that taught it', () => {
    const [step = ''] = skill()
      .split('\n')
      .filter((line) => line.startsWith('2. Word the lesson'));
    assert.ok(step.length > 0, 'the step that words the lesson was not found');
    assert.match(step, /situation/);
    assert.match(step, /not only the files of the change/);
  });
});
