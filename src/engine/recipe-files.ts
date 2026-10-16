// The Brewery's recipe files as the engine's Recipes (ADR 0053), the core (ADR 0021): every
// recipe and brewer file is read and checked, and either all of them load or none does.
// brewery-files.ts reads the files.

import type { Recipes } from './recipes.ts';

/** A file of the Brewery, by its path from the Brewery's root with `/`: its text, or why not. */
export type BreweryFile = { path: string } & ({ text: string } | { unreadable: string });

/** The Brewery's recipe files (`recipes/*.jsonc`) and brewer files (`brewers/*.md`). */
export interface BreweryFiles {
  recipes: readonly BreweryFile[];
  brewers: readonly BreweryFile[];
}

export type LoadedRecipes =
  | { valid: true; recipes: Recipes }
  /** One line per problem, each starting with the file it is about. */
  | { valid: false; problems: readonly string[] };

/** What doctor and a refused command say when the files are not valid. */
export const INVALID_RECIPES = "the Brewery's recipes are not valid";

/** The recipes of `files`, or every problem they have; never some of them. */
export function loadRecipes(_files: BreweryFiles): LoadedRecipes {
  throw new Error('not implemented');
}

/** The one line doctor and a refused command give for `problems`. */
export function invalidRecipes(_problems: readonly string[]): string {
  throw new Error('not implemented');
}
