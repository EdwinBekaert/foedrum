import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daysBetween } from '../src/days.mjs';
import { due } from '../src/garden.mjs';

const PLANTS = [
  { name: 'basil', everyDays: 1, lastWatered: '2026-05-03' },
  { name: 'fern', everyDays: 3, lastWatered: '2026-05-02' },
  { name: 'cactus', everyDays: 14, lastWatered: '2026-04-25' },
];

test('counts the days between two dates', () => {
  assert.deepEqual(
    [daysBetween('2026-05-01', '2026-05-04'), daysBetween('2026-02-28', '2026-03-01')],
    [3, 1],
  );
});

test('lists the plants that need water today', () => {
  assert.deepEqual(
    due(PLANTS, '2026-05-04').map((plant) => plant.name),
    ['basil'],
  );
  assert.deepEqual(
    due(PLANTS, '2026-05-09').map((plant) => plant.name),
    ['basil', 'fern', 'cactus'],
  );
});
