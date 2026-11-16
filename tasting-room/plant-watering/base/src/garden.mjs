// What garden does with a list of plants: plain data in, new data out (CLAUDE.md).

import { daysBetween } from './days.mjs';

/** The plants of `plants` that need water on `today`. */
export function due(plants, today) {
  return plants.filter((plant) => daysBetween(plant.lastWatered, today) >= plant.everyDays);
}
