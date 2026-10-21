import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { brewerBaseEnv, brewerForcedEnv, buildBrewerEnv } from '../../src/engine/brewer-env.ts';

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

/** The configuration pairs `env` gives git through GIT_CONFIG_COUNT, in order. */
const gitConfig = (env: Record<string, string>): [string, string | undefined][] =>
  Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, n) => [
    env[`GIT_CONFIG_KEY_${n}`] ?? '',
    env[`GIT_CONFIG_VALUE_${n}`],
  ]);

describe('brewerForcedEnv (ADR 0109)', () => {
  it('keeps npm from running lifecycle scripts', () => {
    assert.equal(brewerForcedEnv().npm_config_ignore_scripts, 'true');
  });

  it('turns off git prompting on the terminal', () => {
    assert.equal(brewerForcedEnv().GIT_TERMINAL_PROMPT, '0');
  });

  it("empties git's list of credential helpers and its askpass program, over every config file", () => {
    const config = gitConfig(brewerForcedEnv());
    assert.deepEqual(
      config.filter(([key]) => key === 'credential.helper' || key === 'core.askPass'),
      [
        ['credential.helper', ''],
        ['core.askPass', ''],
      ],
    );
  });

  it('lets git use local paths as git does by default, git, http and https, and no other transport', () => {
    const protocols = gitConfig(brewerForcedEnv()).filter(([key]) => key.startsWith('protocol.'));
    assert.deepEqual(protocols, [
      ['protocol.allow', 'never'],
      ['protocol.file.allow', 'user'],
      ['protocol.git.allow', 'always'],
      ['protocol.http.allow', 'always'],
      ['protocol.https.allow', 'always'],
      ['protocol.ssh.allow', 'never'],
    ]);
  });

  it('names a key and a value for every pair it counts, and no pair it does not', () => {
    const env = brewerForcedEnv();
    const count = Number(env.GIT_CONFIG_COUNT);
    assert.ok(Number.isInteger(count) && count > 0, env.GIT_CONFIG_COUNT);
    const named = Object.keys(env).filter((name) => /^GIT_CONFIG_(?:KEY|VALUE)_/.test(name));
    assert.deepEqual(
      named.sort(),
      Array.from({ length: count }, (_, n) => [`GIT_CONFIG_KEY_${n}`, `GIT_CONFIG_VALUE_${n}`])
        .flat()
        .sort(),
    );
  });

  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    it(`lets neither the base nor a brewer's env undo it on ${platform}`, () => {
      const forced = brewerForcedEnv();
      const undo = {
        git_config_count: '0',
        GIT_CONFIG_COUNT: '0',
        GIT_CONFIG_VALUE_0: 'store',
        GIT_TERMINAL_PROMPT: '1',
      };
      const env = buildBrewerEnv({ base: undo, brewer: undo, forced, platform });
      for (const [name, value] of Object.entries(forced)) assert.equal(env[name], value, name);
    });
  }
});

describe('brewerBaseEnv (ADR 0063)', () => {
  const engine = {
    PATH: '/usr/bin',
    HOME: '/home/ann',
    TMPDIR: '/tmp/ann',
    CLAUDE_CONFIG_DIR: '/home/ann/.claude-work',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    ANTHROPIC_BASE_URL: 'https://proxy.example',
    GH_TOKEN: 'ghp_secret',
    GITHUB_TOKEN: 'ghp_secret',
    AWS_SECRET_ACCESS_KEY: 'aws',
    NODE_OPTIONS: '--inspect',
    CLAUDE_CODE_USE_BEDROCK: '1',
    UNSET: undefined,
  };

  it("keeps what a process needs to start and claude's own login, nothing else", () => {
    assert.deepEqual(brewerBaseEnv(engine, 'linux'), {
      PATH: '/usr/bin',
      HOME: '/home/ann',
      TMPDIR: '/tmp/ann',
      CLAUDE_CONFIG_DIR: '/home/ann/.claude-work',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
    });
  });

  it('keeps what claude needs to find its login and start on macOS and Windows', () => {
    const posix = { USER: 'ann', LOGNAME: 'ann' };
    assert.deepEqual(brewerBaseEnv(posix, 'darwin'), posix);
    const windows = {
      CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Git\\bin\\bash.exe',
      SystemDrive: 'C:',
      ProgramFiles: 'C:\\Program Files',
      ProgramData: 'C:\\ProgramData',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\ann',
    };
    assert.deepEqual(brewerBaseEnv(windows, 'win32'), windows);
  });

  it('keeps every name of the allowlist ADR 0063 lists', () => {
    const names = [
      'PATH',
      'PATHEXT',
      'SYSTEMROOT',
      'WINDIR',
      'COMSPEC',
      'TEMP',
      'TMP',
      'TMPDIR',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'SYSTEMDRIVE',
      'PROGRAMFILES',
      'PROGRAMDATA',
      'HOMEDRIVE',
      'HOMEPATH',
      'USER',
      'LOGNAME',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_GIT_BASH_PATH',
      'ANTHROPIC_AUTH_TOKEN',
    ];
    const env = Object.fromEntries(names.map((name) => [name, `${name} value`]));
    for (const platform of ['linux', 'win32'] as const) {
      assert.deepEqual(brewerBaseEnv(env, platform), env, platform);
    }
  });

  it('matches names in any case on Windows, keeping their spelling, and exactly elsewhere', () => {
    const env = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', userprofile: 'C:\\Users\\ann' };
    assert.deepEqual(brewerBaseEnv(env, 'win32'), env);
    assert.deepEqual(brewerBaseEnv(env, 'linux'), {});
  });
});
