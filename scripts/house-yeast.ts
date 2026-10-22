// `node scripts/house-yeast.ts select|list|record …`: the house-yeast rules of /brew-review
// (issue #32, ADR 0122). house-yeast/core.ts decides; this file reads and writes the files.

export interface RunDeps {
  readFile: (path: string) => string;
  readDir: (dir: string) => string[];
  exists: (path: string) => boolean;
  writeFile: (path: string, text: string) => void;
  appendFile: (path: string, text: string) => void;
  out: (text: string) => void;
  err: (text: string) => void;
}

export const run = (_args: string[], _deps: RunDeps): number => {
  throw new Error('not implemented');
};
