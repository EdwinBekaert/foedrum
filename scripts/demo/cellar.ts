// One life of npm run demo's Cellar (ADR 0097): `foedrum serve`'s own runServe on the demo
// Brewery, on serveShell's machine with four seams of its own: the scripted brewer for claude, the
// in-process code host for gh, the base fetched from the local remote instead of GitHub, and a stop
// once the batch is on tap. In the life that crashes, the process is killed with SIGKILL once the
// brewer has committed: no finally block runs, and the lock, the lease and the attempt's worktree
// are left as a crash leaves them. scripts/demo.ts starts it:
// `node scripts/demo/cellar.ts <scratch> crash|finish`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServeShell } from '../../src/cli/serve.ts';
import { runServe } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { listenWhileServing, serveShell } from '../../src/cli/serve-shell.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { baseFetchRoot } from '../../src/workspace/attempt-worktrees.ts';
import { worktreeClonePath } from '../../src/workspace/attempt-worktrees-git.ts';
import { openBranchPush } from '../../src/workspace/branch-push-git.ts';
import { runGit } from '../../src/workspace/git.ts';
import { scriptedBrewer } from './brewer.ts';
import { codeHost, fileJournal } from './code-host.ts';
import { CRASH_LINE, DIAGNOSIS, ON_TAP_LINE } from './core.ts';

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
/**
 * The pull requests of the batch on tap, once it is and its status comment says so: the revision
 * that shows it ended is due at once (ADR 0072), and applied after the batch went on tap.
 */
const onTap = (): readonly string[] | undefined => {
  let pullRequests: readonly string[] | undefined;
  for (const { event } of store?.eventsAfter(0) ?? []) {
    if (event.type === 'batch.on_tap') pullRequests = event.pullRequests;
    const { effect } = event.type === 'effect.applied' ? effectKey.decode(event.key) : {};
    if (pullRequests !== undefined && effect?.startsWith('status.') === true) return pullRequests;
  }
  return undefined;
};

const listening = listenWhileServing(process);
const tapped = new AbortController();
const machine = serveShell(setup, { root, git: runGit, out, listen: listening.listen });
const shell: ServeShell = {
  ...machine,
  signal: AbortSignal.any([machine.signal, tapped.signal]),
  intervalMs: INTERVAL_MS,
  openStore: (path) => {
    store = machine.openStore(path);
    return store;
  },
  wait: async (ms, signal) => {
    const pullRequests = onTap();
    if (pullRequests === undefined) return machine.wait(ms, signal);
    out(`${ON_TAP_LINE}: ${pullRequests.join(', ')}`);
    tapped.abort();
  },
  // The base comes from the target's remote in the scratch folder, where serve would ask GitHub.
  push: (repository) =>
    openBranchPush({
      git: runGit,
      clone: worktreeClonePath(setup.workRoot, repository),
      base: { url: join(scratch, 'web.git'), root: baseFetchRoot(setup.workRoot, repository.repo) },
    }),
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
  process.exitCode = await runServe(setup, shell);
} finally {
  listening.stop();
}
