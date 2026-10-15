// A recipe file as a batch uses it (ADR 0017): settings the schema leaves unset are decided here,
// from the brewers the recipe uses, so an unset testFirst never reaches the engine as off.

import type { BrewerFrontmatter } from '../schemas/brewer.ts';
import type { Recipe as RecipeFile } from '../schemas/recipe.ts';

export type ResolvedRecipe = RecipeFile & { testFirst: boolean };

/** The Brewery's brewers by name, or `undefined` for a name it has none of. */
export type Brewers = (name: string) => Pick<BrewerFrontmatter, 'produces'> | undefined;

/**
 * `testFirst` as the recipe says, else `true` when any of its brewers produces commits. Throws
 * when the recipe names a brewer the Brewery does not have.
 */
export function resolveRecipe(_recipe: RecipeFile, _brewers: Brewers): ResolvedRecipe {
  throw new Error('not implemented');
}
