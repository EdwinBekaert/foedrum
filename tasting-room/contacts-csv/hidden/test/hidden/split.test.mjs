import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as contacts from '../../src/contacts.mjs';

test("splits a line at its commas, an empty field as ''", () => {
  assert.deepEqual(contacts.splitLine('Ann Vos,,Bruges'), ['Ann Vos', '', 'Bruges']);
});

test('a field between double quotes keeps its comma and loses its quotes', () => {
  assert.deepEqual(contacts.splitLine('"Smith, Jo",0470 98 76 54,Ghent'), [
    'Smith, Jo',
    '0470 98 76 54',
    'Ghent',
  ]);
});
