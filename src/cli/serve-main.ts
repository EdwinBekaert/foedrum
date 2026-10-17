// `foedrum serve` on the real machine (ADR 0063): reads the Brewery's files in the working
// directory, asks doctor for claude and the isolation level, and runs the Cellar (serve.ts) with
// the real lock, store, state branch, git, worktrees and claude runner until Ctrl+C. Only main.ts
// loads it; test/integration/serve.test.ts runs it as the real program.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeBrewerRunner } from '../brewers/claude-runner.ts';
import { readBreweryFiles } from '../engine/brewery-files.ts';
import { lockDriver } from '../engine/driver-lock.ts';
import { openSqliteEventStore } from '../engine/sqlite-event-store.ts';
import { openStateBranch } from '../engine/state-branch-git.ts';
import { resolveExecutable } from '../platform/executables.ts';
import { execProcess } from '../platform/processes.ts';
import { ensureManagedClone, openAttemptWorktrees } from '../workspace/attempt-worktrees-git.ts';
import { runGit } from '../workspace/git.ts';
import { diagnose } from './doctor.ts';
import { gatherDoctorFacts } from './doctor-facts.ts';
import { type CliResult, printable } from './run.ts';
import { runServe } from './serve.ts';
import { serveSetup } from './serve-config.ts';

const readIfThere = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined;

/** Runs the Cellar in the Brewery checkout `cwd` until Ctrl+C. */
export const serveFromCheckout = async (cwd: string): Promise<CliResult> => {
  // Doctor's tools and isolation only: serve reads and checks the Brewery's files itself.
  const facts = await gatherDoctorFacts({
    exec: execProcess,
    resolve: resolveExecutable,
    platform: process.platform,
    kernelRelease: release(),
    node: process.versions.node,
    execPath: process.execPath,
    cwd,
  });
  const ready = serveSetup({
    root: cwd,
    home: homedir(),
    platform: process.platform,
    env: process.env,
    files: {
      config: readIfThere(join(cwd, 'foedrum.jsonc')),
      local: readIfThere(join(cwd, '.foedrum', 'local.jsonc')),
      models: readIfThere(join(cwd, 'models.jsonc')),
      brewery: readBreweryFiles(cwd),
    },
    diagnosis: diagnose(facts),
  });
  if (ready.kind === 'refused') {
    const stderr = ready.problems.map((problem) => `foedrum serve: ${problem}\n`).join('');
    return { exitCode: 1, stdout: '', stderr };
  }
  const { setup } = ready;

  const stop = new AbortController();
  const signals: NodeJS.Signals[] =
    process.platform === 'win32' ? ['SIGINT'] : ['SIGINT', 'SIGTERM'];
  const onSignal = () => stop.abort();
  for (const name of signals) process.once(name, onSignal);
  try {
    const exitCode = await runServe(setup, {
      // Notices may carry text a model wrote: never a control character on the terminal.
      out: (line) => process.stdout.write(`${printable(line)}\n`),
      signal: stop.signal,
      clock: () => new Date(),
      wait: (ms, signal) => sleep(ms, undefined, { signal }).catch(() => {}),
      lock: lockDriver,
      openStore: (path) => {
        mkdirSync(dirname(path), { recursive: true });
        return openSqliteEventStore(path);
      },
      stateBranch: (store) =>
        openStateBranch({ store, git: runGit, clone: cwd, worktree: setup.stateWorktree }),
      worktrees: async ({ repo, source, clone }) => {
        const { workRoot } = setup;
        if (source === 'local') {
          // serveSetup refuses a local repository without its clone.
          return openAttemptWorktrees({ git: runGit, workRoot, repo, clone: clone ?? '' });
        }
        const managed = await ensureManagedClone({
          git: runGit,
          workRoot,
          repo,
          url: `https://github.com/${repo}.git`,
          ...(clone === undefined ? {} : { reference: clone }),
        });
        return openAttemptWorktrees({ git: runGit, workRoot, repo, clone: managed });
      },
      runner: (claude, plan) => claudeBrewerRunner({ claude, plan }),
    });
    return { exitCode, stdout: '', stderr: '' };
  } finally {
    for (const name of signals) process.off(name, onSignal);
  }
};
