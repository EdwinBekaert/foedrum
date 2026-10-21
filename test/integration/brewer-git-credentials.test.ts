// A brewer's git holds no credential that lets a push succeed (ADR 0109), with real git: the
// user's configuration plants a credential helper, one for the remote's URL, an askpass program, an
// ssh command and ssh allowed by name, and a push with the brewer's forced variables runs none of
// them. The one server is a local one that asks for a login: nothing reaches the network.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  beforeEach(() => {
    run = join(dir.path, String(++runs));
    repo = join(run, 'repo');
    marks = join(run, 'marks.txt');
    const script = join(run, 'mark.mjs');
    const global = join(run, 'gitconfig');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(script, MARK);
    writeFileSync(global, '');
    const mark = `node "${script.replaceAll('\\', '/')}"`;
    const plant = (key: string, value: string) =>
      execFileSync('git', ['config', '--file', global, key, value]);
    plant('user.name', 'Test');
    plant('user.email', 't@example.com');
    plant('credential.helper', `!${mark} credential.helper`);
    plant(`credential.http://127.0.0.1:${port}.helper`, `!${mark} credential.<url>.helper`);
    plant('core.askPass', `${mark} core.askPass`);
    plant('core.sshCommand', `${mark} core.sshCommand`);
    plant('protocol.ssh.allow', 'always');
    user = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
      GIT_CONFIG_GLOBAL: global,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'Initial commit'], {
      cwd: repo,
      env: user,
    });
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
    // Without the forced variables the user's helper answers: that is what they close.
    assert.notEqual((await push(`http://127.0.0.1:${port}/acme/app.git`, user)).exitCode, 0);
    assert.match(marked(), /^credential\.helper get$/m);
    rmSync(marks);
    const pushed = await push(`http://127.0.0.1:${port}/acme/app.git`, brewer());
    assert.notEqual(pushed.exitCode, 0);
    assert.match(pushed.stderr, /terminal prompts disabled/);
    assert.equal(marked(), '');
  });

  it('refuses a push over ssh before any ssh command runs', async () => {
    const pushed = await push('ssh://git@foedrum.invalid/acme/app.git', brewer());
    assert.notEqual(pushed.exitCode, 0);
    assert.match(pushed.stderr, /transport 'ssh' not allowed/);
    assert.equal(marked(), '');
  });

  it('still pushes to a local path, which needs no credential', async () => {
    const origin = join(run, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    const pushed = await push(origin, brewer());
    assert.equal(pushed.exitCode, 0, pushed.stderr);
    assert.equal(marked(), '');
  });
});
