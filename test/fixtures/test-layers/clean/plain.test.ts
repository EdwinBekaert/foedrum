// Starts no process: the runner is injected, so child_process is never imported here.
import { readFileSync } from 'node:fs';

export const note = 'mentions child_process in a string, which is not an import';
export const read = (path: string): string => readFileSync(path, 'utf8');
