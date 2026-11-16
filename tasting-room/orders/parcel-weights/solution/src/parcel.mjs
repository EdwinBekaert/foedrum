// What parcel reads from the counter: typed text in, plain data out.

import { InputError } from './errors.mjs';

const GRAMS = { kg: 1000, g: 1 };

/** The postcode of `text`, four digits. */
export function parsePostcode(text) {
  if (!/^\d{4}$/.test(text)) throw new InputError(`${text} is not a postcode of four digits`);
  return text;
}

/** The grams of `text`, a weight as a number and `kg` or `g`, such as `2.5kg` or `800g`. */
export function parseWeight(text) {
  const match = /^(\d+(?:\.\d+)?)(kg|g)$/.exec(text);
  if (match === null) throw new InputError(`${text} is not a weight such as 2.5kg or 800g`);
  return Number(match[1]) * GRAMS[match[2]];
}
