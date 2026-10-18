// `foedrum serve` (ADR 0063). Its own start refuses a folder that is no Brewery, with a canned
// answer for gh's login check (canned-gh-login.ts); and, as the real program,
// opt-in with FOEDRUM_REAL_CLAUDE=1 (ADR 0057), it brews one real step end to end on a throwaway
// Brewery: a labelled issue the intake orders and routes from a fake GitHub (ADR 0068) that the
// real gh reaches with a synthetic login of the test's own (ADR 0073), the order's text from there
// too, the real claude runner against the fake Messages API (no login, no tokens), real attempt worktrees
// of the user's clone, and the state branch pushed back. It tests Foedrum's wiring, not claude.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveFromCheckout } from '../../src/cli/serve-main.ts';
import { execProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';
import { realClaude } from '../helpers/real-claude.ts';
import { brewer, recipe } from '../helpers/serve-brewery.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { cannedGhLogin, resolveWithMadeUpGh } from './canned-gh-login.ts';
import { type Route, SYNTHETIC_LOGIN, startFakeGitHubOverGh } from './fake-github-over-gh.ts';
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
  afterEach(() => removeTree(dir.path));

  it('refuses a folder that is no Brewery, with one line per problem', async () => {
    // serve's own start, with a canned answer for gh's login check (ADR 0073).
    const result = await serveFromCheckout(dir.path, {
      exec: cannedGhLogin(),
      resolve: resolveWithMadeUpGh,
    });
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /^foedrum serve: foedrum\.jsonc: not found in /m);
    assert.match(result.stderr, /^foedrum serve: models\.jsonc: not found in /m);
  });
});

/** A pull request the recipe's openPullRequest action asked for, as it was sent. */
interface Pull {
  title: string;
  head: string;
  base: string;
  body: string;
}

/**
 * The Brewery's one labelled issue and its listing, the login serve reads at its start, the
 * status comments it makes on the order's issue (ADR 0072), the target repository's pull
 * requests, each one opened pushed to `pulls` (ADR 0071), and a 404 for anything else.
 */
const brewerysIssue = (body: string, pulls: Pull[]): Route => {
  const login = 'cellar-bot';
  const comments = new Map<number, string>();
  const commentOf = (id: number) => ({ id, user: { login }, body: comments.get(id) });
  // A pull request as GitHub answers it, opened by the Brewery's login from acme/web itself.
  const opened = (pull: Pull, number: number) => ({
    html_url: `https://github.com/acme/web/pull/${number}`,
    user: { login },
    head: { ref: pull.head, repo: { full_name: 'acme/web' } },
  });
  return ({ method, path, body: text }, response) => {
    const answer = (status: number, value: unknown): true => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
      return true;
    };
    const issue = {
      number: 12,
      title: 'Add a --json flag',
      state: 'open',
      user: { login: 'ann' },
      labels: ['recipe:stout'],
      body,
    };
    const bare = path.split('?')[0] ?? '';
    // gh's own questions for its login: the API root and the viewer, which the fake answers.
    if (bare === '/' || bare === '/graphql') return undefined;
    const comment = /^\/repos\/acme\/brewery\/issues\/comments\/(\d+)$/.exec(bare);
    const id = Number(comment?.[1]);
    const sent = (): string => (JSON.parse(text) as { body: string }).body;
    if (method === 'GET' && bare === '/user') return answer(200, { login });
    if (method === 'GET' && bare === '/repos/acme/brewery/issues') return answer(200, [issue]);
    if (method === 'GET' && bare === '/repos/acme/brewery/issues/12') return answer(200, issue);
    if (bare === '/repos/acme/brewery/issues/12/comments') {
      if (method === 'GET') return answer(200, [...comments.keys()].map(commentOf));
      if (method === 'POST') {
        comments.set(comments.size + 1, sent());
        return answer(201, commentOf(comments.size));
      }
    }
    // The openPullRequest action (ADR 0071): none from the bottle branch yet, then the one it opens.
    if (method === 'GET' && bare === '/repos/acme/web/pulls') {
      const head = new URLSearchParams(path.split('?')[1] ?? '').get('head');
      const listed = pulls.flatMap((pull, index) =>
        head === `acme:${pull.head}` ? [opened(pull, index + 1)] : [],
      );
      return answer(200, listed);
    }
    if (method === 'POST' && bare === '/repos/acme/web/pulls') {
      pulls.push(JSON.parse(text) as Pull);
      return answer(201, opened(pulls.at(-1) as Pull, pulls.length));
    }
    if (comment !== null && comments.has(id)) {
      if (method === 'GET') return answer(200, commentOf(id));
      if (method === 'PATCH') {
        comments.set(id, sent());
        return answer(200, commentOf(id));
      }
    }
    return answer(404, { message: 'Not Found' });
  };
};

describe('foedrum serve brews one real step', { skip: real.kind === 'skip' && real.reason }, () => {
  let dir: TempDir;
  let api: FakeMessagesApi | undefined;
  let github: Awaited<ReturnType<typeof startFakeGitHubOverGh>> | undefined;
  beforeEach(() => {
    dir = makeTempDir('serve-real');
  });
  afterEach(async () => {
    await api?.close();
    await github?.close();
    await removeTree(dir.path);
  });

  it('from a labelled issue the intake orders and routes, through started and finished to on tap, pushed back', async () => {
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
    const ghConfig = join(dir.path, 'gh');
    mkdirSync(ghConfig);
    const pulls: Pull[] = [];
    github = await startFakeGitHubOverGh(ghConfig, brewerysIssue('Add a --json flag.', pulls));
    const files = join(dir.path, 'brewery-seed');
    git(dir.path, ['init', '-q', '-b', 'main', files]);
    const config = {
      brewery: 'acme/brewery',
      users: ['ann'],
      githubApi: 'http://api.github.localhost',
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

    // The fake model commits a change in the attempt's worktree, as a brewer that produces commits
    // must (ADR 0074), with the clone's identity, then writes the out doc.
    git(clone, ['config', 'user.name', 'Brewer']);
    git(clone, ['config', 'user.email', 'brewer@example.com']);
    const worktree = join(realpathSync(work), 'acme.web', 'attempts', '12-1', 'brew', '1');
    api = await startFakeMessagesApi([
      { name: 'Write', input: { file_path: join(worktree, 'flag.txt'), content: '--json\n' } },
      { name: 'Bash', input: { command: 'git add flag.txt', description: 'Stage the flag' } },
      {
        name: 'Bash',
        input: { command: 'git commit -q -m "Brew the flag"', description: 'Commit it' },
      },
      {
        name: 'Write',
        input: {
          file_path: join(worktree, 'brew.md'),
          content: outDoc({ status: 'done', summary: 'Brewed' }),
        },
      },
    ]);
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
      // gh's way to the fake and its synthetic login; a token variable it must not use.
      HTTP_PROXY: github.env.HTTP_PROXY,
      HTTPS_PROXY: github.env.HTTPS_PROXY,
      GH_CONFIG_DIR: ghConfig,
      GH_TOKEN: 'from-the-environment-never-used',
    };

    // The batch's events on the Brewery's origin.
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
    const stop = new AbortController();
    const started = Date.now();
    const serving = execProcess(process.execPath, [main, 'serve'], {
      cwd: brewery,
      env,
      signal: stop.signal,
      timeoutMs: 180_000,
    });
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
    // The status comment's revisions are effects whose place depends on the ticks (ADR 0072).
    assert.ok(
      types.includes('effect.applied'),
      `${types.join(', ')}\n${result.stdout}\n${result.stderr}`,
    );
    assert.deepStrictEqual(
      types.filter((type) => type !== 'effect.applied'),
      [
        'batch.ordered',
        'batch.recipe_chosen',
        'step.scheduled',
        'step.started',
        'step.finished',
        // The openPullRequest action (ADR 0071, ADR 0084).
        'step.scheduled',
        'step.started',
        'step.finished',
        'batch.on_tap',
      ],
      `${result.stdout}\n${result.stderr}`,
    );
    // The brewer's commit went to the bottle branch of the target repository's origin, and the
    // pull request asks for it to go into main, closing the Brewery's issue.
    const branch = 'foedrum/acme.brewery/12-1/acme.web';
    const pushedTip = git(dir.path, [
      '--git-dir',
      join(dir.path, 'web.git'),
      'log',
      '-1',
      '--format=%s',
      branch,
    ]);
    assert.equal(pushedTip.trim(), 'Brew the flag');
    assert.deepStrictEqual(
      pulls.map(({ head, base, title }) => ({ head, base, title })),
      [{ head: branch, base: 'main', title: 'Add a --json flag' }],
    );
    assert.match(pulls[0]?.body ?? '', /\nCloses acme\/brewery#12$/i);
    // Opened through the ledger, and the batch went on tap with the URL GitHub answered.
    const events = pushed()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as { event: Record<string, unknown> }).event);
    assert.ok(
      events.some((e) => e.type === 'effect.applied' && e.key === '["12-1","pull_request"]'),
      JSON.stringify(events),
    );
    assert.deepStrictEqual(events.find((e) => e.type === 'batch.on_tap')?.pullRequests, [
      'https://github.com/acme/web/pull/1',
    ]);
    assert.match(result.stdout, /^foedrum serve: brewing for acme\/brewery in /m);
    assert.match(result.stdout, /^foedrum serve: ordered acme\/brewery#12 as batch 12-1$/m);
    assert.match(result.stdout, /^foedrum serve: routed batch 12-1 to the recipe stout$/m);
    // The login came first, at serve's start (ADR 0072), then the listing and the order's text, all
    // through gh's own login, never the token variable; the text reached the model in nonce tags.
    const read = (github.requests ?? [])
      .filter(({ path }) => path !== '/' && path !== '/graphql')
      .map(({ path, authorization }) => [path.split('?')[0], authorization]);
    assert.deepStrictEqual(read[0], ['/user', `token ${SYNTHETIC_LOGIN}`]);
    assert.deepStrictEqual(
      read
        .filter(([path]) => /^\/repos\/acme\/brewery\/issues(?:\/12)?$/.test(path ?? ''))
        .slice(0, 2),
      [
        ['/repos/acme/brewery/issues', `token ${SYNTHETIC_LOGIN}`],
        ['/repos/acme/brewery/issues/12', `token ${SYNTHETIC_LOGIN}`],
      ],
    );
    assert.match(
      api.bodies[0] ?? '',
      /untrusted-input-[0-9a-f]{32} source=\\"issue #12 body\\" name=\\"order\\">\\nAdd a --json flag\./,
    );
  });
});
