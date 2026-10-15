// Stands in for npm's CLI (npm_execpath) in the precheck and deps:sync tests. It echoes its
// arguments and working directory, writes "é" split across two writes so that decoding chunk by
// chunk would corrupt it, and exits 3.

import { setTimeout as sleep } from 'node:timers/promises';

process.stderr.write(`stub npm: ${process.argv.slice(2).join(' ')}\n`);
process.stderr.write(`stub npm cwd: ${process.cwd()}\n`);
const accented = Buffer.from('café', 'utf8');
process.stderr.write(accented.subarray(0, accented.length - 1));
await sleep(100);
process.stderr.write(accented.subarray(accented.length - 1));
process.stderr.write('\n');
process.exitCode = 3;
