// Where the local gate's personal denylist is and whether it can be read (ADR 0114), with the
// environment, the home directory and the file read injected: no test reads the real list.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { denylistPath, readDenylist } from '../../src/platform/denylist.ts';

const home = join('/', 'home', 'ada');
const fallback = join(home, '.config', 'foedrum', 'denylist.txt');
const named = join('/', 'lists', 'mine.txt');

const notFound = (path: string): Error =>
  Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });

// A file read that answers from `files` and records each path it was asked for.
const reader = (files: Record<string, string | Error>) => {
  const asked: string[] = [];
  const readFile = (path: string): string => {
    asked.push(path);
    const file = files[path] ?? notFound(path);
    if (file instanceof Error) throw file;
    return file;
  };
  return { asked, readFile };
};

describe('denylistPath', () => {
  it('is the file FOEDRUM_DENYLIST names', () => {
    assert.equal(denylistPath({ FOEDRUM_DENYLIST: named }, home), named);
  });

  it('is ~/.config/foedrum/denylist.txt without it, or when it is empty', () => {
    assert.equal(denylistPath({}, home), fallback);
    assert.equal(denylistPath({ FOEDRUM_DENYLIST: '' }, home), fallback);
  });
});

describe('readDenylist', () => {
  it('is set, with its text, when the file is there', () => {
    const { asked, readFile } = reader({ [fallback]: 'examplecorp\n' });
    assert.deepEqual(readDenylist({}, home, readFile), {
      kind: 'set',
      path: fallback,
      text: 'examplecorp\n',
    });
    assert.deepEqual(asked, [fallback]);
  });

  it('reads only the file FOEDRUM_DENYLIST names when it is set', () => {
    const { asked, readFile } = reader({ [named]: 'acmewidget', [fallback]: 'examplecorp' });
    assert.deepEqual(readDenylist({ FOEDRUM_DENYLIST: named }, home, readFile), {
      kind: 'set',
      path: named,
      text: 'acmewidget',
    });
    assert.deepEqual(asked, [named]);
  });

  it('is none when the default file is missing', () => {
    const { readFile } = reader({});
    assert.deepEqual(readDenylist({}, home, readFile), { kind: 'none', path: fallback });
  });

  it('is unreadable when the file FOEDRUM_DENYLIST names is missing', () => {
    const { readFile } = reader({});
    const state = readDenylist({ FOEDRUM_DENYLIST: named }, home, readFile);
    assert.equal(state.kind, 'unreadable');
    assert.equal(state.path, named);
    assert.match(state.kind === 'unreadable' ? state.why : '', /ENOENT/);
  });

  it('is unreadable when the default file is there but cannot be read', () => {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const { readFile } = reader({ [fallback]: denied });
    assert.deepEqual(readDenylist({}, home, readFile), {
      kind: 'unreadable',
      path: fallback,
      why: 'EACCES: permission denied',
    });
  });
});
