// A brewer's git holds no credential that lets a push succeed (ADR 0109), with real git: the
// user's configuration plants a credential helper, one for the remote's URL, an askpass program, an
// ssh command and ssh allowed by name, and a push with the brewer's forced variables runs none of
// them. The one server is a local one that asks for a login: nothing reaches the network.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { brewerForcedEnv } from '../../src/engine/brewer-env.ts';
import { execProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

/** What each planted command writes to: one line per run, naming the command. */
const MARK = `import { appendFileSync } from 'node:fs';
appendFileSync(new URL('./marks.txt', import.meta.url), process.argv.slice(2).join(' ') + '\\n');
process.exit(1);
`;

describe("a brewer's git and the user's push credentials (ADR 0109)", () => {
  let dir: TempDir;
  // A server that answers every request with a demand for a login, so git asks for credentials.
  let server: Server;
  let port: number;
  before(async () => {
    dir = makeTempDir('brewer-git-credentials');
    server = createServer((_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="foedrum"' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await removeTree(dir.path);
  });

  let runs = 0;
  let run: string;
  let repo: string;
  let marks: string;
  /** The user's environment: git reads only the configuration this test writes. */
  let user: NodeJS.ProcessEnv;
  /** Runs git as the user, in `cwd`, with a deadline that only guards against a hang. */
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, env: user, timeout: 60_000, stdio: 'pipe' });
  beforeEach(() => {
    run = join(dir.path, String(++runs));
    repo = join(run, 'repo');
    marks = join(run, 'marks.txt');
    const global = join(run, 'gitconfig');
    mkdirSync(run, { recursive: true });
    user = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
      GIT_CONFIG_GLOBAL: global,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    const script = join(run, 'mark.mjs');
    writeFileSync(script, MARK);
    writeFileSync(global, '');
    const mark = `node "${script.replaceAll('\\', '/')}"`;
    // git starts an askpass program as it is, without a shell: a script of its own.
    const askPass = join(run, 'askpass.sh');
    writeFileSync(askPass, `#!/bin/sh\n${mark} core.askPass\nexit 1\n`);
    chmodSync(askPass, 0o755);
    const plant = (key: string, value: string) =>
      git(run, ['config', '--file', global, key, value]);
    plant('user.name', 'Test');
    plant('user.email', 't@example.com');
    plant('credential.helper', `!${mark} credential.helper`);
    plant(`credential.http://127.0.0.1:${port}.helper`, `!${mark} credential.url.helper`);
    plant('core.askPass', askPass.replaceAll('\\', '/'));
    plant('core.sshCommand', `${mark} core.sshCommand`);
    plant('protocol.ssh.allow', 'always');
    git(run, ['init', '-q', '-b', 'main', repo]);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'Initial commit']);
  });

  // Through the runner, not spawnSync: this process's server must answer while git runs.
  const push = (url: string, env: NodeJS.ProcessEnv) =>
    execProcess('git', ['push', url, 'HEAD:refs/heads/plan'], {
      cwd: repo,
      env,
      timeoutMs: 60_000,
    });
  const brewer = (): NodeJS.ProcessEnv => ({ ...user, ...brewerForcedEnv() });
  const marked = (): string => (existsSync(marks) ? readFileSync(marks, 'utf8') : '');

  it("fails a push over http at once, asking none of the user's credential helpers and no askpass program", async () => {
    // Without the forced variables git asks each helper, then the askpass program: that is what
    // they close.
    assert.notEqual((await push(`http://127.0.0.1:${port}/acme/app.git`, user)).exitCode, 0);
    for (const planted of [
      /^credential\.helper get$/m,
      /^credential\.url\.helper get$/m,
      /^core\.askPass$/m,
    ]) {
      assert.match(marked(), planted);
    }
    rmSync(marks);
    const pushed = await push(`http://127.0.0.1:${port}/acme/app.git`, brewer());
    assert.notEqual(pushed.exitCode, 0);
    assert.match(pushed.stderr, /terminal prompts disabled/);
    assert.equal(marked(), '');
  });

  it('refuses a push over ssh before any ssh command runs', async () => {
    // Without the forced variables git runs the user's ssh command.
    assert.notEqual((await push('ssh://git@foedrum.invalid/acme/app.git', user)).exitCode, 0);
    assert.match(marked(), /^core\.sshCommand /m);
    rmSync(marks);
    const pushed = await push('ssh://git@foedrum.invalid/acme/app.git', brewer());
    assert.notEqual(pushed.exitCode, 0);
    assert.match(pushed.stderr, /transport 'ssh' not allowed/);
    assert.equal(marked(), '');
  });

  it('gives git the empty values through the Job Object and the platform shell, as the runners start it', async () => {
    const shown = [
      // The brewer runner's and the check runner's Job Object (ADR 0039), and a check's shell.
      await execProcess('git', ['config', '--show-scope', '--get-all', 'credential.helper'], {
        cwd: repo,
        env: brewer(),
        timeoutMs: 60_000,
        jobObject: true,
      }),
      await execProcess('git config --show-scope --get-all credential.helper', [], {
        cwd: repo,
        env: brewer(),
        timeoutMs: 60_000,
        shell: true,
        jobObject: true,
      }),
    ];
    for (const { exitCode, stdout, stderr } of shown) {
      assert.equal(exitCode, 0, stderr);
      assert.match(stdout, /^command\t\r?$/m);
    }
  });

  it('still pushes to a local path, which needs no credential', async () => {
    const origin = join(run, 'origin.git');
    git(run, ['init', '-q', '--bare', origin]);
    const pushed = await push(origin, brewer());
    assert.equal(pushed.exitCode, 0, pushed.stderr);
    assert.equal(marked(), '');
  });
});
