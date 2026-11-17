// The lockfile refresh after a release bump through the real brewer runner (ADR 0412): the
// installed `claude` against the fake Messages API (no login, no tokens), a real clone whose
// attempt branch holds the brewer's bump, and a process runner that stands in for npm. The
// runner's own scratch tree commits the refreshed lockfile on that branch. Opt-in: it runs only
// with FOEDRUM_REAL_CLAUDE=1 (ADR 0057).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type ClaudeAttemptPlan, claudeBrewerRunner } from '../../src/brewers/claude-runner.ts';
import { assembleBrewerPrompt } from '../../src/brewers/prompt.ts';
import type { AttemptStart } from '../../src/engine/brewer-runner.ts';
import type { ExecOptions, ExecResult } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import { outDoc } from '../helpers/fake-brewer-runner.ts';
import { realClaude } from '../helpers/real-claude.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';
import { type FakeMessagesApi, startFakeMessagesApi } from './fake-messages-api.ts';

const real = realClaude();

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

describe('the claude brewer runner: the lockfile refresh (ADR 0412)', {
  skip: real.kind === 'skip' && real.reason,
}, () => {
  let dir: TempDir;
  let api: FakeMessagesApi | undefined;
  beforeEach(() => {
    dir = makeTempDir('claude-runner-lockfile');
  });
  afterEach(async () => {
    await api?.close();
    removeTree(dir.path);
  });

  it("commits the refreshed lockfile on the attempt's branch through the runner's own scratch tree", async () => {
    // The clone: the start, and on the attempt's branch the brewer's bump after it.
    const clone = join(dir.path, 'clone');
    mkdirSync(clone);
    git(clone, ['init', '--quiet', '--initial-branch=main']);
    writeFileSync(join(clone, 'package.json'), '{ "dependencies": { "greet": "1.1.0" } }\n');
    writeFileSync(join(clone, 'package-lock.json'), '{ "greet": "1.1.0" }\n');
    git(clone, ['add', '.']);
    git(clone, ['commit', '--quiet', '-m', 'start']);
    const start = git(clone, ['rev-parse', 'HEAD']);
    const branch = 'foedrum/12-1/implement/1';
    git(clone, ['switch', '--quiet', '-c', branch]);
    writeFileSync(join(clone, 'package.json'), '{ "dependencies": { "greet": "1.2.0" } }\n');
    git(clone, ['commit', '--quiet', '-am', 'Bump greet to 1.2.0']);
    const bumped = git(clone, ['rev-parse', 'HEAD']);
    git(clone, ['switch', '--quiet', 'main']);

    // claude's own worktree, where its model writes the out doc.
    const worktree = join(dir.path, 'worktree');
    mkdirSync(worktree);
    mkdirSync(join(dir.path, 'user'));
    mkdirSync(join(dir.path, 'attempt'));
    api = await startFakeMessagesApi({
      name: 'Write',
      input: {
        file_path: join(worktree, 'brew.md'),
        content: outDoc({ status: 'done', summary: 'Bumped greet' }),
      },
    });
    const assembled = assembleBrewerPrompt('Bump greet to 1.2.0.', []);
    if (assembled.kind !== 'assembled') throw new Error('the prompt was refused');
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:ANTHROPIC_|CLAUDE)/i.test(name)),
    );
    const plan: ClaudeAttemptPlan = {
      cwd: worktree,
      env: {
        ...inherited,
        CLAUDE_CONFIG_DIR: join(dir.path, 'user'),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
      },
      prompt: assembled.prompt,
      call: {
        model: 'claude-haiku-5-5',
        effort: 'low',
        maxTurns: 5,
        tools: ['Read', 'Write'],
        session: { kind: 'new', id: randomUUID() },
      },
      permissions: { allow: ['Read', 'Write'], deny: [], sandbox: false },
      settingsFile: join(dir.path, 'attempt', 'settings.json'),
      commits: { clone, branch },
      refresh: {
        own: { url: join(dir.path, 'nowhere.git'), root: join(dir.path, 'git-dirs') },
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        env: { PATH: process.env.PATH ?? '' },
        unsandboxed: false,
      },
    };
    // npm's part: the refresh rewrites the lockfile in its folder of the scratch tree.
    const ran: string[] = [];
    const npm = async (command: string, _args: readonly string[], options?: ExecOptions) => {
      ran.push(command);
      writeFileSync(join(options?.cwd ?? '', 'package-lock.json'), '{ "greet": "1.2.0" }\n');
      const result: ExecResult = { exitCode: 0, stdout: '', stderr: '', output: '' };
      return result;
    };
    const runner = claudeBrewerRunner({
      claude: real.kind === 'run' ? real.claude : 'claude',
      plan: async () => plan,
      setup: npm,
    });
    const attempt: AttemptStart = {
      ref: { batchId: '12-1', stepId: 'implement', attempt: 1 },
      limits: {
        outDoc: { file: 'brew.md', schema: OutDocFrontmatter },
        maxTurns: 5,
        commitsSince: start,
      },
    };
    const end = await runner.start(attempt).ended;
    assert.equal(end.ending.kind, 'succeeded', JSON.stringify(end.ending));
    assert.deepEqual(ran, ['npm install --package-lock-only --ignore-scripts']);
    // Foedrum's commit on the brewer's bump, with the refreshed lockfile.
    assert.equal(git(clone, ['log', '-1', '--format=%P %an', branch]), `${bumped} Foedrum`);
    assert.equal(git(clone, ['show', `${branch}:package-lock.json`]), '{ "greet": "1.2.0" }');
  });
});
