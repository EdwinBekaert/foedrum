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
});

describe('errorCode', () => {
  it('reads no code from a thrown value that carries none', () => {
    assert.equal(errorCode(thrown(new Error('no code here'))), undefined);
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
});
