// One life of npm run demo -- ladder's Cellar (ADR 0294): `foedrum serve`'s own runServe on the
// ladder's Brewery, on serveShell's machine with the seams of scripts/demo/cellar.ts: the ladder's
// scripted brewers for claude, the in-process code host for gh, and a wait that ends the life on a
// condition read from its store (`ladderLifeEnd`), on the first tick after it with no new event, so
// the effects of the last change are applied first. scripts/demo/ladder.ts starts it, through
// scripts/demo.ts: `node scripts/demo/ladder-cellar.ts <scratch> plan|lib|web|close`. It shows
// `foedrum status` whenever the store has changed, and the release input an attempt was told.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cliFromCheckout } from '../../src/cli/cli-main.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import { runServe } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { listenWhileServing, serveShell } from '../../src/cli/serve-shell.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import type { EventStore } from '../../src/engine/event-store.ts';
import { messageOf } from '../../src/platform/errors.ts';
import { runGit } from '../../src/workspace/git.ts';
import { codeHost, fileJournal } from './code-host.ts';
import { DIAGNOSIS } from './core.ts';
import { LADDER_HOST, type LadderLife, ladderLifeEnd, ladderTick, TOLD_LINE } from './ladder.ts';
import { ladderBrewers, releaseLines } from './ladder-brewers.ts';
import { STATUS_LINE } from './walkthrough.ts';

/** How often the Cellar ticks: serve's 5 s would make the demo wait for nothing. */
const INTERVAL_MS = 100;

const LIVES: readonly LadderLife[] = ['plan', 'lib', 'web', 'close'];
const [scratch, asked] = process.argv.slice(2);
const life = LIVES.find((each) => each === asked);
if (scratch === undefined || life === undefined) {
  process.stderr.write(`usage: node scripts/demo/ladder-cellar.ts <scratch> ${LIVES.join('|')}\n`);
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
const host = await codeHost(fileJournal(join(scratch, 'code-host.jsonl')), LADDER_HOST);

let store: EventStore | undefined;

// `foedrum status` as the CLI runs it in the Brewery, shown when it says something new.
let shown = '';
const showStatus = async (): Promise<void> => {
  const { stdout, stderr } = await cliFromCheckout(['status'], root);
  const text = `${stdout}${stderr}`.trimEnd();
  if (text === shown) return;
  shown = text;
  out(STATUS_LINE);
  for (const line of text.split('\n')) out(line === '' ? '' : `  ${line}`);
};
let seen = -1;

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
  // Between ticks: the life ends on its condition, once a tick added no event after it.
  wait: async (ms, signal) => {
    const events = store?.eventsAfter(0) ?? [];
    const quiet = events.length === seen;
    seen = events.length;
    if (!quiet) await showStatus();
    const end = ladderLifeEnd(life, events);
    if (ladderTick(end, quiet) === 'wait') return machine.wait(ms, signal);
    out(end.line);
    failed = end.kind === 'failed';
    ended.abort();
  },
  runner: (_claude, plan) =>
    ladderBrewers({
      plan,
      git: runGit,
      read: readIfThere,
      write: (path, text) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      },
      brewed: (ref, prompt) => {
        const told = releaseLines(prompt);
        if (told.length === 0) return;
        out(`${TOLD_LINE} batch ${ref.batchId} is told the release it waited for, as {release}:`);
        for (const line of told) out(line === '' ? '' : `  ${line}`);
      },
    }),
  gh: host.exec,
};
try {
  const code = await runServe(setup, shell);
  process.exitCode = failed ? 1 : code;
} catch (error) {
  out(`demo: the Cellar failed: ${messageOf(error)}`);
  process.exitCode = 1;
} finally {
  listening.stop();
}
