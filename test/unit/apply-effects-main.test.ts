// `foedrum recipe`'s effects on the real machine (ADR 0355): applyEffectsFromCheckout with stub
// tools, in a folder that holds no Brewery. No process starts (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyEffectsFromCheckout } from '../../src/cli/apply-effects-main.ts';
import { messageOf } from '../../src/platform/errors.ts';

const later =
  'the recipe label and status comment go up at the next foedrum brew or foedrum serve: ';

/** Its lines, or what it threw. */
const linesOf = (options: Parameters<typeof applyEffectsFromCheckout>[2]) =>
  applyEffectsFromCheckout('no-brewery', '12-1', options).catch((error: unknown) => [
    `threw: ${messageOf(error)}`,
  ]);

describe('applyEffectsFromCheckout (ADR 0355)', () => {
  it('says the effects wait, rather than failing the recorded choice, when its setup throws', async () => {
    let asked = 0;
    const options = {
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'not here', output: 'not here' }),
      // The first lookup throws, as a PATH that cannot be read would; the others find nothing.
      resolve: () => {
        asked += 1;
        if (asked === 1) throw new Error('the PATH cannot be read');
        return undefined;
      },
    };
    assert.deepStrictEqual(await linesOf(options), [`${later}the PATH cannot be read`]);
  });

  it("says the effects wait with each of the setup's problems, where no Brewery is", async () => {
    const options = {
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'not here', output: 'not here' }),
      resolve: () => undefined,
    };
    const lines = await linesOf(options);
    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(line.startsWith(later), line);
    assert.ok(
      lines.some((line) => /foedrum\.jsonc/.test(line)),
      lines.join('\n'),
    );
  });
});
