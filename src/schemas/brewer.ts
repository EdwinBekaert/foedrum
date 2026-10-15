// Brewer frontmatter: a reusable agent role (brewers-and-recipes §1).

import { z } from './zod.ts';

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export const BrewerFrontmatter = z.unknown().transform(notImplemented);
