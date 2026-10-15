import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pathInside, samePath } from '../../src/platform/paths.ts';

describe('samePath', () => {
  it('ignores case and separators on Windows', () => {
    assert.equal(samePath('C:/Code/Foedrum', 'c:\\code\\foedrum\\', 'win32'), true);
    assert.equal(samePath('C:/code/foedrum', 'C:/code/foedrum-2', 'win32'), false);
  });

  it('ignores case on macOS', () => {
    assert.equal(samePath('/Users/a/Code', '/users/a/code/', 'darwin'), true);
  });

  it('respects case on Linux', () => {
    assert.equal(samePath('/home/a/code', '/home/a/code/', 'linux'), true);
    assert.equal(samePath('/home/a/Code', '/home/a/code', 'linux'), false);
  });

  it('resolves . and .. segments', () => {
    assert.equal(samePath('/home/a/code/../code/./x', '/home/a/code/x', 'linux'), true);
  });
});

describe('pathInside', () => {
  it('returns the relative path of a path inside the parent', () => {
    assert.equal(pathInside('C:/Code/repo', 'c:\\code\\repo\\.claude\\x', 'win32'), '.claude/x');
    assert.equal(pathInside('/home/a/repo', '/home/a/repo/.claude/x', 'linux'), '.claude/x');
  });

  it('returns undefined for the parent itself, a sibling or a path outside', () => {
    assert.equal(pathInside('/home/a/repo', '/home/a/repo', 'linux'), undefined);
    assert.equal(pathInside('/home/a/repo', '/home/a/repo-2/x', 'linux'), undefined);
    assert.equal(pathInside('/home/a/repo', '/home/a', 'linux'), undefined);
    assert.equal(pathInside('/home/a/Repo', '/home/a/repo/x', 'linux'), undefined);
  });
});
