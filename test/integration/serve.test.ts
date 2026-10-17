// `foedrum serve` as the real program (ADR 0063). It refuses a folder that is no Brewery, and,
// opt-in with FOEDRUM_REAL_CLAUDE=1 (ADR 0057), it brews one real step end to end on a throwaway
// Brewery: an order routed on the Brewery's state branch, the order's text from a fake GitHub, the
// real claude runner against the fake Messages API (no login, no tokens), real attempt worktrees
// of the user's clone, and the state branch pushed back. It tests Foedrum's wiring, not claude.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCommandLog } from '../../src/engine/command-log.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { openStateBranch } from '../../src/engine/state-branch-git.ts';
import { execProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { runGit } from '../../src/workspace/git.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';
import { realClaude } from '../helpers/real-claude.ts';
import { brewer, recipe } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { type FakeMessagesApi, startFakeMessagesApi } from './fake-messages-api.ts';

const main = join(import.meta.dirname, '..', '..', 'src', 'cli', 'main.ts');
const real = realClaude();

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe('foedrum serve', () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = makeTempDir('serve');
  });
  afterEach(() => dir.remove());

  it('refuses a folder that is no Brewery, with one line per problem', async () => {
    const result = await execProcess(process.execPath, [main, 'serve'], {
      cwd: dir.path,
      env: { ...process.env, GH_TOKEN: 'ghp_test' },
      timeoutMs: 60_000,
    });
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /^foedrum serve: foedrum\.jsonc: not found in /m);
    assert.match(result.stderr, /^foedrum serve: models\.jsonc: not found in /m);
  });
});

/** A fake GitHub REST API on 127.0.0.1 that knows one issue of the Brewery. */
const startFakeGitHub = async (body: string) => {
  const requests: { url: string; authorization: string | undefined }[] = [];
  const server: Server = createServer((request, response) => {
    requests.push({ url: request.url ?? '', authorization: request.headers.authorization });
    if (request.method === 'GET' && request.url === '/repos/acme/brewery/issues/12') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ number: 12, state: 'open', user: { login: 'ann' }, labels: [], body }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'Not Found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe('foedrum serve brews one real step', { skip: real.kind === 'skip' && real.reason }, () => {
  let dir: TempDir;
  let api: FakeMessagesApi | undefined;
  let github: Awaited<ReturnType<typeof startFakeGitHub>> | undefined;
  beforeEach(() => {
    dir = makeTempDir('serve-real');
  });
  afterEach(async () => {
    await api?.close();
    await github?.close();
    removeTree(dir.path);
  });

  it('from an order on the state branch through started and finished to on tap, pushed back', async () => {
    // The target repository: an origin and the user's clone of it.
    const seed = join(dir.path, 'seed');
    git(dir.path, ['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, 'readme.txt'), 'hello\n');
    git(seed, ['add', 'readme.txt']);
    git(seed, ['commit', '-q', '-m', 'Initial commit']);
    git(dir.path, ['clone', '-q', '--bare', seed, join(dir.path, 'web.git')]);
    const clone = join(dir.path, 'web');
    git(dir.path, ['clone', '-q', join(dir.path, 'web.git'), clone]);

    // The Brewery: its files on main, pushed to its origin, and the checkout serve runs in.
    const work = join(dir.path, 'work');
    mkdirSync(work);
    github = await startFakeGitHub('Add a --json flag.');
    const files = join(dir.path, 'brewery-seed');
    git(dir.path, ['init', '-q', '-b', 'main', files]);
    const config = {
      brewery: 'acme/brewery',
      githubApi: github.url,
      repositories: {
        'acme/web': {
          checks: { build: null, typecheck: null, lint: null, format: null, test: null },
        },
      },
    };
    writeFileSync(join(files, 'foedrum.jsonc'), JSON.stringify(config, null, 2));
    writeFileSync(join(files, 'models.jsonc'), '{ "models": { "quick": "claude-haiku-5-5" } }');
    writeFileSync(join(files, '.gitignore'), '.foedrum/\n');
    mkdirSync(join(files, 'recipes'));
    mkdirSync(join(files, 'brewers'));
    writeFileSync(join(files, 'recipes', 'stout.jsonc'), recipe);
    writeFileSync(join(files, 'brewers', 'cellarman.md'), brewer);
    git(files, ['add', '.']);
    git(files, ['commit', '-q', '-m', 'The Brewery']);
    const origin = join(dir.path, 'brewery.git');
    git(dir.path, ['clone', '-q', '--bare', files, origin]);
    const brewery = join(dir.path, 'brewery');
    git(dir.path, ['clone', '-q', origin, brewery]);
    mkdirSync(join(brewery, '.foedrum'));
    writeFileSync(
      join(brewery, '.foedrum', 'local.jsonc'),
      JSON.stringify({ workRoot: work, clones: { 'acme/web': clone } }),
    );

    // An earlier driver ordered issue 12 and routed it to stout: its events are on the state
    // branch, and serve starts without a store of its own, so it rebuilds it from there.
    const loaded = loadRecipes({
      recipes: [{ path: 'recipes/stout.jsonc', text: recipe }],
      brewers: [{ path: 'brewers/cellarman.md', text: brewer }],
    });
    assert.ok(loaded.valid);
    const earlier = openSqliteEventStore(join(dir.path, 'earlier.db'));
    const log = createCommandLog({ store: earlier, recipes: loaded.recipes });
    const now = new Date();
    log.issue({ kind: 'order', batchId: '12-1', order: { issue: 12 } }, now);
    const route = { kind: 'route', batchId: '12-1', recipe: 'stout', reason: 'label' } as const;
    assert.equal(log.issue({ ...route, source: 'label' }, now).kind, 'accepted');
    const seeding = join(dir.path, 'seed-state');
    const branch = openStateBranch({
      store: earlier,
      git: runGit,
      clone: brewery,
      worktree: seeding,
    });
    await branch.start();
    assert.equal((await branch.flush()).kind, 'pushed');
    earlier.close();
    git(brewery, ['worktree', 'remove', '--force', seeding]);
    git(brewery, ['branch', '-D', 'foedrum/state']);

    // The fake model writes the out doc in the attempt's worktree.
    const worktree = join(realpathSync(work), 'acme.web', 'attempts', '12-1', 'brew', '1');
    api = await startFakeMessagesApi({
      name: 'Write',
      input: {
        file_path: join(worktree, 'brew.md'),
        content: outDoc({ status: 'done', summary: 'Brewed' }),
      },
    });
    const needed =
      /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i;
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => needed.test(name)),
    );
    mkdirSync(join(dir.path, 'user'));
    const env = {
      ...inherited,
      CLAUDE_CONFIG_DIR: join(dir.path, 'user'),
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      GH_TOKEN: 'ghp_test_not_a_token',
    };

    const stop = new AbortController();
    const started = Date.now();
    const serving = execProcess(process.execPath, [main, 'serve'], {
      cwd: brewery,
      env,
      signal: stop.signal,
      timeoutMs: 180_000,
    });
    // Done once the batch's events on the Brewery's origin end on tap.
    const pushed = (): string => {
      try {
        return git(dir.path, [
          '--git-dir',
          origin,
          'show',
          'foedrum/state:batches/12-1/events.jsonl',
        ]);
      } catch {
        return '';
      }
    };
    let ended = false;
    void serving.then(() => {
      ended = true;
    });
    while (!pushed().includes('"batch.on_tap"') && !ended && Date.now() - started < 170_000) {
      await sleep(250);
    }
    stop.abort();
    const result = await serving;
    process.stdout.write(`# foedrum serve brewed the step in ${Date.now() - started} ms\n`);

    const types = pushed()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as { event: { type: string } }).event.type);
    assert.deepStrictEqual(
      types,
      [
        'batch.ordered',
        'batch.recipe_chosen',
        'step.scheduled',
        'step.started',
        'step.finished',
        'batch.on_tap',
      ],
      `${result.stdout}\n${result.stderr}`,
    );
    assert.match(result.stdout, /^foedrum serve: brewing for acme\/brewery in /m);
    // The order's text came from GitHub, with the token, and reached the model in nonce tags.
    assert.deepStrictEqual(github.requests, [
      { url: '/repos/acme/brewery/issues/12', authorization: 'Bearer ghp_test_not_a_token' },
    ]);
    assert.match(
      api.bodies[0] ?? '',
      /untrusted-input-[0-9a-f]{32} source=\\"issue #12 body\\" name=\\"order\\">\\nAdd a --json flag\./,
    );
  });
});
