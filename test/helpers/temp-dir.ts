import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Test directories live in the checkout, never in the system temp directory (CLAUDE.md).
const tmp = join(import.meta.dirname, '..', '..', '.foedrum', 'tmp');

export interface TempDir {
  path: string;
  remove: () => void;
}

// group is the folder under .foedrum/tmp/: `tests` by default, or an issue number.
export const makeTempDir = (prefix: string, group = 'tests'): TempDir => {
  const base = join(tmp, group);
  mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, `${prefix}-`));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
};
