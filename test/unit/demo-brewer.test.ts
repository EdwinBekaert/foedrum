import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { type DemoBrewersOptions, demoBrewers } from '../../scripts/demo/brewer.ts';
import type { Life } from '../../scripts/demo/core.ts';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import type { AttemptStart } from '../../src/engine/brewer-runner.ts';
import { OutDocFrontmatter } from '../../src/schemas/out-doc.ts';
import type { Git, GitResult } from '../../src/workspace/git.ts';
import { NIP_SCRIPT } from '../helpers/nip-fixture.ts';

const cwd = resolve('/work/demo.web/attempts/1-1/gauge/1');
const startOf = (stepId: string, attempt: number): AttemptStart => ({
  ref: { batchId: '1-1', stepId, attempt },
  limits: { outDoc: { file: 'gauge.md', schema: OutDocFrontmatter } },
});
const start = startOf('gauge', 1);
const plan = async () => ({ cwd, prompt: 'Gauge the order' }) as unknown as ClaudeAttemptPlan;

/** The brewers with a git that answers `code` and records every call and write in `log`. */
const brewers = (life: Life, options: Partial<DemoBrewersOptions> = {}, code = 0) => {
  const log: string[] = [];
  const git: Git = async (at, args): Promise<GitResult> => {
    log.push(`git ${at} ${args.slice(0, 1).join(' ')}`);
    return { code, stdout: '', stderr: code === 0 ? '' : 'fatal: no identity' };
  };
  const runner = demoBrewers({
    plan,
    git,
    write: (path) => log.push(`write ${path}`),
    life,
    crash: () => log.push('crash'),
    ...options,
  });
  return { runner, log };
};

/** Lets every pending promise and git call settle. */
const settled = async () => {
  for (let n = 0; n < 5; n += 1) await new Promise((done) => setTimeout(done, 0));
};

describe('the demo brewers', () => {
  it("play the Gauger of the Nip fixture: its test and out doc, committed in the attempt's worktree", async () => {
    const prompts: string[] = [];
    const { runner, log } = brewers('finish', {
      brewed: (ref, prompt) => prompts.push(`${ref.stepId}#${ref.attempt} ${prompt}`),
    });
    const { ending } = await runner.start(start).ended;
    assert.equal(ending.kind, 'succeeded', JSON.stringify(ending));
    const files = Object.keys(NIP_SCRIPT.gauge?.[0]?.files ?? {});
    assert.deepStrictEqual(log, [
      ...files.map((file) => `write ${join(cwd, file)}`),
      `write ${join(cwd, 'gauge.md')}`,
      `git ${cwd} add`,
      `git ${cwd} commit`,
    ]);
    assert.deepStrictEqual(prompts, ['gauge#1 Gauge the order']);
  });

  it("play the Gauger's script for a retry of an attempt lost with an earlier process", async () => {
    const { runner } = brewers('finish');
    const { ending } = await runner.start(startOf('gauge', 2)).ended;
    assert.equal(ending.kind, 'succeeded', JSON.stringify(ending));
  });

  it('in the life that crashes, are killed once the commit is made, before the attempt ends', async () => {
    const { runner, log } = brewers('crash');
    let ended = false;
    void runner.start(start).ended.then(() => {
      ended = true;
    });
    await settled();
    assert.equal(log.at(-1), 'crash');
    assert.match(log.at(-2) ?? '', / commit$/);
    assert.equal(ended, false);
  });

  it('in the life that crashes, do not crash once the attempt was stopped while it committed', async () => {
    let commit = (): void => {};
    const log: string[] = [];
    const { runner } = brewers('crash', {
      git: async (_at, args) => {
        if (args[0] === 'commit') await new Promise<void>((done) => (commit = done));
        return { code: 0, stdout: '', stderr: '' };
      },
      crash: () => log.push('crash'),
    });
    const run = runner.start(start);
    await settled();
    // The engine stops the attempt (a deadline, or serve's own stop) while git still commits.
    run.stop();
    commit();
    const { ending } = await run.ended;
    assert.equal(ending.kind, 'cancelled', JSON.stringify(ending));
    assert.deepStrictEqual(log, []);
  });

  it('let the Cellar look at the attempt once it has started, before the brewer writes', async () => {
    let looked = (): void => {};
    const { runner, log } = brewers('finish', {
      started: async (ref) => {
        log.push(`started ${ref.stepId}#${ref.attempt}`);
        await new Promise<void>((done) => (looked = done));
      },
    });
    const run = runner.start(start);
    await settled();
    assert.deepStrictEqual(log, ['started gauge#1']);
    looked();
    const { ending } = await run.ended;
    assert.equal(ending.kind, 'succeeded', JSON.stringify(ending));
  });

  it('cancel an attempt stopped while the Cellar shows it, before the brewer writes', async () => {
    let looked = (): void => {};
    const { runner, log } = brewers('crash', {
      started: async () => {
        log.push('started');
        await new Promise<void>((done) => (looked = done));
      },
    });
    const run = runner.start(start);
    await settled();
    run.stop();
    looked();
    const { ending } = await run.ended;
    assert.equal(ending.kind, 'cancelled', JSON.stringify(ending));
    assert.deepStrictEqual(log, ['started']);
  });

  it('brew on when the Cellar cannot show the attempt: showing it never fails it', async () => {
    const { runner } = brewers('finish', {
      started: async () => {
        throw new Error('the store is locked');
      },
    });
    const { ending } = await runner.start(start).ended;
    assert.equal(ending.kind, 'succeeded', JSON.stringify(ending));
  });

  it('fail the attempt, not the tick, when git cannot commit, and do not crash', async () => {
    const { runner, log } = brewers('crash', {}, 128);
    const { ending } = await runner.start(start).ended;
    assert.equal(ending.kind, 'failed');
    assert.match(JSON.stringify(ending), /no identity/);
    assert.ok(!log.includes('crash'));
  });
});
