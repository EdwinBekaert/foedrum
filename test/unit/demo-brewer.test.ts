import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { GREETING, scriptedBrewer } from '../../scripts/demo/brewer.ts';
import type { Life } from '../../scripts/demo/core.ts';
import type { AttemptStart } from '../../src/engine/brewer-runner.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import type { Git, GitResult } from '../../src/workspace/git.ts';

const cwd = resolve('/work/demo.web/attempts/1-1/brew/1');
const start: AttemptStart = {
  ref: { batchId: '1-1', stepId: 'brew', attempt: 1 },
  limits: { outDoc: { file: 'brew.md', schema: OutDocFrontmatter } },
};

/** The brewer with a git that answers `code` and records every call and write in `log`. */
const brewer = (life: Life, code = 0) => {
  const log: string[] = [];
  const git: Git = async (at, args): Promise<GitResult> => {
    log.push(`git ${at} ${args.join(' ')}`);
    return { code, stdout: '', stderr: code === 0 ? '' : 'fatal: no identity' };
  };
  const runner = scriptedBrewer({
    plan: async () => ({ cwd }),
    git,
    write: (path, text) => log.push(`write ${path} ${JSON.stringify(text)}`),
    life,
    crash: () => log.push('crash'),
  });
  return { runner, log };
};

/** Lets every pending promise and git call settle. */
const settled = () => new Promise((done) => setTimeout(done, 0));

describe('the demo brewer', () => {
  it('writes the greeting, commits it in the attempt worktree and succeeds', async () => {
    const { runner, log } = brewer('finish');
    const { ending } = await runner.start(start).ended;
    assert.equal(ending.kind, 'succeeded', JSON.stringify(ending));
    assert.equal(log[0], `write ${join(cwd, GREETING.file)} ${JSON.stringify(GREETING.text)}`);
    assert.deepStrictEqual(
      log.slice(1).map((line) => line.split(' ').slice(0, 3).join(' ')),
      [`git ${cwd} add`, `git ${cwd} commit`],
    );
    assert.ok(!log.includes('crash'));
  });

  it('in the life that crashes, is killed once the commit is made, before the attempt ends', async () => {
    const { runner, log } = brewer('crash');
    let ended = false;
    const run = runner.start(start);
    void run.ended.then(() => {
      ended = true;
    });
    await settled();
    await settled();
    assert.equal(log.at(-1), 'crash');
    assert.match(log.at(-2) ?? '', / commit /);
    assert.equal(ended, false);
    // Running until then, as a brewer whose process the crash took with it.
    assert.ok(runner.progress(start.ref) !== undefined);
  });

  it('fails the attempt, not the tick, when git cannot commit, and does not crash', async () => {
    const { runner, log } = brewer('crash', 128);
    const { ending } = await runner.start(start).ended;
    assert.equal(ending.kind, 'failed');
    assert.match(JSON.stringify(ending), /no identity/);
    assert.ok(!log.includes('crash'));
  });
});
