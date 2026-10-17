// A recipe file as a batch uses it (ADR 0017): settings the schema leaves unset are decided here,
// from the brewers the recipe uses, so an unset testFirst never reaches the engine as off.

import type { BrewerFrontmatter } from '../schemas/brewer.ts';
import { type Recipe as RecipeFile, stepBrewerName, walk } from '../schemas/recipe.ts';

export type ResolvedRecipe = RecipeFile & { testFirst: boolean };

/** The Brewery's brewers by name, or `undefined` for a name it has none of. */
export type Brewers = (name: string) => Pick<BrewerFrontmatter, 'produces'> | undefined;

/**
 * `testFirst` as the recipe says, else `true` when any of its brewers produces commits. Throws
 * when the recipe names a brewer the Brewery does not have.
 */
export function resolveRecipe(recipe: RecipeFile, brewers: Brewers): ResolvedRecipe {
  // Every brewer is looked up before any is judged, so a missing one is refused wherever it is.
  const used = [...walk(recipe.steps, ['steps'])].flatMap(({ step }) => {
    const name = stepBrewerName(step);
    if (name === undefined) return [];
    const brewer = brewers(name);
    if (brewer === undefined) {
      throw new Error(`Recipe ${recipe.name} names no brewer "${name}" the Brewery has`);
    }
    return [brewer];
  });
  const writes = used.some((brewer) => brewer.produces === 'commits');
  return { ...recipe, testFirst: recipe.testFirst ?? writes };
}
