// What parcel reads from the counter: typed text in, plain data out.

import { InputError } from './errors.mjs';

/** The postcode of `text`, four digits. */
export function parsePostcode(text) {
  if (!/^\d{4}$/.test(text)) throw new InputError(`${text} is not a postcode of four digits`);
  return text;
}
