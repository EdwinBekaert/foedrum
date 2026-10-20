// One life of npm run demo's Cellar (ADR 0097): `foedrum serve`'s own runServe on the demo
// Brewery, on serveShell's machine with three seams of its own: the scripted brewer for claude, the
// in-process code host for gh, and a wait that ends the life once the batch is on tap, or at once
// when it is Stuck or cancelled. To read the store, the wait has openStore keep it, and to end the
// life, a signal of its own beside serve's; ticks come every 100 ms. serve's own pushes and fetches
// reach the scratch remote: scripts/demo.ts starts this process with a git configuration of the
// demo's own, whose insteadOf sends the target's GitHub URL there. In the life that crashes, the
// process is killed with SIGKILL once the brewer has committed: no finally block runs, and the
// lock, the lease and the attempt's worktree are left as a crash leaves them. scripts/demo.ts
// starts it: `node scripts/demo/cellar.ts <scratch> crash|finish`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServeShell } from '../../src/cli/serve.ts';
import { runServe } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { listenWhileServing, serveShell } from '../../src/cli/serve-shell.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { runGit } from '../../src/workspace/git.ts';
import { scriptedBrewer } from './brewer.ts';
import { codeHost, fileJournal } from './code-host.ts';
import { CRASH_LINE, DIAGNOSIS, lifeEndOf, ON_TAP_LINE } from './core.ts';

/** How often the Cellar ticks: serve's 5 s would make the demo wait for nothing. */
const INTERVAL_MS = 100;

const [scratch, life] = process.argv.slice(2);
if (scratch === undefined || (life !== 'crash' && life !== 'finish')) {
  process.stderr.write('usage: node scripts/demo/cellar.ts <scratch> crash|finish\n');
  process.exit(2);
}
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const root = join(scratch, 'brewery');
const readIfThere = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined;
const ready = serveSetup({
  root,
  home: join(scratch, 'home'),
  platform: process.platform,
  env: process.env,
  files: {
    config: readIfThere(join(root, 'foedrum.jsonc')),
    local: readIfThere(join(root, '.foedrum', 'local.jsonc')),
    models: readIfThere(join(root, 'models.jsonc')),
    brewery: readBreweryFiles(root),
  },
  diagnosis: DIAGNOSIS,
});
if (ready.kind === 'refused') {
  for (const problem of ready.problems) out(`demo: ${problem}`);
  process.exit(1);
}
const { setup } = ready;
const host = await codeHost(fileJournal(join(scratch, 'code-host.jsonl')));

// The line goes out before the kill: the demo reads it to know the crash came mid-attempt.
const crash = (): void => {
  process.stdout.write(`${CRASH_LINE}\n`, () => process.kill(process.pid, 'SIGKILL'));
};

let store: EventStore | undefined;

const listening = listenWhileServing(process);
const ended = new AbortController();
let failed = false;
const machine = serveShell(setup, { root, git: runGit, out, listen: listening.listen });
const shell: ServeShell = {
  ...machine,
  signal: AbortSignal.any([machine.signal, ended.signal]),
  intervalMs: INTERVAL_MS,
  openStore: (path) => {
    store = machine.openStore(path);
    return store;
  },
  // Between ticks: the life ends once the batch is on tap, or at once when it cannot get there.
  wait: async (ms, signal) => {
    const end = lifeEndOf(store?.eventsAfter(0) ?? []);
    if (end === undefined) return machine.wait(ms, signal);
    switch (end.kind) {
      case 'on_tap':
        out(`${ON_TAP_LINE}: ${end.pullRequests.join(', ')}`);
        break;
      case 'stuck':
        out(`demo: batch 1-1 is Stuck: ${end.reason}`);
        failed = true;
        break;
      case 'cancelled':
        out('demo: batch 1-1 was cancelled');
        failed = true;
        break;
      default:
        end satisfies never;
    }
    ended.abort();
  },
  runner: (_claude, plan) =>
    scriptedBrewer({
      plan,
      git: runGit,
      write: (path, text) => writeFileSync(path, text),
      life,
      crash,
    }),
  gh: host.exec,
};
try {
  const code = await runServe(setup, shell);
  process.exitCode = failed ? 1 : code;
} finally {
  listening.stop();
}
