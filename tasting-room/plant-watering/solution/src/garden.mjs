// What garden does with a list of plants: plain data in, new data out (CLAUDE.md).

import { daysBetween } from './days.mjs';

/** The plants of `plants` that need water on `today`. */
export function due(plants, today) {
  return plants.filter((plant) => daysBetween(plant.lastWatered, today) >= plant.everyDays);
}

/** A new list of `plants`, the plant `name` watered on `day`; `plants` stays as it was. */
export function water(plants, name, day) {
  return plants.map((plant) => (plant.name === name ? { ...plant, lastWatered: day } : plant));
}
