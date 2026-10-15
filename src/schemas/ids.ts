// Ids that become path segments on the state branch: batch and step ids (ADR 0024).

import { z } from './zod.ts';

export const PathSafeId = z.string().transform((): string => {
  throw new Error('not implemented');
});
