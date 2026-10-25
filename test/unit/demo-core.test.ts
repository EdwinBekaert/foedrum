import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';
import { describe, it } from 'node:test';
import { DEMO_GIT_CONFIG } from '../../scripts/demo/brewer.ts';
import {
  BREW_ON_TAP_LINE,
  BREW_ORDER,
  BREWERY,
  breweryFiles,
  CRASH_LINE,
  type DemoRun,
  DIAGNOSIS,
  gitConfig,
  gitEnvOf,
  lifeEndOf,
  localConfig,
  ON_TAP_LINE,
  ORDER,
  problemsOf,
  scratchFolder,
  TARGET,
} from '../../scripts/demo/core.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import type { BreweryFile, BreweryFiles } from '../../src/engine/recipe-files.ts';
import { parseJsonc } from '../../src/formats/jsonc.ts';
import type { Event } from '../../src/schemas/events.ts';

const root = resolve('/repo/.claude/worktrees/193-demo');
const tmp = join(root, '.foedrum', 'tmp');

describe('scratchFolder', () => {
  it('is .foedrum/tmp/demo in the checkout when none is asked for', () => {
    assert.equal(scratchFolder(root, undefined, resolve('/elsewhere')), join(tmp, 'demo'));
  });

  it('takes a folder inside the checkout .foedrum/tmp, resolved against the working directory', () => {
    assert.equal(
      scratchFolder(root, join('tmp', 'tests', 'd'), join(root, '.foedrum')),
      join(tmp, 'tests', 'd'),
    );
    assert.equal(scratchFolder(root, join(tmp, 'x'), resolve('/elsewhere')), join(tmp, 'x'));
  });

  it('refuses a folder outside .foedrum/tmp, or .foedrum/tmp itself', () => {
    for (const asked of [
      tmp,
      root,
      join(root, '.foedrum'),
      join(tmp, '..', 'demo'),
      resolve('/elsewhere', 'demo'),
      join(root, '.foedrum', 'tmpx'),
    ]) {
      assert.throws(() => scratchFolder(root, asked, root), /\.foedrum[\\/]tmp/, asked);
    }
  });

  it('refuses a folder on another drive, whose path relative to .foedrum/tmp is absolute', () => {
    const root = 'D:\\repo';
    assert.equal(win32.relative(win32.join(root, '.foedrum', 'tmp'), 'E:\\demo'), 'E:\\demo');
    assert.throws(
      () => scratchFolder(root, 'E:\\demo', root, win32),
      /works only in a folder inside D:\\repo\\\.foedrum\\tmp, not in E:\\demo/,
    );
  });

  it('refuses a Windows folder beside .foedrum/tmp, or .foedrum/tmp itself, on the same drive', () => {
    const root = 'D:\\repo';
    for (const asked of ['D:\\repo\\.foedrum\\other', 'D:\\repo\\.foedrum\\tmp', 'D:\\repo']) {
      assert.throws(
        () => scratchFolder(root, asked, root, win32),
        /works only in a folder inside D:\\repo\\\.foedrum\\tmp/,
        asked,
      );
    }
  });

  it('keeps a Windows folder inside .foedrum/tmp, asked from another drive or with a lower-case drive letter', () => {
    const root = 'D:\\repo';
    assert.equal(
      scratchFolder(root, 'D:\\repo\\.foedrum\\tmp\\x', 'E:\\', win32),
      'D:\\repo\\.foedrum\\tmp\\x',
    );
    assert.equal(
      scratchFolder(root, 'd:\\repo\\.foedrum\\tmp\\x', 'E:\\', win32),
      'd:\\repo\\.foedrum\\tmp\\x',
    );
  });
});

describe('the demo Brewery', () => {
  const work = resolve('/scratch/work');
  const clone = resolve('/scratch/web');
  /** The Brewery's files, and what serve makes of them, with `defaults` under them. */
  const demo = (defaults?: BreweryFiles['defaults']) => {
    const files = breweryFiles();
    const of = (folder: string): BreweryFile[] =>
      Object.entries(files)
        .filter(([path]) => path.startsWith(`${folder}/`))
        .map(([path, text]) => ({ path, text }));
    const ready = serveSetup({
      root: resolve('/scratch/brewery'),
      home: resolve('/scratch/home'),
      platform: process.platform,
      env: {},
      files: {
        config: files['foedrum.jsonc'],
        local: localConfig(work, clone),
        models: files['models.jsonc'],
        brewery: {
          recipes: of('recipes'),
          brewers: of('brewers'),
          ...(defaults === undefined ? {} : { defaults }),
        },
      },
      diagnosis: DIAGNOSIS,
    });
    return { files, ready };
  };

  it('is one serve accepts, with the work root and the clone it is given', () => {
    const { ready } = demo();
    assert.equal(ready.kind, 'ready', JSON.stringify(ready));
    if (ready.kind !== 'ready') return;
    const { setup } = ready;
    assert.equal(setup.brewery, BREWERY);
    assert.equal(setup.workRoot, work);
    assert.deepStrictEqual(
      setup.repositories.map(({ repo, source, clone: at }) => ({ repo, source, clone: at })),
      [{ repo: TARGET, source: 'local', clone }],
    );
    assert.equal(setup.sandbox, false);
  });

  it("is one serve accepts under Foedrum's own defaults, as serve reads them (ADR 0098)", () => {
    const { ready } = demo(readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')).defaults);
    assert.equal(ready.kind, 'ready', JSON.stringify(ready));
  });

  it("routes the order to the demo's own recipe, whose Gauger from Foedrum's defaults gets a second attempt after the crash", () => {
    const { ready } = demo(readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')).defaults);
    assert.equal(ready.kind, 'ready', JSON.stringify(ready));
    if (ready.kind !== 'ready') return;
    assert.deepStrictEqual(ORDER.labels, ['recipe:nip-parallel']);
    assert.ok(ready.setup.recipes.find('nip-parallel') !== undefined);
    const gauger = ready.setup.brewers.find('nip-parallel', 'gauge')?.brewer;
    assert.ok((gauger?.maxAttempts ?? 1) >= 2, JSON.stringify(gauger));
  });

  it("holds a recipe of Nip's steps with its taste step a parallel group of three lens steps (ADR 0168)", () => {
    const { files } = demo();
    const recipe = parseJsonc(files['recipes/nip-parallel.jsonc'] ?? '{}') as {
      name?: string;
      steps?: unknown[];
    };
    const nip = parseJsonc(
      readFileSync(join(FOEDRUM_DEFAULTS, 'recipes', 'nip.jsonc'), 'utf8'),
    ) as {
      steps: { id?: string }[];
    };
    assert.equal(recipe.name, 'nip-parallel');
    const group = {
      id: 'taste',
      parallel: [
        { id: 'correctness', brewer: 'taster', lens: 'diff/correctness' },
        { id: 'security', brewer: 'taster', lens: 'diff/security' },
        { id: 'test-design', brewer: 'taster', lens: 'diff/test-design' },
      ],
    };
    assert.deepStrictEqual(
      recipe.steps,
      nip.steps.map((step) => (step.id === 'taste' ? group : step)),
    );
  });

  it("loads the group with its three children in Nip's place of the taste step", () => {
    const { ready } = demo(readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')).defaults);
    if (ready.kind !== 'ready') assert.fail(JSON.stringify(ready));
    const recipe = ready.setup.recipes.find('nip-parallel');
    assert.deepStrictEqual(recipe?.children('taste'), ['correctness', 'security', 'test-design']);
    for (const child of ['correctness', 'security', 'test-design']) {
      assert.equal(ready.setup.brewers.find('nip-parallel', child)?.brewer.name, 'taster', child);
    }
    // Nip in Foedrum's defaults stays as it is: one Taster's step in a line.
    assert.equal(ready.setup.recipes.find('nip')?.children('taste'), undefined);
  });

  it('files the order foedrum brew brews unlabelled, so the Cellar leaves it', () => {
    assert.notEqual(BREW_ORDER.number, ORDER.number);
    assert.deepStrictEqual(BREW_ORDER.labels, []);
  });

  it('ignores its own .foedrum folder', () => {
    assert.match(demo().files['.gitignore'] ?? '', /^\.foedrum\/$/m);
  });
});

describe('problemsOf', () => {
  const pull = { title: ORDER.title, head: 'foedrum/demo.brewery/1-1/demo.web', base: 'main' };
  const comment = [{ author: 'cellar-bot', body: 'On tap' }];
  const run = (fields: Partial<DemoRun> = {}): DemoRun => ({
    crash: { exitCode: 1, output: `started\n${CRASH_LINE}\n` },
    restart: { exitCode: 0, output: `${ON_TAP_LINE}: https://example.test/pull/1\n` },
    brew: { exitCode: 0, output: `${BREW_ON_TAP_LINE}: https://example.test/pull/3\n` },
    pulls: [pull, pull],
    comments: new Map([
      [ORDER.number, comment],
      [BREW_ORDER.number, comment],
    ]),
    ...fields,
  });

  it('finds nothing in a run that crashed, came back and went on tap, and whose brew went on tap, each with one pull request and one comment', () => {
    assert.deepStrictEqual(problemsOf(run()), []);
  });

  it('says when the first life did not crash mid-attempt', () => {
    assert.match(
      problemsOf(run({ crash: { exitCode: 0, output: 'stopped\n' } })).join('\n'),
      /not killed mid-attempt/,
    );
    assert.match(
      problemsOf(run({ crash: { exitCode: 1, output: 'boom\n' } })).join('\n'),
      /not killed mid-attempt.*boom/s,
    );
  });

  it('says so when the runner killed the first life at its deadline, after the crash line', () => {
    const timedOut = { exitCode: null, output: `${CRASH_LINE}\n`, killed: 'timed-out' as const };
    assert.match(
      problemsOf(run({ crash: timedOut })).join('\n'),
      /not killed mid-attempt \(killed: timed-out\)/,
    );
  });

  it('says when the restart did not end with the batch on tap', () => {
    const problems = problemsOf(run({ restart: { exitCode: 1, output: 'the lock is held\n' } }));
    assert.match(problems.join('\n'), /not on tap.*the lock is held/s);
    const timedOut = { exitCode: null, output: '', killed: 'timed-out' as const };
    assert.match(problemsOf(run({ restart: timedOut })).join('\n'), /not on tap/);
  });

  it('says when foedrum brew did not end with its batch on tap', () => {
    const problems = problemsOf(run({ brew: { exitCode: 5, output: 'foedrum brew: refused\n' } }));
    assert.match(problems.join('\n'), /foedrum brew did not put batch 2-1 on tap.*refused/s);
    // Each half alone: a brew that ends well short of on tap, or fails after it.
    const stuck = { exitCode: 0, output: 'foedrum brew: batch 2-1 is stuck\n' };
    assert.match(problemsOf(run({ brew: stuck })).join('\n'), /did not put batch 2-1 on tap/);
    const failed = { exitCode: 1, output: `${BREW_ON_TAP_LINE}: https://example.test/pull/3\n` };
    assert.match(problemsOf(run({ brew: failed })).join('\n'), /did not put batch 2-1 on tap/);
  });

  it('says when foedrum status or replay failed, with what it said', () => {
    const problems = problemsOf(
      run({
        commands: [
          { argv: ['status'], exitCode: 0, stderr: '' },
          { argv: ['replay', '1-1'], exitCode: 1, stderr: 'foedrum replay: no batch 1-1\n' },
        ],
      }),
    );
    assert.deepStrictEqual(problems, [
      'foedrum replay 1-1 failed (exit code 1): foedrum replay: no batch 1-1',
    ]);
  });

  it('says so when a failed command wrote nothing to stderr', () => {
    const commands = [{ argv: ['status'], exitCode: 1, stderr: '\n' }];
    assert.deepStrictEqual(problemsOf(run({ commands })), [
      'foedrum status failed (exit code 1): (no output)',
    ]);
  });

  it('counts the pull requests, and the comments of each order', () => {
    assert.match(problemsOf(run({ pulls: [pull] })).join('\n'), /1 pull requests, not 2/);
    assert.match(
      problemsOf(run({ pulls: [pull, pull, pull] })).join('\n'),
      /3 pull requests, not 2/,
    );
    const doubled = new Map([
      [ORDER.number, [...comment, ...comment]],
      [BREW_ORDER.number, comment],
    ]);
    assert.deepStrictEqual(problemsOf(run({ comments: doubled })), [
      'order #1 has 2 status comments, not 1',
    ]);
    assert.deepStrictEqual(problemsOf(run({ comments: new Map([[ORDER.number, comment]]) })), [
      'order #2 has 0 status comments, not 1',
    ]);
  });
});

describe('lifeEndOf', () => {
  const url = 'https://github.com/demo/web/pull/2';
  const ordered = { type: 'batch.ordered', batchId: '1-1' };
  const onTap = { type: 'batch.on_tap', batchId: '1-1', pullRequests: [url] };
  const applied = (effect: string) => ({
    type: 'effect.applied',
    key: JSON.stringify(['1-1', effect]),
    result: null,
  });
  const stuck = {
    type: 'batch.stuck',
    batchId: '1-1',
    reason: { kind: 'attempts_exhausted', stepId: 'brew', attempts: 2, lastReason: 'no commit' },
    options: ['retry'],
  };
  const resumed = { type: 'batch.resumed', batchId: '1-1', by: 'ann', via: 'cli', action: 'retry' };
  const rewound = {
    type: 'batch.rewound',
    batchId: '1-1',
    toStepId: 'brew',
    by: 'ann',
    via: 'cli',
    shas: {},
  };
  const cancelled = { type: 'batch.cancelled', batchId: '1-1', by: 'ann', via: 'cli' };
  const of = (...events: object[]) => lifeEndOf(events.map((event) => ({ event: event as Event })));

  it('goes on while the batch brews, and while the on-tap revision of its comment is not applied', () => {
    assert.equal(of(), undefined);
    assert.equal(of(ordered, applied('status.1')), undefined);
    assert.equal(of(ordered, applied('status.1'), onTap), undefined);
    assert.equal(of(ordered, onTap, applied('pull_request')), undefined);
  });

  it('ends on tap, with the pull requests, once a status revision is applied after it', () => {
    assert.deepStrictEqual(of(ordered, applied('status.1'), onTap, applied('status.2')), {
      kind: 'on_tap',
      pullRequests: [url],
    });
  });

  it('ends at once when the batch is Stuck, with the reason, unless it was resumed', () => {
    const end = of(ordered, stuck);
    assert.equal(end?.kind, 'stuck');
    assert.match(end?.kind === 'stuck' ? end.reason : '', /attempts_exhausted.*brew.*no commit/);
    assert.equal(of(ordered, stuck, resumed), undefined);
  });

  it('goes on again once a Stuck batch is rewound', () => {
    assert.equal(of(ordered, stuck, rewound), undefined);
  });

  it('ends at once when the batch is cancelled', () => {
    assert.deepStrictEqual(of(ordered, cancelled), { kind: 'cancelled' });
  });
});

describe('gitConfig', () => {
  it('gives the demo its identity, no commit signing, and the target remote for its URL on GitHub', () => {
    const text = gitConfig('/scratch/demo/web.git');
    assert.match(text, /^\[user\]\n\tname = Demo brewer\n\temail = brewer@demo\.invalid\n/);
    assert.match(text, /^\[commit\]\n\tgpgsign = false$/m);
    assert.match(
      text,
      /^\[url "\/scratch\/demo\/web\.git"\]\n\tinsteadOf = https:\/\/github\.com\/demo\/web\.git$/m,
    );
    // The brewer commits with the same identity, whatever configuration its git reads.
    assert.ok(text.includes(`\tname = ${DEMO_GIT_CONFIG['user.name']}\n`), text);
    assert.ok(text.includes(`\temail = ${DEMO_GIT_CONFIG['user.email']}\n`), text);
    assert.ok(text.endsWith('\n'));
  });

  it('sends every other GitHub URL to a scratch path that does not exist, never to github.com', () => {
    const text = gitConfig(join('scratch', 'demo', 'web.git'));
    const sections = [...text.matchAll(/^\[url "(.+)"\]\n\tinsteadOf = (.+)$/gm)].map(
      ([, to = '', from = '']) => ({ to: to.replaceAll('\\\\', '\\'), from }),
    );
    assert.deepStrictEqual(sections, [
      { to: join('scratch', 'demo', 'web.git'), from: 'https://github.com/demo/web.git' },
      { to: join('scratch', 'demo', 'no-such-remote'), from: 'https://github.com/' },
    ]);
  });

  it('is the only configuration git reads: the global one is its file, and there is no system one', () => {
    assert.deepStrictEqual(gitEnvOf(join('scratch', 'demo')), {
      GIT_CONFIG_GLOBAL: join('scratch', 'demo', 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    });
  });

  it('escapes the backslashes and quotes of a Windows path in the URL section', () => {
    const text = gitConfig('D:\\a "b"\\web.git');
    assert.ok(text.includes('\n[url "D:\\\\a \\"b\\"\\\\web.git"]\n'), text);
  });
});
