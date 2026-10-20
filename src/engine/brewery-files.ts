// The Brewery's recipe files as the engine's Recipes (ADR 0053), the shell: reads
// `recipes/*.jsonc`, `brewers/*.md` and `lenses/*.md` from the Brewery's root, and the same
// folders of Foedrum's own `defaults/` (ADR 0098). recipe-files.ts decides.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type BreweryFile,
  type BreweryFiles,
  invalidRecipes,
  loadRecipes,
} from './recipe-files.ts';
import type { Recipes } from './recipes.ts';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Foedrum's own defaults: `defaults/` of the install this module is in, never of the working
 * directory, so a Brewery gets the defaults of the Foedrum that runs it.
 */
export const FOEDRUM_DEFAULTS = fileURLToPath(new URL('../../defaults', import.meta.url));

/**
 * The files ending in `extension` directly in `folder`, by name, as `<prefix>folder/<name>`.
 */
function readFolder(root: string, folder: string, extension: string, prefix = ''): BreweryFile[] {
  let names: string[];
  try {
    // A folder with the extension is listed too, so reading it fails the load.
    names = readdirSync(join(root, folder))
      .filter((name) => name.endsWith(extension))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [{ path: `${prefix}${folder}`, unreadable: messageOf(error) }];
  }
  return names.map((name) => {
    const path = `${prefix}${folder}/${name}`;
    try {
      return { path, text: readFileSync(join(root, folder, name), 'utf8') };
    } catch (error) {
      return { path, unreadable: messageOf(error) };
    }
  });
}

/** The recipe, brewer and lens files directly in their folders of `root`, by name. */
const readKinds = (root: string, prefix?: string) => ({
  recipes: readFolder(root, 'recipes', '.jsonc', prefix),
  brewers: readFolder(root, 'brewers', '.md', prefix),
  lenses: readFolder(root, 'lenses', '.md', prefix),
});

/**
 * The recipe, brewer and lens files directly in their folders, by name, and those of `defaults`
 * (Foedrum's own) by their path in `defaults/`; a missing folder has none. A file or folder that
 * cannot be read is listed with the reason, so it fails the load.
 */
export function readBreweryFiles(root: string, defaults = FOEDRUM_DEFAULTS): BreweryFiles {
  return { ...readKinds(root), defaults: readKinds(defaults, 'defaults/') };
}

/** The Brewery's recipes; throws doctor's message when its files are not valid. */
export function breweryRecipes(root: string): Recipes {
  const loaded = loadRecipes(readBreweryFiles(root));
  if (!loaded.valid) throw new Error(invalidRecipes(loaded.problems));
  return loaded.recipes;
}
