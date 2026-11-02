import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { DIAGNOSIS } from '../../scripts/demo/core.ts';
import {
  demoPart,
  LADDER_ORDER,
  LADDER_STEPS,
  ladderBreweryFiles,
  ladderGitConfig,
  ladderLifeEnd,
  ladderLocalConfig,
  ladderProblems,
  ladderTick,
  PLANNED,
  runLadder,
  siblingSection,
} from '../../scripts/demo/ladder.ts';
import {
  ALIASES,
  bumped,
  GREET_FR,
  LADDER_RECIPE,
  LIB,
  ladderBrewers,
  PACKAGE,
  planFrom,
  releaseLines,
  turnOf,
  VERSION,
  WEB,
} from '../../scripts/demo/ladder-brewers.ts';
import { stepLines } from '../../scripts/demo/walkthrough.ts';
import type { ProcessOutcome } from '../../scripts/process-runner.ts';
import type { ClaudeAttemptPlan } from '../../src/brewers/claude-runner.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import type { AttemptStart } from '../../src/engine/brewer-runner.ts';
import { FOEDRUM_DEFAULTS, readBreweryFiles } from '../../src/engine/brewery-files.ts';
import type { BreweryFile } from '../../src/engine/recipe-files.ts';
import type { Event } from '../../src/schemas/events.ts';
import { PullRequestOutDoc } from '../../src/schemas/out-doc.ts';
import { PlanOutDoc } from '../../src/schemas/plan.ts';
import type { Git, GitResult } from '../../src/workspace/git.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const libManifest = `${JSON.stringify({ name: PACKAGE, version: VERSION })}\n`;
const webManifest = `${JSON.stringify({ name: 'web', dependencies: { [PACKAGE]: VERSION } }, null, 2)}\n`;

/** A prompt whose `release` input names `tag`, between the tags the prompt wraps inputs in. */
const promptWith = (tag: string): string =>
  [
    'Make the change.',
    '<untrusted-input-ab12 source="the release a blocker waited for" name="release">',
    `#### The release of ${LIB} that #3 waited for`,
    `- Tag, as written: ${tag}`,
    '- Notes:',
    '',
    'French.',
    '</untrusted-input-ab12>',
    'Write your out doc.',
  ].join('\n');

describe("the ladder's Brewmaster", () => {
  it('plans a sub-order in the library and one in the application that waits for its release', () => {
    const doc = planFrom(libManifest, webManifest).doc as {
      subOrders: {
        id: string;
        repo: string;
        recipe: string;
        touches: { path: string }[];
        dependencies?: unknown;
      }[];
    };
    assert.deepStrictEqual(
      doc.subOrders.map(({ id, repo, recipe, touches, dependencies }) => ({
        id,
        repo,
        recipe,
        touches: touches.map(({ path }) => path),
        dependencies,
      })),
      [
        {
          id: 'greet',
          repo: LIB,
          recipe: LADDER_RECIPE,
          touches: ['greet.mjs'],
          dependencies: undefined,
        },
        {
          id: 'bump',
          repo: WEB,
          recipe: LADDER_RECIPE,
          touches: ['package.json'],
          dependencies: [{ on: 'greet', kind: 'release' }],
        },
      ],
    );
  });

  it('names the version the application pins, read from its manifest', () => {
    const pinned = webManifest.replace(VERSION, '0.9.2');
    assert.match(
      JSON.stringify(planFrom(libManifest.replace(VERSION, '0.9.2'), pinned).doc),
      /not on 0\.9\.2/,
    );
  });

  it('refuses to plan without the library manifest', () => {
    assert.throws(() => planFrom(undefined, webManifest), /no lib\/package\.json/);
  });

  it('refuses to plan without the application manifest', () => {
    assert.throws(() => planFrom(libManifest, undefined), /no lib\/package\.json, or no web/);
  });

  it('refuses to plan when the application does not depend on the library', () => {
    const other = webManifest.replace(PACKAGE, '@demo/other');
    assert.throws(() => planFrom(libManifest, other), /no web\/package\.json that depends on it/);
  });

  it("reads each repository's manifest in the folder named by its alias", () => {
    const read: string[] = [];
    const files: Record<string, string> = {
      [join(ALIASES[LIB], 'package.json')]: libManifest,
      [join(ALIASES[WEB], 'package.json')]: webManifest,
    };
    turnOf(
      'plan',
      (path) => {
        read.push(path);
        return files[path];
      },
      '',
    );
    assert.deepStrictEqual(read, [join('lib', 'package.json'), join('web', 'package.json')]);
  });
});

describe("the ladder's Cellarman", () => {
  it("changes greet in the library's worktree", () => {
    const turn = turnOf(
      'implement',
      (path) => (path === 'package.json' ? libManifest : undefined),
      '',
    );
    assert.deepStrictEqual(turn.files, { 'greet.mjs': GREET_FR });
  });

  it("bumps the library in the application's worktree to the release its prompt names", () => {
    const turn = turnOf('implement', () => webManifest, promptWith('v2.7.1'));
    assert.equal(turn.files['package.json'], webManifest.replace(`"${VERSION}"`, '"2.7.1"'));
  });

  it('refuses a step it has no brewer for', () => {
    assert.throws(() => turnOf('gauge', () => webManifest, ''), /no brewer for step gauge/);
  });
});

describe('bumped', () => {
  it('writes the tag without its v', () => {
    assert.match(bumped(webManifest, promptWith('v1.4.0')), /"@demo\/greet": "1\.4\.0"/);
  });

  it('writes a tag with no v as it is', () => {
    assert.match(bumped(webManifest, promptWith('3.0.0')), /"@demo\/greet": "3\.0\.0"/);
  });

  it('refuses a prompt that names no release', () => {
    assert.throws(() => bumped(webManifest, 'Make the change.'), /names no release/);
  });

  it('refuses a manifest that does not pin the library', () => {
    assert.throws(() => bumped('{}\n', promptWith('v1.4.0')), /package\.json has no/);
  });
});

describe('releaseLines', () => {
  it('reads the release input between its tags', () => {
    assert.deepStrictEqual(releaseLines(promptWith('v1.4.0')), [
      `#### The release of ${LIB} that #3 waited for`,
      '- Tag, as written: v1.4.0',
      '- Notes:',
      '',
      'French.',
    ]);
  });

  it('reads nothing without a release input', () => {
    assert.deepStrictEqual(
      releaseLines(
        '<untrusted-input-ab12 source="x" name="order">\n- Tag, as written: v1\n</untrusted-input-ab12>',
      ),
      [],
    );
  });
});

describe('the ladder steps', () => {
  it('go from the plan to foedrum status of the order, fourteen of them', () => {
    assert.deepStrictEqual(
      LADDER_STEPS.map(({ id }) => id),
      [
        'plan',
        'approve',
        'sub-issues',
        'lib',
        'release',
        'released',
        'release-input',
        'bump',
        'web',
        'siblings',
        'merge',
        'done',
        'closed',
        'status',
      ],
    );
  });

  it('are numbered out of fourteen in their headings', () => {
    assert.equal(
      stepLines(13, LADDER_STEPS)[1],
      `Step 14 of 14: foedrum status ${LADDER_ORDER.number}`,
    );
  });

  it('say what to look for in at most two lines of at most 80 characters', () => {
    assert.ok(LADDER_STEPS.length > 0);
    LADDER_STEPS.forEach((_, index) => {
      const lines = stepLines(index, LADDER_STEPS).slice(2);
      assert.ok(lines.length <= 2, lines.join('\n'));
      for (const line of lines) assert.ok(line.length <= 80, line);
    });
  });

  it('say that the label chose the recipe and the plan comment names a recipe per sub-order', () => {
    const plan = LADDER_STEPS[0]?.lookFor ?? '';
    assert.match(plan, /recipe:mash/);
    assert.match(plan, /chosen by its label/);
    assert.match(plan, /each with its recipe/);
  });
});

describe("the ladder's Brewery", () => {
  const work = resolve('/scratch/work');
  const clones = { [LIB]: resolve('/scratch/lib'), [WEB]: resolve('/scratch/web') };

  it('is one serve accepts, both repositories by their aliases with their clones, and the ladder recipe', () => {
    const files = ladderBreweryFiles();
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
        local: ladderLocalConfig(work, clones),
        models: files['models.jsonc'],
        brewery: {
          recipes: of('recipes'),
          brewers: of('brewers'),
          defaults: readBreweryFiles(join(FOEDRUM_DEFAULTS, 'no-such-brewery')).defaults ?? {},
        },
      },
      diagnosis: DIAGNOSIS,
    });
    assert.equal(ready.kind, 'ready', JSON.stringify(ready));
    if (ready.kind !== 'ready') return;
    assert.deepStrictEqual(
      ready.setup.repositories.map(({ repo, alias, clone }) => ({ repo, alias, clone })),
      [
        { repo: LIB, alias: 'lib', clone: clones[LIB] },
        { repo: WEB, alias: 'web', clone: clones[WEB] },
      ],
    );
    assert.notEqual(ready.setup.recipes.find(LADDER_RECIPE), undefined);
  });

  it("sends each repository's GitHub URL to its own remote, and every other to none", () => {
    const scratch = resolve('/scratch');
    const config = ladderGitConfig(scratch);
    const rewrites = [...config.matchAll(/\[url "([^"]+)"\]\n\tinsteadOf = (\S+)/g)].map(
      ([, to, from]) => [from, to?.replaceAll('\\\\', '\\')],
    );
    assert.deepStrictEqual(rewrites, [
      [`https://github.com/${LIB}.git`, join(scratch, 'lib.git')],
      [`https://github.com/${WEB}.git`, join(scratch, 'web.git')],
      ['https://github.com/', join(scratch, 'no-such-remote')],
    ]);
  });
});

describe('ladderLifeEnd', () => {
  const routeBy = '2026-11-02T10:00:00.000Z';
  const ordered = (batchId: string, parentBatchId?: string): object => ({
    type: 'batch.ordered',
    batchId,
    order: { issue: Number(batchId.split('-')[0]) },
    ...(parentBatchId === undefined ? {} : { parentBatchId }),
    routeBy,
  });
  const onTap = (batchId: string): object => ({
    type: 'batch.on_tap',
    batchId,
    pullRequests: [`https://github.com/${LIB}/pull/${batchId.length}`],
  });
  const stuck = (batchId: string): object => ({
    type: 'batch.stuck',
    batchId,
    reason: {
      kind: 'attempts_exhausted',
      stepId: 'implement',
      attempts: 2,
      lastReason: 'no commit',
    },
    options: ['retry'],
  });
  const applied = (batchId: string, effect: string): object => ({
    type: 'effect.applied',
    key: JSON.stringify([batchId, effect]),
    result: null,
  });
  const of = (life: Parameters<typeof ladderLifeEnd>[0], ...events: object[]) =>
    ladderLifeEnd(
      life,
      events.map((event) => ({ event: event as Event })),
    ).kind;

  it("ends the plan's life once the planned batch is Stuck", () => {
    assert.equal(of('plan', ordered(PLANNED)), 'brewing');
    assert.equal(of('plan', ordered(PLANNED), stuck(PLANNED)), 'ended');
  });

  it('fails a later life when the planned batch is Stuck', () => {
    assert.equal(of('lib', ordered(PLANNED), stuck(PLANNED)), 'failed');
  });

  it("ends the library's life once one sub-order's batch is on tap", () => {
    const planned = [ordered(PLANNED), onTap(PLANNED), ordered('2-1', PLANNED)];
    assert.equal(of('lib', ...planned), 'brewing');
    assert.equal(of('lib', ...planned, onTap('2-1')), 'ended');
  });

  it("counts only the planned order's sub-orders as its own", () => {
    assert.equal(
      of('lib', ordered(PLANNED), onTap(PLANNED), ordered('9-1'), onTap('9-1')),
      'brewing',
    );
  });

  it("ends the application's life once both sub-orders' batches are on tap", () => {
    const first = [ordered(PLANNED), onTap(PLANNED), ordered('2-1', PLANNED), onTap('2-1')];
    assert.equal(of('web', ...first, ordered('3-1', PLANNED)), 'brewing');
    assert.equal(of('web', ...first, ordered('3-1', PLANNED), onTap('3-1')), 'ended');
  });

  it('fails a life at once when a sub-order is Stuck or cancelled', () => {
    const planned = [ordered(PLANNED), onTap(PLANNED), ordered('2-1', PLANNED)];
    assert.equal(of('lib', ...planned, stuck('2-1')), 'failed');
    const cancelled = { type: 'batch.cancelled', batchId: '2-1', by: 'ann', via: 'cli' };
    assert.equal(of('web', ...planned, cancelled), 'failed');
  });

  it("ends the close's life once the planned batch's issue close is applied", () => {
    const planned = [ordered(PLANNED), onTap(PLANNED)];
    assert.equal(of('close', ...planned, applied(PLANNED, 'close.comment')), 'brewing');
    assert.equal(
      of('close', ...planned, ordered('2-1', PLANNED), applied('2-1', 'close.issue')),
      'brewing',
    );
    assert.equal(of('close', ...planned, applied(PLANNED, 'close.issue')), 'ended');
  });
});

describe('siblingSection', () => {
  it("reads the section that names the order's other pull requests, to the next heading", () => {
    const body = [
      '## Pull requests of this order',
      'This pull request is one of 2.',
      '1. demo/web#7: open.',
      '',
      '<!-- foedrum -->',
      '',
      '## Summary',
      'Greets in French.',
    ].join('\n');
    assert.deepStrictEqual(siblingSection(body), [
      '## Pull requests of this order',
      'This pull request is one of 2.',
      '1. demo/web#7: open.',
    ]);
  });

  it('reads nothing from a body without the section', () => {
    assert.deepStrictEqual(siblingSection('## Summary\nGreets.'), []);
  });
});

describe('ladderProblems', () => {
  const life = (exitCode: number, output = ''): ProcessOutcome =>
    ({ exitCode, output, stdout: output, stderr: '' }) as ProcessOutcome;
  const section = (other: string) => `## Pull requests of this order\n1. ${other}#7: open.\n`;
  const good = {
    lives: new Map([['plan', life(0)]] as const),
    pulls: [
      { repo: LIB, body: section(WEB) },
      { repo: WEB, body: section(LIB) },
    ],
    orderState: 'closed',
    failedCommands: [],
  };

  it('finds none in a run that ended as it should', () => {
    assert.deepStrictEqual(ladderProblems(good), []);
  });

  it('names a life that failed, with its last lines', () => {
    const lives = new Map([
      ['web', life(1, 'demo: batch 3-1 is Stuck: attempts_exhausted\n')],
    ] as const);
    assert.deepStrictEqual(ladderProblems({ ...good, lives }), [
      "the Cellar's web life ended with exit code 1:\ndemo: batch 3-1 is Stuck: attempts_exhausted",
    ]);
  });

  it('names a pull request that does not name the other', () => {
    const pulls = [good.pulls[0] ?? assert.fail(), { repo: WEB, body: 'Greets.' }];
    assert.deepStrictEqual(ladderProblems({ ...good, pulls }), [
      `the pull request on ${WEB} does not name the one on ${LIB}`,
    ]);
  });

  it('counts the pull requests', () => {
    assert.deepStrictEqual(ladderProblems({ ...good, pulls: good.pulls.slice(0, 1) }), [
      'the code host has 1 pull requests, not 2',
    ]);
  });

  it('names an order left open, and each command that failed', () => {
    assert.deepStrictEqual(
      ladderProblems({
        ...good,
        orderState: 'open',
        failedCommands: ['foedrum approve 1-1 failed (exit code 1)'],
      }),
      ['order #1 is open, not closed', 'foedrum approve 1-1 failed (exit code 1)'],
    );
  });
});

describe('ladderBrewers', () => {
  const cwd = resolve('/work/attempts/2-1/implement/1');
  const startOf = (stepId: string, schema: AttemptStart['limits']['outDoc']['schema']) => ({
    ref: { batchId: '2-1', stepId, attempt: 1 },
    limits: { outDoc: { file: `${stepId}.md`, schema } },
  });
  /** The brewers in `cwd`, whose files are `files`, with a git that answers `code`. */
  const brewers = (files: Record<string, string>, code = 0, prompt = '') => {
    const log: string[] = [];
    const git: Git = async (at, args): Promise<GitResult> => {
      log.push(`git ${at} ${args[0]}`);
      return { code, stdout: '', stderr: code === 0 ? '' : 'fatal: no identity' };
    };
    const runner = ladderBrewers({
      plan: async () => ({ cwd, prompt }) as unknown as ClaudeAttemptPlan,
      git,
      read: (path) => files[path],
      write: (path) => log.push(`write ${path}`),
    });
    return { runner, log };
  };

  it("commits the library's change in its worktree, and counts its commit (regression test)", async () => {
    const { runner, log } = brewers({ [join(cwd, 'package.json')]: libManifest });
    const end = await runner.start(startOf('implement', PullRequestOutDoc)).ended;
    assert.equal(end.ending.kind, 'succeeded', JSON.stringify(end));
    assert.deepStrictEqual(log, [
      `write ${join(cwd, 'greet.mjs')}`,
      `write ${join(cwd, 'implement.md')}`,
      `git ${cwd} add`,
      `git ${cwd} commit`,
    ]);
  });

  it('plans from the folder of checkouts and commits nothing (regression test)', async () => {
    const { runner, log } = brewers({
      [join(cwd, 'lib', 'package.json')]: libManifest,
      [join(cwd, 'web', 'package.json')]: webManifest,
    });
    const end = await runner.start(startOf('plan', PlanOutDoc)).ended;
    assert.equal(end.ending.kind, 'succeeded', JSON.stringify(end));
    assert.deepStrictEqual(log, [`write ${join(cwd, 'plan.md')}`]);
  });

  it("fails the attempt without a retry when git cannot commit, with git's reason (regression test)", async () => {
    const { runner } = brewers({ [join(cwd, 'package.json')]: libManifest }, 128);
    const { ending } = await runner.start(startOf('implement', PullRequestOutDoc)).ended;
    assert.deepStrictEqual(ending, {
      kind: 'failed',
      retryable: false,
      reason: 'the scripted brewer could not brew: git add: fatal: no identity',
    });
  });

  it('fails the attempt without a retry when the application has no release to bump to (regression test)', async () => {
    const { runner, log } = brewers({ [join(cwd, 'package.json')]: webManifest });
    const { ending } = await runner.start(startOf('implement', PullRequestOutDoc)).ended;
    assert.equal(ending.kind, 'failed');
    assert.match(ending.kind === 'failed' ? ending.reason : '', /names no release/);
    assert.deepStrictEqual(log, []);
  });

  it('ends a stopped attempt cancelled (regression test)', async () => {
    const { runner } = brewers({ [join(cwd, 'package.json')]: libManifest });
    const running = runner.start(startOf('implement', PullRequestOutDoc));
    running.stop();
    assert.deepStrictEqual((await running.ended).ending, { kind: 'cancelled' });
  });
});

describe('ladderTick', () => {
  const ended = { kind: 'ended', line: 'demo: batch 2-1 is on tap' } as const;

  it('waits while the life brews, quiet or not', () => {
    assert.equal(ladderTick({ kind: 'brewing' }, true), 'wait');
    assert.equal(ladderTick({ kind: 'brewing' }, false), 'wait');
  });

  it('waits for a quiet tick after the life reached its end, so its last effects are applied', () => {
    assert.equal(ladderTick(ended, false), 'wait');
    assert.equal(ladderTick(ended, true), 'end');
  });

  it('ends a failed life at once', () => {
    assert.equal(
      ladderTick({ kind: 'failed', line: 'demo: batch 2-1 was cancelled' }, false),
      'end',
    );
  });
});

describe('demoPart', () => {
  it('is the default demo without an argument, and the ladder with ladder', () => {
    assert.equal(demoPart([]), 'default');
    assert.equal(demoPart(['ladder']), 'ladder');
  });

  it('is none for any other argument, or one more after ladder', () => {
    assert.equal(demoPart(['ladr']), undefined);
    assert.equal(demoPart(['ladder', 'x']), undefined);
    assert.equal(demoPart(['x', 'ladder']), undefined);
  });
});

describe('runLadder', () => {
  /** A run on a shell whose `life` fails and whose `command` fails, and what it said and started. */
  const run = async (failing: { life?: string; command?: string }) => {
    const dir = makeTempDir('demo-ladder-shell');
    const said: string[] = [];
    const lives: string[] = [];
    try {
      const code = await runLadder({
        scratch: dir.path,
        say: (line) => said.push(line),
        pause: async () => {},
        write: () => {},
        git: async () => '',
        repository: async (name) => join(dir.path, name),
        foedrum: async (_brewery, argv) => (argv[0] === failing.command ? 1 : 0),
        live: async (life) => {
          lives.push(life);
          const exitCode = life === failing.life ? 1 : 0;
          const output = exitCode === 0 ? '' : 'demo: batch 1-1 is Stuck: attempts_exhausted\n';
          return { exitCode, output, stdout: output, stderr: '' } as ProcessOutcome;
        },
      });
      return { code, said, lives };
    } finally {
      dir.remove();
    }
  };

  it('stops at a life that failed, and says which and why', async () => {
    const { code, said, lives } = await run({ life: 'plan' });
    assert.equal(code, 1);
    assert.deepStrictEqual(lives, ['plan']);
    assert.ok(
      said.includes(
        "demo: the Cellar's plan life ended with exit code 1:\ndemo: batch 1-1 is Stuck: attempts_exhausted",
      ),
      said.join('\n'),
    );
  });

  it('stops at a foedrum command that failed, and says which', async () => {
    const { code, said, lives } = await run({ command: 'approve' });
    assert.equal(code, 1);
    assert.deepStrictEqual(lives, ['plan']);
    assert.ok(said.includes('demo: foedrum approve 1-1 failed (exit code 1)'), said.join('\n'));
  });
});
