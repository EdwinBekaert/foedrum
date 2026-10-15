import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildBrewerEnv } from '../../src/engine/brewer-env.ts';

const forced = {
  PATH: '/usr/bin:/bin',
  npm_config_ignore_scripts: 'true',
  CLAUDE_CONFIG_DIR: '/brewery/attempts/b1-plan-1',
  HOME: '/brewery/attempts/b1-plan-1/home',
};

/** The names of `env` that equal `name` in any case. */
const spellings = (env: Record<string, string>, name: string): string[] =>
  Object.keys(env).filter((key) => key.toUpperCase() === name.toUpperCase());

describe('buildBrewerEnv (#81)', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    describe(`on ${platform}`, () => {
      it('starts from the base, adds the brewer env and applies the forced variables', () => {
        const env = buildBrewerEnv({
          base: { LANG: 'C.UTF-8', TZ: 'UTC' },
          brewer: { TZ: 'Europe/Brussels', FEATURE_FLAG: 'on' },
          forced,
          platform,
        });
        assert.deepStrictEqual(env, {
          LANG: 'C.UTF-8',
          TZ: 'Europe/Brussels',
          FEATURE_FLAG: 'on',
          ...forced,
        });
      });

      it('lets a frontmatter env override no forced variable', () => {
        const brewer = Object.fromEntries(Object.keys(forced).map((name) => [name, 'brewer']));
        const env = buildBrewerEnv({ base: brewer, brewer, forced, platform });
        assert.deepStrictEqual(env, forced);
      });
    });
  }

  describe('on Windows, where names do not differ by case', () => {
    it('lets no other spelling of a forced variable shadow it', () => {
      for (const [name, value] of Object.entries(forced)) {
        for (const spelling of [
          name.toLowerCase(),
          name.toUpperCase(),
          `${name[0]}${name.slice(1).toLowerCase()}`,
        ]) {
          const env = buildBrewerEnv({
            base: { [spelling]: 'base' },
            brewer: { [spelling]: 'brewer' },
            forced,
            platform: 'win32',
          });
          assert.deepStrictEqual(spellings(env, name), [name], `${spelling} over ${name}`);
          assert.equal(env[name], value, `${spelling} over ${name}`);
        }
      }
    });

    it('lets the brewer env replace a base variable in another spelling', () => {
      const env = buildBrewerEnv({
        base: { TEMP: 'C:\\base' },
        brewer: { Temp: 'C:\\brewer' },
        forced: {},
        platform: 'win32',
      });
      assert.deepStrictEqual(env, { Temp: 'C:\\brewer' });
    });
  });

  for (const platform of ['linux', 'darwin'] as const) {
    it(`keeps names that differ by case apart on ${platform}: they are other variables`, () => {
      const env = buildBrewerEnv({
        base: {},
        brewer: { Path: 'brewer' },
        forced: { PATH: '/usr/bin' },
        platform,
      });
      assert.deepStrictEqual(env, { Path: 'brewer', PATH: '/usr/bin' });
    });
  }

  it('changes none of its layers', () => {
    const base = { Path: 'C:\\base' };
    const brewer = { TZ: 'UTC' };
    const forcedPath = { PATH: 'C:\\Windows' };
    buildBrewerEnv({ base, brewer, forced: forcedPath, platform: 'win32' });
    assert.deepStrictEqual(
      [base, brewer, forcedPath],
      [{ Path: 'C:\\base' }, { TZ: 'UTC' }, { PATH: 'C:\\Windows' }],
    );
  });
});
