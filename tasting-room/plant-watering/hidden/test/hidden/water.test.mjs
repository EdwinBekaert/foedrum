import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as garden from '../../src/garden.mjs';

const plants = () => [
  { name: 'basil', everyDays: 1, lastWatered: '2026-05-03' },
  { name: 'fern', everyDays: 3, lastWatered: '2026-05-02' },
];

test('the plant watered has the day it was watered', () => {
  const watered = garden.water(plants(), 'fern', '2026-05-04');
  assert.equal(watered.find((plant) => plant.name === 'fern')?.lastWatered, '2026-05-04');
});

test('the other plants are as they were', () => {
  const watered = garden.water(plants(), 'fern', '2026-05-04');
  assert.deepEqual(
    watered.find((plant) => plant.name === 'basil'),
    plants()[0],
  );
});

test('the list given and its plants are not changed', () => {
  const given = plants();
  garden.water(given, 'fern', '2026-05-04');
  assert.deepEqual(given, plants());
});
