// The Brewery's recipe files as the engine's Recipes (ADR 0053), the shell: reads
// `recipes/*.jsonc` and `brewers/*.md` from the Brewery's root. recipe-files.ts decides.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BreweryFile,
  type BreweryFiles,
  invalidRecipes,
  loadRecipes,
} from './recipe-files.ts';
import type { Recipes } from './recipes.ts';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The files ending in `extension` directly in `folder`, by name, as `folder/<name>`. */
function readFolder(root: string, folder: string, extension: string): BreweryFile[] {
  let names: string[];
  try {
    // A folder with the extension is listed too, so reading it fails the load.
    names = readdirSync(join(root, folder))
      .filter((name) => name.endsWith(extension))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [{ path: folder, unreadable: messageOf(error) }];
  }
  return names.map((name) => {
    const path = `${folder}/${name}`;
    try {
      return { path, text: readFileSync(join(root, folder, name), 'utf8') };
    } catch (error) {
      return { path, unreadable: messageOf(error) };
    }
  });
}

/**
 * The recipe and brewer files directly in their folders, by name; a missing folder has none. A
 * file or folder that cannot be read is listed with the reason, so it fails the load.
 */
export function readBreweryFiles(root: string, _defaults?: string): BreweryFiles {
  return {
    recipes: readFolder(root, 'recipes', '.jsonc'),
    brewers: readFolder(root, 'brewers', '.md'),
  };
}

/** The Brewery's recipes; throws doctor's message when its files are not valid. */
export function breweryRecipes(root: string): Recipes {
  const loaded = loadRecipes(readBreweryFiles(root));
  if (!loaded.valid) throw new Error(invalidRecipes(loaded.problems));
  return loaded.recipes;
}
