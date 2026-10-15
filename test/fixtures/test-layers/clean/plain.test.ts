// Starts no process: the runner is injected, so child_process is never imported here.
import { readFileSync } from 'node:fs';

export const note = 'mentions child_process in a string, which is not an import';
// The module named as a quoted string, as in 'node:child_process', is not an import either.
export const moduleName = 'node:child_process';
export const bareName = "child_process";
export const read = (path: string): string => readFileSync(path, 'utf8');
