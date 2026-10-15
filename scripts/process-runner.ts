// The process runner the scripts' shells inject (ADR 0021): it starts a program without a shell
// and collects its exit code and output. Unit tests pass a fake runner instead.

import { spawn } from 'node:child_process';
import type { RunProcess } from '../src/platform/processes.ts';

export type { ProcessOutcome, RunOptions, RunProcess } from '../src/platform/processes.ts';

export const spawnProcess: RunProcess = (file, args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: string): void => {
      output += chunk;
    };
    // Decode as a stream, so a multi-byte character split across chunks stays intact.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => resolve({ exitCode: null, output: error.message }));
    child.on('close', (code) => resolve({ exitCode: code, output }));
  });
