// The denylist's shell for the local gate (ADR 0114): the list and git's answers are injected, so
// no test reads the real list or starts git (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DENYLIST_GIT_TIMEOUT_MS, pushRefusal } from '../../scripts/denylist.ts';
import type { ProcessOutcome, RunOptions } from '../../scripts/process-runner.ts';
import type { DenylistState } from '../../src/platform/denylist.ts';

const PATH = '/lists/denylist.txt';
const set = (text: string): DenylistState => ({ kind: 'set', path: PATH, text });
const sha = 'a'.repeat(40);

// A git that answers the messages log and the patches log, and records each call.
const fakeGit = (messages: ProcessOutcome, patches: ProcessOutcome) => {
  const calls: { file: string; args: string[]; cwd: string; options?: RunOptions }[] = [];
  const runProcess = async (file: string, args: string[], cwd: string, options?: RunOptions) => {
    calls.push({ file, args, cwd, ...(options === undefined ? {} : { options }) });
    return args.includes('--patch') ? patches : messages;
  };
  return { calls, runProcess };
};
const ok = (output: string): ProcessOutcome => ({ exitCode: 0, output });
const cleanMessages = ok(`\0${sha}\nAda\nada@example.com\nAda\nada@example.com\nAdd a plan\n`);
const cleanPatches = ok(`\0${sha}\n\ndiff --git a/plan.md b/plan.md\n@@ -0,0 +1 @@\n+a plan\n`);

describe('pushRefusal', () => {
  it('runs no git without a list, or with a list of only comments', async () => {
    for (const state of [{ kind: 'none', path: PATH } as const, set('# none yet\n\n')]) {
      const git = fakeGit(cleanMessages, cleanPatches);
      assert.equal(await pushRefusal(() => state, git.runProcess)('/work/tree'), undefined);
      assert.deepEqual(git.calls, []);
    }
  });

  it('blocks every push when the list cannot be read, naming its path', async () => {
    const git = fakeGit(cleanMessages, cleanPatches);
    const refusal = await pushRefusal(
      () => ({ kind: 'unreadable', path: PATH, why: 'ENOENT: no such file' }),
      git.runProcess,
    )('/work/tree');
    assert.match(refusal ?? '', /^git push is blocked: the denylist at \/lists\/denylist\.txt/);
    assert.match(refusal ?? '', /ENOENT: no such file/);
    assert.deepEqual(git.calls, []);
  });

  it('reads the commits no remote has, in the tree, as stored and plainly', async () => {
    const git = fakeGit(cleanMessages, cleanPatches);
    assert.equal(
      await pushRefusal(() => set('examplecorp'), git.runProcess)('/work/tree'),
      undefined,
    );
    assert.equal(git.calls.length, 2);
    for (const { file, args, cwd, options } of git.calls) {
      assert.equal(file, 'git');
      assert.equal(cwd, '/work/tree');
      assert.equal(options?.timeoutMs, DENYLIST_GIT_TIMEOUT_MS);
      assert.equal(args[0], '--no-replace-objects');
      assert.ok(args.includes('core.quotePath=false'));
      assert.deepEqual(args.slice(-3), ['HEAD', '--not', '--remotes']);
    }
    const patches = git.calls.find(({ args }) => args.includes('--patch'))?.args ?? [];
    for (const flag of [
      '--diff-merges=dense-combined',
      '--unified=0',
      '--text',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
    ]) {
      assert.ok(patches.includes(flag), flag);
    }
  });

  it('blocks a push whose messages or added lines hold a word, naming places only', async () => {
    const git = fakeGit(
      ok(`\0${sha}\nAda\nada@example.com\nAda\nada@example.com\nFor ExampleCorp\n`),
      ok(`\0${sha}\n\ndiff --git a/plan.md b/plan.md\n@@ -0,0 +1,2 @@\n+a plan\n+exampleCorp\n`),
    );
    const refusal = await pushRefusal(() => set('examplecorp'), git.runProcess)('/work/tree');
    assert.match(refusal ?? '', /^git push is blocked: it would send a word on your denylist/);
    assert.match(refusal ?? '', /commit aaaaaaa message line 1; commit aaaaaaa plan\.md:2/);
    assert.doesNotMatch(refusal ?? '', /example ?corp/i);
  });

  const failures: [string, ProcessOutcome, RegExp][] = [
    ['exits non-zero', { exitCode: 128, output: 'fatal: bad revision' }, /exited 128/],
    ['cannot start', { exitCode: null, output: '' }, /could not start/],
    ['times out', { exitCode: null, output: '', killed: 'timed-out' }, /timed out after 30 s/],
    [
      'passes the output limit',
      { exitCode: null, output: '', killed: 'too-much-output' },
      /more than 4 MiB of output/,
    ],
  ];
  for (const [name, outcome, why] of failures) {
    it(`blocks the push when git ${name}`, async () => {
      const git = fakeGit(outcome, cleanPatches);
      const refusal = await pushRefusal(() => set('examplecorp'), git.runProcess)('/work/tree');
      assert.match(refusal ?? '', /^git push is blocked: could not read the commits it would send/);
      assert.match(refusal ?? '', why);
    });
  }
});
