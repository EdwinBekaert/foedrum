import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptSettings, writeAttemptSettings } from '../../src/brewers/attempt-settings.ts';
import type { AttemptSettings } from '../../src/schemas/attempt-settings.ts';
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
    assert.deepEqual(settings.sandbox, {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
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
      // Subcommands that push, or run commands of their own.
      `${shell}(git send-pack *)`,
      `${shell}(git http-push *)`,
      `${shell}(git subtree *)`,
      `${shell}(git submodule *)`,
      `${shell}(git s*)`,
    ]) {
      it(`refuses to allow ${rule}, which reaches a push`, () => {
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
      `${shell}(./gradlew *)`,
      `${shell}(bash ./build.sh)`,
      `${shell}(npx tsc)`,
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
  for (const [what, settings] of [
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
    ],
    [
      'a sandbox that may fall back to running unsandboxed',
      {
        permissions: { allow: [], deny: ['AskUserQuestion'] },
        sandbox: { enabled: true, failIfUnavailable: false, allowUnsandboxedCommands: false },
      },
    ],
  ] as const) {
    it(`refuses ${what}, and writes nothing`, () => {
      assert.throws(
        () => writeAttemptSettings(file, settings as unknown as AttemptSettings),
        /settings/,
      );
      assert.equal(existsSync(file), false);
    });
  }
});
