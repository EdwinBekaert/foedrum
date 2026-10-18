// A process tree for test/integration/processes.test.ts: `node tree.ts <pid-file> <depth>` adds
// its pid to the file, starts itself with depth - 1 until depth is 0, and then runs until it is
// killed. Every level shares the same stdout and stderr, so a surviving grandchild holds the
// pipes the runner reads open.
//
// With `exit-parent` as a third argument, the top level exits as soon as every level below it has
// written its pid, and the levels below end by themselves after 30 s: the orphans of #92, which
// never outlive the test even when the runner's kill misses them. An orphan that ends by itself
// first adds its pid to `<pid-file>.ended`, so a test can tell that end from a kill (#212).

import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const [pidFile = '', depth = '0', mode = ''] = process.argv.slice(2);
appendFileSync(pidFile, `${process.pid}\n`);
process.stdout.write(`level ${depth} started\n`);
if (Number(depth) > 0) {
  const below = mode === 'exit-parent' ? 'orphan' : mode;
  spawn(process.execPath, [import.meta.filename, pidFile, String(Number(depth) - 1), below], {
    stdio: 'inherit',
    // On Windows node holds the children it starts in a kill-on-close Job Object, so they die
    // with it; a parent such as cmd.exe does not. Detached, they outlive their parent as those
    // do. Elsewhere detaching would leave the process group, which is another case.
    detached: mode !== '' && process.platform === 'win32',
    // Without a console window of its own, which a detached child gets on Windows.
    windowsHide: true,
  });
}
if (mode === 'exit-parent') {
  const levels = Number(depth) + 1;
  setInterval(() => {
    const pids = readFileSync(pidFile, 'utf8').split('\n').filter(Boolean);
    if (pids.length >= levels) process.exit(0);
  }, 50);
} else if (mode === 'orphan') {
  setTimeout(() => {
    appendFileSync(`${pidFile}.ended`, `${process.pid}\n`);
    process.exit(0);
  }, 30_000);
} else {
  setInterval(() => {}, 1000);
}
