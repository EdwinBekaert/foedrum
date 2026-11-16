import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contactOf, splitLine } from '../src/contacts.mjs';

test("makes a contact of a line's name, phone and city", () => {
  assert.deepEqual(contactOf(['Jo Lee', '0470 12 34 56', 'Ghent']), {
    name: 'Jo Lee',
    phone: '0470 12 34 56',
    city: 'Ghent',
  });
});

test('leaves a field the line does not have empty', () => {
  assert.deepEqual(contactOf(['Jo Lee']), { name: 'Jo Lee', phone: '', city: '' });
});

test("splits a line into its fields, a quoted field's commas kept", () => {
  assert.deepEqual(splitLine('Jo Lee,,Ghent'), ['Jo Lee', '', 'Ghent']);
  assert.deepEqual(splitLine('"Lee, Jo",0470 12 34 56,Ghent'), [
    'Lee, Jo',
    '0470 12 34 56',
    'Ghent',
  ]);
});
