// The replacement rule over generated template literals (ADR 0341).

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { replacementReason } from '../../src/checks/mutants.ts';
import { seededRandom } from '../helpers/event-sequences.ts';
import { forEachSeed } from '../helpers/property.ts';

const names = ['alpha', 'beta', 'gamma', 'delta', 'eval'];

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
