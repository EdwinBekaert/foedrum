import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptSettings, writeAttemptSettings } from '../../src/brewers/attempt-settings.ts';
import { type AttemptSettings, sandboxCredentials } from '../../src/schemas/attempt-settings.ts';
import { withinCeiling } from '../../src/schemas/primitives.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

describe('attemptSettings', () => {
  it("keeps the brewer's rules and always denies AskUserQuestion and git push in each shell", () => {
    const settings = attemptSettings({
      allow: ['Read', 'Bash(npm test)', 'PowerShell(npm test)'],
      deny: ['WebFetch'],
      sandbox: false,
    });
    assert.deepEqual(settings, {
      permissions: {
        allow: ['Read', 'Bash(npm test)', 'PowerShell(npm test)'],
        deny: ['WebFetch', 'AskUserQuestion', 'Bash(git push *)', 'PowerShell(git push *)'],
      },
    });
  });

  it('denies git push only in the shells the brewer has, and each rule once', () => {
    const settings = attemptSettings({
      allow: ['Read', 'Bash(npm test)'],
      deny: ['AskUserQuestion'],
      sandbox: false,
    });
    assert.deepEqual(settings.permissions.deny, ['AskUserQuestion', 'Bash(git push *)']);
  });

  // ADR 0042: by default a sandbox that cannot start lets commands run unsandboxed.
  it('requires the sandbox to run when the isolation level relies on it', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: true });
    assert.equal(settings.sandbox?.enabled, true);
    assert.equal(settings.sandbox?.failIfUnavailable, true);
    assert.equal(settings.sandbox?.allowUnsandboxedCommands, false);
  });

  // #234: by default Claude Code runs every sandboxed Bash command without asking, whatever the
  // allow rules say, dontAsk included (ADR 0087).
  it('lets the allow rules decide for sandboxed commands too', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: true });
    assert.equal(settings.sandbox?.autoAllowBashIfSandboxed, false);
  });

  // A sandboxed command reads most of the machine and inherits Claude Code's environment, and
  // Claude Code has no credential deny list of its own (ADR 0087).
  it('hides the credential files and variables from sandboxed commands', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: true });
    assert.deepEqual(settings.sandbox?.credentials, {
      files: [
        '~/.config/gh',
        '~/.git-credentials',
        '~/.config/git/credentials',
        '~/.ssh',
        '~/.aws',
        '~/.npmrc',
        '~/.claude/.credentials.json',
        '~/.config/anthropic',
      ].map((path) => ({ path, mode: 'deny' })),
      envVars: [
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'GH_ENTERPRISE_TOKEN',
        'GITHUB_ENTERPRISE_TOKEN',
        'NPM_TOKEN',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ].map((name) => ({ name, mode: 'deny' })),
    });
  });

  it('refuses a rule claude could not read', () => {
    assert.throws(
      () => attemptSettings({ allow: ['Bash(npm test'], deny: [], sandbox: false }),
      /allow/,
    );
    assert.throws(
      () => attemptSettings({ allow: ['AskUserQuestion'], deny: [], sandbox: false }),
      /AskUserQuestion/,
    );
  });
});

// #167: claude matches a deny rule against the command as written, so `git -C . push` gets past
// `Bash(git push *)`, and `git p''ush` past any pattern. A push is denied only when no allow rule
// matches it, so the settings never allow git with no fixed subcommand (ADR 0062).
describe('attemptSettings and git with options before the subcommand', () => {
  const pushes = [
    'git -C . push',
    'git -c x=y push origin',
    'git --git-dir=.git push',
    "git p''ush origin",
  ];

  for (const shell of ['Bash', 'PowerShell']) {
    for (const rule of [
      shell,
      `${shell}(*)`,
      `${shell}(g*)`,
      `${shell}(git*)`,
      `${shell}(git *)`,
      `${shell}(git:*)`,
      `${shell}(GIT *)`,
      `${shell}(git.exe *)`,
      `${shell}(git -C *)`,
      `${shell}(git -c *)`,
      `${shell}(git --git-dir=*)`,
      `${shell}(git p*)`,
      `${shell}(git push*)`,
      `${shell}(git -C . push)`,
      `${shell}(git push)`,
      `${shell}(git push *)`,
      `${shell}(git push origin)`,
      `${shell}(git.e*)`,
      // The program word spelt another way, or a wrapper that runs git (review of #170).
      `${shell}(/*)`,
      `${shell}(./*)`,
      `${shell}( git *)`,
      `${shell}(/usr/bin/git *)`,
      `${shell}(/mingw64/bin/git -C . push)`,
      `${shell}(C:\\Git\\cmd\\git.exe *)`,
      `${shell}(\\git *)`,
      `${shell}('git' *)`,
      `${shell}("git" *)`,
      `${shell}(& git *)`,
      `${shell}(GIT_DIR=.git git *)`,
      `${shell}(env git *)`,
      `${shell}(command git *)`,
      `${shell}(xargs *)`,
      `${shell}(env git -C . push)`,
      `${shell}(env /usr/bin/git -C . push)`,
      `${shell}(env git.exe -C . push)`,
      // Subcommands that push, or run commands of their own.
      `${shell}(git send-pack *)`,
      `${shell}(git http-push *)`,
      `${shell}(git subtree *)`,
      `${shell}(git submodule *)`,
      `${shell}(git s*)`,
      // git's own programs and Windows shims (second round of the review).
      `${shell}(git-push *)`,
      `${shell}(/usr/lib/git-core/git-push origin)`,
      `${shell}(git-send-pack *)`,
      `${shell}(git-status *)`,
      `${shell}(git.cmd *)`,
      `${shell}(git.bat *)`,
      `${shell}(C:\\tools\\git.cmd -C . push)`,
      `${shell}(env git.cmd -C . push)`,
      // A backslash quotes in Bash: g\it runs git.
      ...(shell === 'Bash' ? ['Bash(g\\it *)', 'Bash(C:/Program\\ Files/Git/cmd/git.exe *)'] : []),
      // git spelt another way after a wrapper (review of #225).
      `${shell}(env g''it -C . push)`,
      ...(shell === 'Bash' ? ['Bash(env g\\it -C . push)'] : []),
      `${shell}(env /usr/bin/gi? -C . push)`,
      `${shell}(cmd /c g^it -C . push)`,
    ]) {
      it(`refuses to allow ${rule}, which reaches a push`, () => {
        assert.throws(
          () => attemptSettings({ allow: ['Read', rule], deny: [], sandbox: false }),
          /git with no fixed subcommand/,
        );
      });
    }

    // Every wrapper ADR 0062 lists, with a star: each runs `git -C . push` as its argument.
    for (const wrapper of [
      ...['env', 'command', 'exec', 'builtin', 'xargs', 'sudo', 'doas', 'nice', 'nohup', 'time'],
      ...['timeout', 'stdbuf', 'npx', 'eval', 'source', '.', 'iex', 'invoke-expression'],
      ...['start-process', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'pwsh', 'powershell'],
    ]) {
      const rule = `${shell}(${wrapper} *)`;
      it(`refuses to allow ${rule}, a wrapper that runs any command`, () => {
        assert.throws(
          () => attemptSettings({ allow: ['Read', rule], deny: [], sandbox: false }),
          /git with no fixed subcommand/,
        );
      });
    }

    for (const rule of [
      `${shell}(git status)`,
      `${shell}(git status *)`,
      `${shell}(git commit*)`,
      `${shell}(git diff:*)`,
      `${shell}(npm test)`,
      `${shell}(npm run *)`,
      // A complete subcommand that only starts like push.
      `${shell}(git pu)`,
      `${shell}(git pu *)`,
      `${shell}(./gradlew *)`,
      `${shell}(bash ./build.sh)`,
      `${shell}(npx tsc)`,
      `${shell}(git-lfs install)`,
      // In PowerShell a backslash is a path separator, not a quote.
      ...(shell === 'PowerShell' ? ['PowerShell(C:\\tools\\gradlew.bat *)'] : []),
    ]) {
      it(`allows ${rule}, which reaches none of the pushes`, () => {
        const settings = attemptSettings({ allow: [rule], deny: [], sandbox: false });
        for (const push of pushes) {
          assert.equal(withinCeiling(`${shell}(${push})`, settings.permissions.allow), false, push);
        }
      });
    }
  }
});

// #204: gh answers from the maintainer's login in the OS keyring, and a brewer runs as the same
// OS user, so no rule a brewer may have starts gh: only the engine talks to GitHub (ADR 0082).
describe('attemptSettings and gh', () => {
  const ghCalls = ['gh api user', 'gh pr merge 1', 'gh auth token'];

  for (const shell of ['Bash', 'PowerShell']) {
    for (const rule of [
      shell,
      `${shell}(*)`,
      `${shell}(g*)`,
      `${shell}(gh)`,
      `${shell}(gh *)`,
      `${shell}(gh:*)`,
      `${shell}(GH *)`,
      `${shell}( gh *)`,
      `${shell}(gh api user)`,
      `${shell}(gh pr view *)`,
      `${shell}(gh --version)`,
      `${shell}(gh.exe *)`,
      `${shell}(gh.cmd api user)`,
      `${shell}(/usr/bin/gh *)`,
      `${shell}(C:\\Tools\\gh.exe api user)`,
      `${shell}('gh' *)`,
      `${shell}(& gh *)`,
      `${shell}(GH_HOST=github.com gh *)`,
      `${shell}(env gh api user)`,
      `${shell}(command /usr/bin/gh *)`,
      `${shell}(xargs gh)`,
      `${shell}(xargs *)`,
      ...(shell === 'Bash' ? ['Bash(g\\h *)'] : []),
      // gh spelt another way after a wrapper, and git asking gh, its credential helper, for the
      // login (review of #225).
      `${shell}(env g""h auth token)`,
      `${shell}(bash -c "g"h pr merge 1)`,
      `${shell}(env $(echo gh) api user)`,
      ...(shell === 'Bash' ? ['Bash(env g\\h api user)'] : ['PowerShell(env g`h api user)']),
      `${shell}(git credential fill)`,
      `${shell}(git credential-store get)`,
      `${shell}(git c*)`,
      `${shell}(/usr/bin/git credential *)`,
      `${shell}(git-credential-manager get)`,
      // gh by path or with a Windows extension after a wrapper (second review of #225).
      `${shell}(env /usr/bin/gh api user)`,
      `${shell}(env gh.exe api user)`,
      `${shell}(xargs c:/tools/gh.cmd pr merge 1)`,
      // A glob, a brace, cmd's escapes, or a backslash a POSIX shell reads (second review of #225).
      `${shell}(env /usr/bin/g? auth token)`,
      `${shell}(env /usr/bin/g[h] api user)`,
      `${shell}(env {gh,} auth token)`,
      `${shell}(cmd /c g^h auth token)`,
      `${shell}(cmd /c g%pathext:~0,0%h api user)`,
      ...(shell === 'PowerShell' ? ['PowerShell(bash -c g\\h api user)'] : []),
    ]) {
      it(`refuses to allow ${rule}, which starts gh`, () => {
        assert.throws(
          () => attemptSettings({ allow: ['Read', rule], deny: [], sandbox: false }),
          /only the engine talks to GitHub/,
        );
      });
    }

    for (const rule of [
      `${shell}(git status *)`,
      `${shell}(npm test)`,
      `${shell}(npm run *)`,
      `${shell}(npx tsc)`,
      `${shell}(ghc --make Main)`,
      `${shell}(cat gh.txt)`,
      `${shell}(npm run gh)`,
      `${shell}(git-lfs install)`,
      // A wrapper followed by plain words (second review of #225).
      `${shell}(env NODE_ENV=test npm test)`,
      `${shell}(timeout 60 npm test)`,
    ]) {
      it(`allows ${rule}, which starts no gh`, () => {
        const settings = attemptSettings({ allow: [rule], deny: [], sandbox: false });
        for (const call of ghCalls) {
          assert.equal(withinCeiling(`${shell}(${call})`, settings.permissions.allow), false, call);
        }
      });
    }
  }
});

// A valid sandbox block; each refused row below changes one thing in it, so it is refused for
// that reason alone.
const sandboxBlock = {
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: false,
  credentials: sandboxCredentials,
};
const sandboxed = (sandbox: object) => ({
  permissions: { allow: [], deny: ['AskUserQuestion'] },
  sandbox,
});
const withoutKey = (block: object, key: string) =>
  Object.fromEntries(Object.entries(block).filter(([name]) => name !== key));

describe('writeAttemptSettings', () => {
  let dir: TempDir;
  let file: string;
  beforeEach(() => {
    dir = makeTempDir('attempt-settings');
    file = join(dir.path, 'settings.json');
  });
  afterEach(() => dir.remove());

  it('writes the settings as JSON', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: false });
    writeAttemptSettings(file, settings);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      permissions: { allow: ['Read'], deny: ['AskUserQuestion'] },
    });
  });

  // claude would drop the whole file silently, deny rules included (ADR 0042).
  for (const [what, settings, reason] of [
    ['an unknown key', { permissions: { allow: [], deny: ['AskUserQuestion'] }, model: 'x' }],
    ['a value of the wrong type', { permissions: { allow: 'Read', deny: ['AskUserQuestion'] } }],
    ['a deny list without AskUserQuestion', { permissions: { allow: ['Read'], deny: [] } }],
    [
      'a shell without its git push deny',
      { permissions: { allow: ['Bash(npm test)'], deny: ['AskUserQuestion'] } },
    ],
    [
      'git with no fixed subcommand',
      { permissions: { allow: ['Bash(git *)'], deny: ['AskUserQuestion', 'Bash(git push *)'] } },
      /git with no fixed subcommand/,
    ],
    [
      'a sandbox that may fall back to running unsandboxed',
      sandboxed({ ...sandboxBlock, failIfUnavailable: false }),
      /failIfUnavailable/,
    ],
    [
      'a sandbox that runs every sandboxed command without the allow rules',
      sandboxed(withoutKey(sandboxBlock, 'autoAllowBashIfSandboxed')),
      /autoAllowBashIfSandboxed/,
    ],
    [
      'a sandbox that leaves a credential variable set',
      sandboxed({
        ...sandboxBlock,
        credentials: {
          ...sandboxCredentials,
          envVars: sandboxCredentials.envVars.filter(({ name }) => name !== 'GH_TOKEN'),
        },
      }),
      /Must hide every credential/,
    ],
  ] as const) {
    it(`refuses ${what}, and writes nothing`, () => {
      assert.throws(
        () => writeAttemptSettings(file, settings as unknown as AttemptSettings),
        /settings/,
      );
      // A row with its own pattern is refused for that reason, not another one.
      if (reason !== undefined) {
        assert.throws(
          () => writeAttemptSettings(file, settings as unknown as AttemptSettings),
          reason,
        );
      }
      assert.equal(existsSync(file), false);
    });
  }
});
