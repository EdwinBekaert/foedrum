// Unit tests must not depend on how they are started. Two gate tests once passed under npm test
// and failed under plain node --test (#58), so the gate's unit tests also run here without npm's
// environment: no npm_* variables and no node_modules/.bin on PATH.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');

const withoutNpm = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => !/^npm_/i.test(key))
      .map(([key, value]) =>
        /^path$/i.test(key)
          ? [
              key,
              value
                ?.split(delimiter)
                .filter((dir) => !/node_modules[\\/]\.bin/.test(dir))
                .join(delimiter),
            ]
          : [key, value],
      ),
  );

describe('unit tests under plain node --test', () => {
  it('passes test/unit/precheck.test.ts without npm', () => {
    const result = spawnSync(
      process.execPath,
      ['--test', join('test', 'unit', 'precheck.test.ts')],
      {
        cwd: root,
        env: withoutNpm(process.env),
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});
