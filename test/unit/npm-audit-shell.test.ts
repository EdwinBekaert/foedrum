// The audit:advisories shell with a fake process runner and a fake wait (ADR 0021): how many times
// it runs npm, what it passes, and when it waits. What npm's output means is in
// npm-audit-core.test.ts; the fixtures are npm 11.19.0's own output.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { auditAdvisories, RETRY_WAIT_MS } from '../../scripts/npm-audit.ts';
import type { ExecOptions, ExecProcess, ExecResult } from '../../src/platform/processes.ts';

const cwd = join('/work', 'tree');
const execPath = '/usr/local/bin/node';
const npmCli = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
const env = { npm_execpath: npmCli };

const answer = (name: string): ExecResult => {
  const { exitCode, stdout, stderr } = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'fixtures', 'npm-audit', `${name}.json`), 'utf8'),
  );
  return { exitCode, stdout, stderr, output: stderr + stdout };
};

// A fake runner that answers each call with the next result, and a wait that records its delays.
const fake = (...results: ExecResult[]) => {
  const calls: { file: string; args: readonly string[]; cwd: string }[] = [];
  const options: ExecOptions[] = [];
  const exec: ExecProcess = async (file, args, given) => {
    calls.push({ file, args, cwd: given.cwd });
    options.push(given);
    const next = results.shift();
    if (next === undefined) throw new Error('npm ran more often than the test expected');
    return next;
  };
  const waits: number[] = [];
  const wait = async (ms: number) => {
    waits.push(ms);
  };
  return { calls, options, exec, waits, wait };
};

describe('auditAdvisories', () => {
  it('gives npm a deadline of 360 s and the stop signal', async () => {
    const { options, exec, wait } = fake(answer('clean'));
    const stop = new AbortController().signal;
    await auditAdvisories(cwd, env, execPath, exec, wait, stop);
    assert.equal(options[0]?.timeoutMs, 360_000);
    assert.equal(options[0]?.signal, stop);
  });

  it('runs npm audit --omit=dev --json once and passes a clean report', async () => {
    const { calls, exec, waits, wait } = fake(answer('clean'));
    const run = await auditAdvisories(cwd, env, execPath, exec, wait);
    assert.equal(run.ok, true);
    assert.deepEqual(calls, [
      { file: execPath, args: [npmCli, 'audit', '--omit=dev', '--json'], cwd },
    ]);
    assert.deepEqual(waits, []);
  });

  it('fails on findings without a retry', async () => {
    const { calls, exec, waits, wait } = fake(answer('findings'));
    const run = await auditAdvisories(cwd, env, execPath, exec, wait);
    assert.equal(run.ok, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
    assert.ok(run.lines.some((line) => line.includes('minimist (critical)')));
  });

  it('waits and runs again after a server error, and passes a clean second report', async () => {
    const { calls, exec, waits, wait } = fake(answer('server-error'), answer('clean'));
    const run = await auditAdvisories(cwd, env, execPath, exec, wait);
    assert.equal(run.ok, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [RETRY_WAIT_MS]);
    assert.ok(run.lines.some((line) => line.includes('503')));
  });

  it('fails on findings after a server error', async () => {
    const { calls, exec, wait } = fake(answer('server-error'), answer('findings'));
    const run = await auditAdvisories(cwd, env, execPath, exec, wait);
    assert.equal(run.ok, false);
    assert.equal(calls.length, 2);
  });

  it('fails on a second server error, and runs npm no third time', async () => {
    const { calls, exec, waits, wait } = fake(answer('server-error'), answer('server-error'));
    const run = await auditAdvisories(cwd, env, execPath, exec, wait);
    assert.equal(run.ok, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [RETRY_WAIT_MS]);
  });

  it("shows npm's stderr when an attempt is not clean", async () => {
    const { exec, wait } = fake(answer('client-error'));
    const run = await auditAdvisories(cwd, env, execPath, exec, wait);
    assert.equal(run.ok, false);
    assert.ok(
      run.lines.some((line) => line.includes('npm error audit endpoint returned an error')),
    );
  });

  it('fails without a retry when npm is killed', async () => {
    const { calls, exec, wait } = fake({
      exitCode: null,
      stdout: '',
      stderr: '',
      output: '',
      killed: 'timed-out',
    });
    const run = await auditAdvisories(cwd, env, execPath, exec, wait);
    assert.equal(run.ok, false);
    assert.equal(calls.length, 1);
    assert.ok(run.lines.some((line) => line.includes('timed out')));
  });

  it('adds no empty line when npm is killed before writing to stderr', async () => {
    const { exec, wait } = fake({
      exitCode: null,
      stdout: '',
      stderr: '',
      output: '',
      killed: 'stopped',
    });
    const run = await auditAdvisories(cwd, env, execPath, exec, wait);
    assert.deepEqual(run.lines, ['npm audit did not finish (stopped)']);
  });

  it('numbers its tries, not attempts, which are steps of a batch (glossary)', async () => {
    const { exec, wait } = fake(answer('server-error'), answer('clean'));
    const run = await auditAdvisories(cwd, env, execPath, exec, wait);
    assert.ok(run.lines.some((line) => line.startsWith('try 1 of 2: ')));
    assert.ok(run.lines.some((line) => line.startsWith('try 2 of 2: ')));
    assert.ok(run.lines.every((line) => !line.includes('attempt')));
  });

  it('fails without running anything when npm_execpath is not set', async () => {
    const { calls, exec, wait } = fake();
    const run = await auditAdvisories(cwd, {}, execPath, exec, wait);
    assert.equal(run.ok, false);
    assert.equal(calls.length, 0);
    assert.ok(run.lines.some((line) => line.includes('npm_execpath')));
  });
});
