// foedrum.jsonc: the Brewery's repositories and permission ceiling (architecture §14, ADR 0023).

import { z } from './zod.ts';

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export const BreweryConfig = z.unknown().transform(notImplemented);
