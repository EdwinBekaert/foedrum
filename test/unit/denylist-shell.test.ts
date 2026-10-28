// The denylist's shell for the local gate (ADR 0114): the list and git's answers are injected, so
// no test reads the real list or starts git (ADR 0021).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DENYLIST_GIT_TIMEOUT_MS, pushRefusal } from '../../scripts/denylist.ts';
import type { ProcessOutcome } from '../../scripts/process-runner.ts';
import type { DenylistState } from '../../src/platform/denylist.ts';
import type { ExecOptions, ExecProcess } from '../../src/platform/processes.ts';

const PATH = '/lists/denylist.txt';
const set = (text: string): DenylistState => ({ kind: 'set', path: PATH, text });
const sha = 'a'.repeat(40);

// What git answers: its exit code, stdout and stderr together, and stdout alone when it differs.
type Answer = ProcessOutcome & { stdout?: string };

// A git that answers the messages log, the patches log and the current branch's name and push
// remote (by default 613-x, with none), and records each call.
const fakeGit = (messages: Answer, patches: Answer, pushRef: Answer = ok('613-x\t\n')) => {
  const calls: { file: string; args: readonly string[]; cwd: string; options: ExecOptions }[] = [];
  const exec: ExecProcess = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd, options });
    const answer =
      args[0] === 'for-each-ref' ? pushRef : args.includes('--patch') ? patches : messages;
    return { stdout: answer.output, stderr: '', ...answer };
  };
  return { calls, exec };
};
const ok = (output: string): ProcessOutcome => ({ exitCode: 0, output });
const cleanMessages = ok(`\0${sha}\nAda\nada@example.com\nAda\nada@example.com\nAdd a plan\n`);
const cleanPatches = ok(`\0${sha}\n\ndiff --git a/plan.md b/plan.md\n@@ -0,0 +1 @@\n+a plan\n`);

describe('pushRefusal', () => {
  // The hook gives the gate 600 s; the HEAD check takes up to 10 s and npm run check 540 s, so the
  // three git calls (where the push goes, and the two logs) must fit in the 50 s between them.
  it('fits its three git calls between the HEAD check and the check, under the hook', () => {
    assert.ok(3 * DENYLIST_GIT_TIMEOUT_MS <= 600_000 - 10_000 - 540_000);
  });

  it('runs no git without a list, or with a list of only comments', async () => {
    for (const state of [{ kind: 'none', path: PATH } as const, set('# none yet\n\n')]) {
      const git = fakeGit(cleanMessages, cleanPatches);
      assert.equal(await pushRefusal(() => state, git.exec)('/work/tree'), undefined);
      assert.deepEqual(git.calls, []);
    }
  });

  it('blocks every push when the list cannot be read, naming its path', async () => {
    const git = fakeGit(cleanMessages, cleanPatches);
    const refusal = await pushRefusal(
      () => ({ kind: 'unreadable', path: PATH, why: 'ENOENT: no such file' }),
      git.exec,
    )('/work/tree');
    assert.match(refusal ?? '', /^git push is blocked: the denylist at \/lists\/denylist\.txt/);
    assert.match(refusal ?? '', /ENOENT: no such file/);
    assert.deepEqual(git.calls, []);
  });

  it('reads the commits the remote the push names has not, in the tree, as stored and plainly', async () => {
    const git = fakeGit(cleanMessages, cleanPatches);
    assert.equal(
      await pushRefusal(() => set('examplecorp'), git.exec)('/work/tree', 'origin'),
      undefined,
    );
    // The branch's name is read too, though the push names its remote (ADR 0246).
    const [where, ...logs] = git.calls;
    assert.equal(where?.args[0], 'for-each-ref');
    assert.equal(logs.length, 2);
    for (const { file, args, cwd, options } of logs) {
      assert.equal(file, 'git');
      assert.equal(cwd, '/work/tree');
      assert.equal(options?.timeoutMs, DENYLIST_GIT_TIMEOUT_MS);
      assert.equal(args[0], '--no-replace-objects');
      assert.ok(args.includes('core.quotePath=false'));
      assert.deepEqual(args.slice(-3), ['HEAD', '--not', '--remotes=origin']);
    }
    const patches = logs.find(({ args }) => args.includes('--patch'))?.args ?? [];
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

  // Another remote's refs (a private mirror) may hold what the push sends to this one.
  it('asks git where a push that names no remote goes, and reads against that remote', async () => {
    // Every local branch prints a line; only the current one (%(HEAD)) prints its name and push
    // remote.
    const git = fakeGit(cleanMessages, cleanPatches, ok('\n\n613-x\twork\n\n'));
    assert.equal(await pushRefusal(() => set('examplecorp'), git.exec)('/work/tree'), undefined);
    const [where, ...logs] = git.calls;
    assert.deepEqual(where?.args, [
      'for-each-ref',
      '--format=%(if)%(HEAD)%(then)%(refname:lstrip=2)%09%(push:remotename)%(end)',
      'refs/heads/',
    ]);
    assert.equal(where?.cwd, '/work/tree');
    assert.equal(where?.options.timeoutMs, DENYLIST_GIT_TIMEOUT_MS);
    for (const { args } of logs)
      assert.deepEqual(args.slice(-3), ['HEAD', '--not', '--remotes=work']);
  });

  // git allows a slash in a remote's name: team/public's refs are not team/private's.
  it('keeps a push remote whose name holds a slash whole', async () => {
    const git = fakeGit(cleanMessages, cleanPatches, ok('613-x\tteam/public\n'));
    await pushRefusal(() => set('examplecorp'), git.exec)('/work/tree');
    assert.deepEqual(
      git.calls.slice(1).map(({ args }) => args.at(-1)),
      ['--remotes=team/public', '--remotes=team/public'],
    );
  });

  // One command's scan reads one remote, so its git calls fit one deadline budget.
  it('blocks a command that pushes to more than one remote while a list is set', async () => {
    const git = fakeGit(cleanMessages, cleanPatches);
    const refusal = await pushRefusal(() => set('examplecorp'), git.exec)(
      '/work/tree',
      'origin',
      'work',
    );
    assert.match(refusal ?? '', /^git push is blocked: .*more than one remote/);
    assert.deepEqual(git.calls, []);
    const none = await pushRefusal(() => ({ kind: 'none', path: PATH }), git.exec)(
      '/work/tree',
      'origin',
      'work',
    );
    assert.equal(none, undefined);
  });

  it('reads against origin when the branch has no push remote', async () => {
    const git = fakeGit(cleanMessages, cleanPatches, ok('\n613-x\t\n'));
    await pushRefusal(() => set('examplecorp'), git.exec)('/work/tree');
    assert.deepEqual(
      git.calls.slice(1).map(({ args }) => args.at(-1)),
      ['--remotes=origin', '--remotes=origin'],
    );
  });

  // Without the branch's name the gate cannot tell which name the push creates (ADR 0246).
  const unnamed: [string, Answer, RegExp][] = [
    ['git fails', { exitCode: 128, output: 'fatal: bad ref' }, /exited 128/],
    ['git times out', { exitCode: null, output: '', killed: 'timed-out' }, /timed out/],
    ['git prints no current branch', ok('\n\n'), /no current branch/],
  ];
  for (const [name, pushRef, why] of unnamed) {
    it(`blocks the push when ${name} reading the branch`, async () => {
      const git = fakeGit(cleanMessages, cleanPatches, pushRef);
      const refusal = await pushRefusal(() => set('examplecorp'), git.exec)('/work/tree', 'origin');
      assert.match(refusal ?? '', /^git push is blocked: could not read the branch it pushes/);
      assert.match(refusal ?? '', why);
      assert.equal(git.calls.length, 1);
    });
  }

  // The branch names a push creates on the remote leave the machine too (ADR 0246).
  it('blocks a push from a branch whose name holds a word, naming the place only', async () => {
    const git = fakeGit(cleanMessages, cleanPatches, ok('612-ExampleCorp-export\torigin\n'));
    const refusal = await pushRefusal(() => set('examplecorp'), git.exec)('/work/tree');
    assert.equal(
      refusal,
      'git push is blocked: it would send a word on your denylist (ADR 0114), at branch name. Take the word out and try again; the gate never says which word it found.',
    );
  });

  it('blocks a push whose refspec creates a branch whose name holds a word', async () => {
    const git = fakeGit(cleanMessages, cleanPatches);
    const scan = pushRefusal(() => set('examplecorp'), git.exec, [
      '613-x',
      'refs/heads/examplecorp-x',
    ]);
    const refusal = await scan('/work/tree', 'origin');
    assert.match(refusal ?? '', /at branch name\./);
    assert.doesNotMatch(refusal ?? '', /examplecorp/i);
  });

  it('names the branch name once beside the commits that hold a word', async () => {
    const git = fakeGit(
      ok(`\0${sha}\nAda\nada@example.com\nAda\nada@example.com\nFor ExampleCorp\n`),
      cleanPatches,
      ok('examplecorp\torigin\n'),
    );
    const scan = pushRefusal(() => set('examplecorp'), git.exec, ['examplecorp']);
    const refusal = await scan('/work/tree');
    assert.match(refusal ?? '', /at branch name; commit aaaaaaa message line 1\./);
  });

  it('lets through branch names without a word', async () => {
    const git = fakeGit(cleanMessages, cleanPatches);
    const scan = pushRefusal(() => set('examplecorp'), git.exec, ['613-x', 'HEAD']);
    assert.equal(await scan('/work/tree', 'origin'), undefined);
  });

  it('blocks a refspec computed at run time while a list is set, and only then', async () => {
    const git = fakeGit(cleanMessages, cleanPatches);
    const refusal = await pushRefusal(() => set('examplecorp'), git.exec, [null])(
      '/work/tree',
      'origin',
    );
    assert.match(refusal ?? '', /^git push is blocked: a refspec is computed at run time/);
    assert.deepEqual(git.calls, []);
    const none = await pushRefusal(() => ({ kind: 'none', path: PATH }), git.exec, [null])(
      '/work/tree',
      'origin',
    );
    assert.equal(none, undefined);
  });

  for (const [remote, what] of [
    [null, 'computed at run time'],
    ['https://example.com/o/r.git', 'a URL or a path'],
    ['../mirror', 'a URL or a path'],
  ] as const) {
    it(`blocks a push to a remote ${what} while a list is set: ${remote}`, async () => {
      const git = fakeGit(cleanMessages, cleanPatches);
      const refusal = await pushRefusal(() => set('examplecorp'), git.exec)('/work/tree', remote);
      assert.match(refusal ?? '', /^git push is blocked: .*name the remote/);
      assert.deepEqual(git.calls, []);
      const none = await pushRefusal(() => ({ kind: 'none', path: PATH }), git.exec)(
        '/work/tree',
        remote,
      );
      assert.equal(none, undefined);
    });
  }

  it('blocks a push whose messages or added lines hold a word, naming places only', async () => {
    const git = fakeGit(
      ok(`\0${sha}\nAda\nada@example.com\nAda\nada@example.com\nFor ExampleCorp\n`),
      ok(`\0${sha}\n\ndiff --git a/plan.md b/plan.md\n@@ -0,0 +1,2 @@\n+a plan\n+exampleCorp\n`),
    );
    const refusal = await pushRefusal(() => set('examplecorp'), git.exec)('/work/tree');
    assert.match(refusal ?? '', /^git push is blocked: it would send a word on your denylist/);
    assert.match(refusal ?? '', /commit aaaaaaa message line 1; commit aaaaaaa plan\.md:2/);
    assert.doesNotMatch(refusal ?? '', /example ?corp/i);
  });

  // git's stderr arrives in chunks that need not end a line, so it can split an added line.
  it('reads only what git prints on stdout', async () => {
    const stdout = `\0${sha}\n\ndiff --git a/plan.md b/plan.md\n@@ -0,0 +1,2 @@\n+a plan\n+we ship to ExampleCorp\n`;
    const git = fakeGit(cleanMessages, {
      exitCode: 0,
      stdout,
      output: stdout.replace('Example', 'Example\nwarning: a note on stderr\n'),
    });
    const refusal = await pushRefusal(() => set('examplecorp'), git.exec)('/work/tree');
    assert.match(refusal ?? '', /commit aaaaaaa plan\.md:2/);
  });

  const failures: [string, ProcessOutcome, RegExp][] = [
    ['exits non-zero', { exitCode: 128, output: 'fatal: bad revision' }, /exited 128/],
    ['cannot start', { exitCode: null, output: '' }, /could not start/],
    [
      'times out',
      { exitCode: null, output: '', killed: 'timed-out' },
      new RegExp(`timed out after ${DENYLIST_GIT_TIMEOUT_MS / 1000} s`),
    ],
    [
      'passes the output limit',
      { exitCode: null, output: '', killed: 'too-much-output' },
      /more than 4 MiB of output/,
    ],
  ];
  for (const [name, outcome, why] of failures) {
    it(`blocks the push when git ${name}`, async () => {
      const git = fakeGit(outcome, cleanPatches);
      const refusal = await pushRefusal(() => set('examplecorp'), git.exec)('/work/tree');
      assert.match(refusal ?? '', /^git push is blocked: could not read the commits it would send/);
      assert.match(refusal ?? '', why);
    });
  }
});
