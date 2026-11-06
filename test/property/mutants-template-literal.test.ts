// The replacement rule over generated template literals (ADR 0341): a replacement with a name in
// its code that the original's code lacks is never valid. The oracle takes the code's names from
// the generated line, not from the check's reading of it, so text moved into code counts as new.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { replacementReason } from '../../src/checks/mutants.ts';
import { type Random, seededRandom } from '../helpers/event-sequences.ts';
import { forEachSeed } from '../helpers/property.ts';

const names = ['alpha', 'beta', 'gamma', 'delta', 'eval'];

interface Line {
  text: string;
  /** The words of the line that are code when it runs. */
  code: string[];
}

const part = (random: Random, depth: number): Line => {
  const word = random.pick(names);
  const parts: Array<() => Line> = [
    () => ({ text: `${word} `, code: [] }),
    () => ({ text: `\\\${${word}} `, code: [] }),
    () => ({ text: `\\\` ${word} `, code: [] }),
    () => ({ text: `\${${word}} `, code: [word] }),
    () => ({ text: `\${${word} / 2} `, code: [word] }),
  ];
  if (depth < 2) {
    parts.push(() => {
      const inner = literal(random, depth + 1);
      return { text: `\${${inner.text}} `, code: inner.code };
    });
  }
  return random.pick(parts)();
};

const literal = (random: Random, depth: number): Line => {
  const parts = Array.from({ length: 1 + random.int(3) }, () => part(random, depth));
  return {
    text: `\`${parts.map(({ text }) => text).join('')}\``,
    code: parts.flatMap(({ code }) => code),
  };
};

const line = (random: Random): Line => {
  const word = random.pick(names);
  const { text, code } = literal(random, 0);
  return random.pick([
    { text, code },
    { text: `${word}${text}`, code: [word, ...code] },
    { text: `${word} + ${text}`, code: [word, ...code] },
    { text: `${word}(${text})`, code: [word, ...code] },
  ]);
};

it("reordering a literal's own words and expressions is always valid (ADR 0341)", () => {
  forEachSeed(50, (seed) => {
    const random = seededRandom(seed);
    for (let trial = 0; trial < 50; trial += 1) {
      const parts = Array.from({ length: 2 + random.int(4) }, () => {
        const word = random.pick(names);
        return random.chance(0.5) ? word : `\${${word}}`;
      });
      const original = `x(\`${parts.join(' ')}\`);`;
      const replacement = `x(\`${parts.toReversed().join(' ')}\`);`;
      if (original === replacement) continue;
      const reason = replacementReason({
        file: 'web/line.ts',
        line: 1,
        original,
        replacement,
      });
      assert.equal(reason, undefined, `${original} to ${replacement}`);
    }
  });
});

it('a replacement with a new name in its code is never valid (ADR 0341)', () => {
  forEachSeed(50, (seed) => {
    const random = seededRandom(seed);
    for (let trial = 0; trial < 50; trial += 1) {
      const original = line(random);
      const replacement = line(random);
      const known = new Set(original.code);
      const added = replacement.code.filter((word) => !known.has(word));
      if (added.length === 0) continue;
      const reason = replacementReason({
        file: 'web/line.ts',
        line: 1,
        original: original.text,
        replacement: replacement.text,
      });
      assert.notEqual(
        reason,
        undefined,
        `${original.text} to ${replacement.text} adds ${added.join(', ')} to its code`,
      );
    }
  });
});
