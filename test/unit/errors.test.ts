import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { errorCode, messageOf, sqliteErrorCode } from '../../src/platform/errors.ts';

const thrown = (value: unknown): unknown => {
  try {
    throw value;
  } catch (error) {
    return error;
  }
};

describe('messageOf', () => {
  it('reads a thrown string as the string itself', () => {
    assert.equal(messageOf(thrown('the disk is full')), 'the disk is full');
  });

  it('reads a thrown Error as its message alone', () => {
    assert.equal(messageOf(thrown(new Error('the disk is full'))), 'the disk is full');
  });

  it('reads an Error whose message is not a string as one that says nothing', () => {
    assert.equal(messageOf(thrown(Object.assign(new Error(), { message: 42 }))), '');
  });
});

describe('errorCode', () => {
  it('reads no code from a thrown value that carries none', () => {
    assert.equal(errorCode(thrown(new Error('no code here'))), undefined);
  });

  it('reads the code a thrown Error carries', () => {
    const error = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    assert.equal(errorCode(thrown(error)), 'ENOENT');
  });

  it('reads no code from an Error whose code is not a string', () => {
    assert.equal(errorCode(thrown(Object.assign(new Error('odd'), { code: 42 }))), undefined);
  });

  it('reads no code from a thrown value that is no Error, even one with a code', () => {
    assert.equal(errorCode(thrown({ code: 'ENOENT' })), undefined);
  });
});

describe('sqliteErrorCode', () => {
  it('reads the SQLite result code a node:sqlite error carries in errcode', () => {
    const error = Object.assign(new Error('UNIQUE constraint failed'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 2067,
    });
    assert.equal(sqliteErrorCode(thrown(error)), 2067);
  });

  it('reads no SQLite result code from an error without errcode', () => {
    const error = Object.assign(new Error('not SQLite'), { code: 'ERR_SQLITE_ERROR' });
    assert.equal(sqliteErrorCode(thrown(error)), undefined);
  });

  it('reads no SQLite result code from an errcode that is not a number', () => {
    const error = Object.assign(new Error('odd'), { errcode: '2067' });
    assert.equal(sqliteErrorCode(thrown(error)), undefined);
  });

  it('reads no SQLite result code from a thrown value that is no Error, even one with errcode', () => {
    assert.equal(sqliteErrorCode(thrown({ errcode: 2067 })), undefined);
  });
});
