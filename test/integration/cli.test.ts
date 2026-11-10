// `foedrum status` through the wiring main.ts runs (cliFromCheckout), listing a kept branch from a
// real git clone: cli-main.ts runs git with no seam (ADR 0092). In process, with gh answered from
// captured output, so no command here can start the real gh (ADR 0086). The other commands through
// the same wiring are in test/unit/cli-main.test.ts (ADR 0362); the output itself is in
// test/unit/cli.test.ts.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cliFromCheckout } from '../../src/cli/cli-main.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { execProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { cannedGhLogin, noDenylist, resolveWithMadeUpGh } from '../helpers/canned-gh.ts';
import { config } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

describe('foedrum status on store files', () => {
  let brewery: TempDir;
  let store: string;
  beforeEach(() => {
    brewery = makeTempDir('cli');
    store = join(brewery.path, '.foedrum', 'index.db');
  });
  afterEach(() => removeTree(brewery.path));

  const foedrum = (...args: string[]) =>
    cliFromCheckout(args, brewery.path, {
      exec: cannedGhLogin(execProcess),
      resolve: resolveWithMadeUpGh,
      denylist: noDenylist,
    });

  it("lists a kept task-tree branch from the repository's clone, through git (ADR 0092)", async () => {
    // The user's clone: the batch started at `start`, and its branch holds two commits past it.
    const clone = join(brewery.path, 'web');
    mkdirSync(clone);
    // Without this machine's git configuration (signing, hooks), and with a hang guard.
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(brewery.path, 'no-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
        cwd: clone,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      }).trim();
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'start');
    const start = git('rev-parse', 'HEAD');
    git('switch', '-q', '-c', 'foedrum/11-1/brew/1');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    writeFileSync(join(brewery.path, 'foedrum.jsonc'), config());
    mkdirSync(join(brewery.path, '.foedrum'));
    writeFileSync(
      join(brewery.path, '.foedrum', 'local.jsonc'),
      JSON.stringify({ clones: { 'acme/web': clone } }),
    );
    const writer = openSqliteEventStore(store);
    const step = { batchId: '11-1', stepId: 'brew', attempt: 1 };
    writer.withTransaction((tx) => {
      for (const event of [
        {
          type: 'batch.ordered',
          batchId: '11-1',
          order: { issue: 11 },
          routeBy: '2026-12-31T00:00:00.000Z',
        },
        { type: 'step.scheduled', ...step, deadlineAt: '2026-12-31T00:00:00.000Z' },
        {
          type: 'step.started',
          ...step,
          worktree: {
            repo: 'acme/web',
            path: join(brewery.path, 'attempts', '11-1', 'brew', '1'),
            branch: 'foedrum/11-1/brew/1',
            commit: start,
          },
        },
        { type: 'step.finished', ...step, outcome: { kind: 'succeeded', output: {} } },
        { type: 'batch.cancelled', batchId: '11-1', by: 'ann', via: 'terminal' },
      ] as const) {
        tx.append(event);
      }
    });
    writer.close();

    const { exitCode, stdout, stderr } = await foedrum('status');

    assert.equal(stderr, '');
    assert.equal(exitCode, 0);
    // The whole line, as text: the clone's path may hold regex characters.
    assert.ok(
      stdout
        .split('\n')
        .includes(
          `  11-1  foedrum/11-1/brew/1  2 commits past the start  in ${clone}: git branch -D foedrum/11-1/brew/1`,
        ),
      stdout,
    );
  });
});
