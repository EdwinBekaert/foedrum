// models.jsonc: model aliases and per-brewer overrides (brewers-and-recipes §5).

import { z } from './zod.ts';

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export const ModelsConfig = z.unknown().transform(notImplemented);
