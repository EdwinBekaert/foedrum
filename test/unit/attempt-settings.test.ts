import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { attemptSettings, writeAttemptSettings } from '../../src/brewers/attempt-settings.ts';
import type { AttemptSettings } from '../../src/schemas/attempt-settings.ts';
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
      allow: ['Read', 'Bash'],
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
