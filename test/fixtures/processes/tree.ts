// A process tree for test/integration/processes.test.ts: `node tree.ts <pid-file> <depth>` adds
// its pid to the file, starts itself with depth - 1 until depth is 0, and then runs until it is
// killed. Every level shares the same stdout and stderr, so a surviving grandchild holds the
// pipes the runner reads open.

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const [pidFile = '', depth = '0'] = process.argv.slice(2);
appendFileSync(pidFile, `${process.pid}\n`);
process.stdout.write(`level ${depth} started\n`);
if (Number(depth) > 0) {
  spawn(process.execPath, [import.meta.filename, pidFile, String(Number(depth) - 1)], {
    stdio: 'inherit',
  });
}
setInterval(() => {}, 1000);
