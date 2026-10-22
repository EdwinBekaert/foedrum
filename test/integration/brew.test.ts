// `foedrum brew` (ADR 0123) on the machine, with no Cellar running: the demo's scratch Brewery and
// target repository with bare remotes (ADR 0097), real git, the real driver lock and event store,
// the state branch, the attempt worktrees of the user's clone and serve's pushes, with two seams
// of the demo's own: its scripted brewer for claude and its in-process code host for gh. The order
// has no batch yet: brew orders it, routes it by its label, brews it and opens its pull request.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEMO_GIT_CONFIG, scriptedBrewer } from '../../scripts/demo/brewer.ts';
import { codeHost } from '../../scripts/demo/code-host.ts';
import {
  BREWERY,
  breweryFiles,
  DIAGNOSIS,
  gitConfig,
  gitEnvOf,
  localConfig,
  ORDER,
  TARGET,
} from '../../scripts/demo/core.ts';
import { runBrew } from '../../src/cli/brew.ts';
import type { ServeShell } from '../../src/cli/serve.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { serveShell } from '../../src/cli/serve-shell.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { type Git, runGit } from '../../src/workspace/git.ts';
import { hangGuardMs } from '../helpers/load.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

describe('foedrum brew', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('brew');
  });
  afterEach(() => removeTree(dir.path));

  it('takes an order with no batch to a pull request, with no Cellar running', async () => {
    const scratch = dir.path;
    // Every git reads only the demo's configuration: its identity, and the target's GitHub URL
    // sent to the scratch remote. The machine's own takes no part.
    const ownGit = gitEnvOf(scratch);
    writeFileSync(ownGit.GIT_CONFIG_GLOBAL, gitConfig(join(scratch, 'web.git')));
    const git: Git = (cwd, args, options = {}) =>
      runGit(cwd, args, { ...options, env: { ...options.env, ...ownGit } });
    const must = async (cwd: string, args: string[]): Promise<void> => {
      const result = await git(cwd, args, { config: DEMO_GIT_CONFIG });
      assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
    };
    const repository = async (name: string, files: Record<string, string>): Promise<string> => {
      const clone = join(scratch, name);
      await must(scratch, ['init', '-q', '--bare', '--initial-branch=main', `${name}.git`]);
      await must(scratch, ['clone', '-q', `${name}.git`, name]);
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(clone, path)), { recursive: true });
        writeFileSync(join(clone, path), text);
      }
      await must(clone, ['add', '--all']);
      await must(clone, ['commit', '-q', '-m', `Start ${name}`]);
      await must(clone, ['push', '-q', 'origin', 'main']);
      return clone;
    };
    const web = await repository('web', { 'README.md': '# web\n' });
    const root = await repository('brewery', breweryFiles());
    mkdirSync(join(root, '.foedrum'));
    writeFileSync(join(root, '.foedrum', 'local.jsonc'), localConfig(join(scratch, 'work'), web));

    const read = (path: string) => readFileSync(path, 'utf8');
    const ready = serveSetup({
      root,
      home: join(scratch, 'home'),
      platform: process.platform,
      env: process.env,
      files: {
        config: read(join(root, 'foedrum.jsonc')),
        local: read(join(root, '.foedrum', 'local.jsonc')),
        models: read(join(root, 'models.jsonc')),
        brewery: readBreweryFiles(root),
      },
      diagnosis: DIAGNOSIS,
    });
    const setup = ready.kind === 'ready' ? ready.setup : assert.fail(JSON.stringify(ready));
    const host = await codeHost({ lines: () => [], append: () => {} });
    const lines: string[] = [];
    const machine = serveShell(setup, {
      root,
      git,
      out: (line) => lines.push(line),
      // The test's process keeps its own signals.
      listen: () => {},
      command: 'brew',
    });
    const shell: ServeShell = {
      ...machine,
      intervalMs: 50,
      // Only a guard against a hang (ADR 0075): brew stops, closing its driver, and the exit
      // code below says it never got there.
      signal: AbortSignal.any([machine.signal, AbortSignal.timeout(hangGuardMs)]),
      runner: (_claude, plan) =>
        scriptedBrewer({
          plan,
          git,
          write: (path, text) => writeFileSync(path, text),
          life: 'finish',
          crash: () => assert.fail('the brewer of this life never crashes'),
        }),
      gh: host.exec,
    };

    const exitCode = await runBrew(setup, shell, {
      target: { issue: ORDER.number },
      owner: 'ann',
      by: 'ann',
      via: 'terminal',
    });

    const output = lines.join('\n');
    assert.equal(exitCode, 0, output);
    assert.ok(lines.includes(`foedrum brew: ordered #${ORDER.number} as batch 1-1`), output);
    assert.ok(lines.includes('foedrum brew: routed batch 1-1 to the recipe stout'), output);
    // One pull request on the code host, from the batch's bottle branch into main, with the
    // brewer's commit pushed to the target's remote.
    const branch = `foedrum/${BREWERY.replace('/', '.')}/1-1/${TARGET.replace('/', '.')}`;
    assert.deepStrictEqual(
      host.pulls().map(({ repo, head, base }) => ({ repo, head, base })),
      [{ repo: TARGET, head: branch, base: 'main' }],
    );
    const tip = await git(scratch, [
      '--git-dir',
      join(scratch, 'web.git'),
      'log',
      '-1',
      '--format=%s',
      branch,
    ]);
    assert.match(tip.stdout, /^Greet the visitors/);
    const [pull] = host.pulls();
    assert.equal(
      lines.at(-1),
      `foedrum brew: batch 1-1 is on tap: https://github.com/${TARGET}/pull/${pull?.number}`,
    );
  });
});
