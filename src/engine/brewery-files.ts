// The Brewery's recipe files as the engine's Recipes (ADR 0053), the shell: reads
// `recipes/*.jsonc` and `brewers/*.md` from the Brewery's root. recipe-files.ts decides.

import type { BreweryFiles } from './recipe-files.ts';
import type { Recipes } from './recipes.ts';

/**
 * The recipe and brewer files directly in their folders, by name; a missing folder has none. A
 * file or folder that cannot be read is listed with the reason, so it fails the load.
 */
export function readBreweryFiles(_root: string): BreweryFiles {
  throw new Error('not implemented');
}

/** The Brewery's recipes; throws doctor's message when its files are not valid. */
export function breweryRecipes(_root: string): Recipes {
  throw new Error('not implemented');
}
