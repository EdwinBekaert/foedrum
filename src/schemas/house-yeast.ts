// House-yeast rule frontmatter: one learned rule per file (ADR 0018).

import { z } from './zod.ts';

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export const HouseYeastRule = z.unknown().transform(notImplemented);
