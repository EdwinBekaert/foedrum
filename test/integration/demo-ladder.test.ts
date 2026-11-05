// npm run demo -- ladder (ADR 0294), as the program: one order of a scratch Brewery planned across a
// library and an application, approved, its library's sub-order brewed, merged and released, its
// application's sub-order bumped to that release, both pull requests naming each other, and the
// order closed once both merged. Real git and node, no gh, no claude.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { codeHost, fileJournal } from '../../scripts/demo/code-host.ts';
import { LADDER_STEPS } from '../../scripts/demo/ladder.ts';
import { headingOf, STEPS } from '../../scripts/demo/walkthrough.ts';
import { effectKey } from '../../src/engine/effect-key.ts';
import { openSqliteEventStore } from '../../src/engine/sqlite-event-store.ts';
import { type ExecResult, execProcess } from '../../src/platform/processes.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { runGit } from '../../src/workspace/git.ts';
import { hangGuardMs } from '../helpers/load.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const root = join(import.meta.dirname, '..', '..');
const demo = join(root, 'scripts', 'demo.ts');
const LIB = 'demo/lib';
const WEB = 'demo/web';
const BREWERY = 'demo/brewery';

describe('npm run demo -- ladder', () => {
  let dir: TempDir;
  let scratch: string;
  /** The one run of the ladder every test reads. */
  let result: ExecResult;
  /** The code host the run left, opened on its journal with the ladder's issue and repositories. */
  const host = () =>
    codeHost(fileJournal(join(scratch, 'code-host.jsonl')), {
      issues: { [BREWERY]: [{ number: 1, labels: ['recipe:mash'], author: 'ann' }] },
      visibilities: { [LIB]: 'public', [WEB]: 'public' },
    });
  /** A file at `ref` in the scratch remote `<name>.git`. */
  const show = async (name: string, ref: string): Promise<string> => {
    const shown = await runGit(root, ['--git-dir', join(scratch, `${name}.git`), 'show', ref]);
    assert.equal(shown.code, 0, shown.stderr);
    return shown.stdout;
  };
  before(async () => {
    dir = makeTempDir('demo-ladder');
    scratch = join(dir.path, 'demo');
    // A machine with no git identity of its own, as the default demo's test makes it.
    const noIdentity = join(dir.path, 'gitconfig');
    writeFileSync(noIdentity, '[user]\n\tuseConfigOnly = true\n');
    const hostGit =
      /^(?:GIT_AUTHOR_|GIT_COMMITTER_|EMAIL$|GIT_CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS))/i;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !hostGit.test(name)),
    );
    result = await execProcess(process.execPath, [demo, 'ladder', '--in', scratch, '--no-pause'], {
      cwd: root,
      env: { ...env, GIT_CONFIG_GLOBAL: noIdentity, GIT_CONFIG_NOSYSTEM: '1' },
      // Only a guard against a hang (ADR 0075): four lives of the Cellar, and the plan's, its three
      // Tasters' and the two Cellarmen's attempts.
      timeoutMs: 10 * hangGuardMs,
    });
  });
  after(() => removeTree(dir.path));

  it('npm run demo -- ladder --no-pause ends with two pull requests that name each other', async () => {
    assert.equal(result.exitCode, 0, result.output);
    const pulls = (await host()).pulls();
    assert.deepStrictEqual(
      pulls.map(({ repo }) => repo),
      [LIB, WEB],
    );
    const [lib, web] = pulls;
    const section = (body: string) =>
      body.slice(0, body.indexOf('\n\n<!--') === -1 ? undefined : body.indexOf('\n\n<!--'));
    assert.match(section(lib?.body ?? ''), new RegExp(`^2\\. ${WEB}#${web?.number}: `, 'm'));
    assert.match(section(web?.body ?? ''), new RegExp(`^1\\. ${LIB}#${lib?.number}: merged`, 'm'));
    // The output shows both sections.
    assert.equal(result.stdout.split('## Pull requests of this order').length, 3, result.stdout);
  });

  it("the ladder's second pull request changes @demo/greet to 1.4.0 from the release input", async () => {
    assert.equal(result.exitCode, 0, result.output);
    // The library's CI tagged v1.4.0 on the commit that says 1.4.0.
    assert.match(await show('lib', 'v1.4.0:package.json'), /"version": "1\.4\.0"/);
    // The application's Cellarman was told the tag as written, and wrote the version it names.
    assert.match(
      result.stdout,
      /demo: the Cellarman of batch 3-1 is told the release it waited for, as \{release\}:\n +#### The release of demo\/lib that #3 waited for\n +- Tag, as written: v1\.4\.0\n/,
    );
    const web = (await host()).pulls().find(({ repo }) => repo === WEB);
    const manifest = await show('web', `${web?.head}:package.json`);
    assert.match(manifest, /"@demo\/greet": "1\.4\.0"/);
    assert.doesNotMatch(await show('web', 'main~1:package.json'), /1\.4\.0/);
  });

  it("the ladder's order issue is closed with its comment once both sub-orders merged", async () => {
    assert.equal(result.exitCode, 0, result.output);
    const opened = await host();
    const issue = (await (
      await opened.fetch(`https://api.github.com/repos/${BREWERY}/issues/1`)
    ).json()) as { state: string };
    assert.equal(issue.state, 'closed');
    const [lib, web] = opened.pulls();
    const closing = opened
      .comments(BREWERY, 1)
      .filter(({ body }) => body.startsWith('Every sub-order merged'));
    assert.equal(closing.length, 1, JSON.stringify(opened.comments(BREWERY, 1)));
    assert.match(
      closing[0]?.body ?? '',
      new RegExp(`^Every sub-order merged: ${LIB}#${lib?.number}, ${WEB}#${web?.number}\\. `),
    );
    // Both merges recorded before the order's close; each sub-issue closes on its own merge
    // (ADR 0296).
    const store = openSqliteEventStore(join(scratch, 'brewery', '.foedrum', 'index.db'));
    let types: string[];
    try {
      types = store.eventsAfter(0).flatMap(({ event }) => {
        if (event.type === 'pull_request.ended') return [`${event.batchId} ${event.state}`];
        if (event.type !== 'effect.applied') return [];
        const { batchId, effect } = effectKey.decode(event.key);
        return effect === 'close.issue' ? [`${batchId} closed`] : [];
      });
    } finally {
      store.close();
    }
    // The last sub-issue's close and the order's are due in the same tick, in either order.
    assert.deepStrictEqual(types.slice(0, 3), ['2-1 merged', '2-1 closed', '3-1 merged']);
    assert.deepStrictEqual(types.slice(3).sort(), ['1-1 closed', '3-1 closed']);
  });

  it('the default demo keeps its twelve steps beside the ladder', () => {
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(STEPS.length, 12);
    const headings = result.stdout.split(/\r?\n/).filter((line) => /^Step \d+ of \d+: /.test(line));
    assert.equal(headings.length, 14, headings.join('\n'));
    headings.forEach((heading, index) => {
      assert.ok(heading.startsWith(`Step ${index + 1} of 14: `), heading);
    });
    assert.ok(!result.stdout.includes(headingOf(0)), result.stdout);
  });

  it('each step of the ladder prints a line of its own (regression test)', () => {
    assert.equal(result.exitCode, 0, result.output);
    const at = LADDER_STEPS.map((_, index) =>
      result.stdout.indexOf(headingOf(index, LADDER_STEPS)),
    );
    /** The output of the step `id`, from its heading to the next one's. */
    const part = (id: string): string => {
      const n = LADDER_STEPS.findIndex((step) => step.id === id);
      return result.stdout.slice(at[n], at[n + 1]);
    };
    const lines: Record<string, RegExp[]> = {
      plan: [
        /demo: batch 1-1 waits Stuck for the review of its plan/,
        /Recipe \*\*mash\*\*, chosen by its label/,
        /`plan #1` ✅ → `coverage #1` ✅ → `sizing #1` ✅ → `naive-reader #1` ✅/,
        /\| `bump`:\s.* \| `ladder` \| `greet` \(release\) \| yes \|/,
      ],
      approve: [/\$ foedrum approve 1-1\n +1-1 on tap: plan approved by ann via terminal/],
      'sub-issues': [
        /sub-issue #3 of #1: .*\n +labels: foedrum:sub-order, recipe:ladder\n +blocked by: #2\n/,
      ],
      lib: [
        /foedrum serve: ordered demo\/brewery#2 as batch 2-1/,
        /demo: pull request #\d+ on demo\/lib: /,
      ],
      release: [
        /demo: ann merges demo\/lib#\d+ into main as [0-9a-f]{7}/,
        /tags it v1\.4\.0 on [0-9a-f]{7}/,
      ],
      released: [
        /foedrum serve: recorded the release v1\.4\.0 of demo\/lib/,
        /foedrum serve: ordered demo\/brewery#3 as batch 3-1/,
      ],
      'release-input': [/- Tag, as written: v1\.4\.0\n/, /- Merged pull request of #2: /],
      bump: [/^ +- +"@demo\/greet": "1\.3\.0"\n +\+ +"@demo\/greet": "1\.4\.0"$/m],
      web: [/demo: pull request #\d+ on demo\/web: /],
      siblings: [/demo: the body of demo\/lib#\d+ starts:\n +## Pull requests of this order/],
      merge: [/demo: ann merges demo\/web#\d+ into main as [0-9a-f]{7}/],
      done: [/\*\*Done\*\*: every sub-order merged/, /merged, released as v1\.4\.0/],
      closed: [
        /demo\/brewery#1 is closed/,
        /Every sub-order merged: demo\/lib#\d+, demo\/web#\d+\./,
      ],
      status: [/\$ foedrum status 1\n/, /planning: /],
    };
    assert.deepStrictEqual(
      Object.keys(lines),
      LADDER_STEPS.map(({ id }) => id),
    );
    for (const [id, patterns] of Object.entries(lines)) {
      for (const pattern of patterns) assert.match(part(id), pattern, `step ${id}`);
    }
  });

  it('the ladder demo prints the system map the Brewmaster reads', () => {
    assert.equal(result.exitCode, 0, result.output);
    const at = (index: number) => result.stdout.indexOf(headingOf(index, LADDER_STEPS));
    assert.match(
      result.stdout.slice(at(0), at(1)),
      /demo: the Brewmaster of batch 1-1 reads the system map, as \{repositories\}:\n.*?\n +publishes `@demo\/greet` \(npm\)\n.*?\n +depends on `@demo\/greet` from demo\/lib by version `1\.3\.0` \(npm\)\n/s,
    );
  });

  it("the ladder shows each issue's label and Next line at the plan review and once a sub-order is on tap (#777)", () => {
    assert.equal(result.exitCode, 0, result.output);
    const standing = (issue: number, label: string, next: string): RegExp =>
      new RegExp(
        `demo: demo/brewery#${issue}'s labels and next step:\\n +labels: [^\\n]*${label}[^\\n]*\\n +Next: ${next}`,
      );
    const { stdout } = result;
    assert.match(stdout, standing(1, 'foedrum:awaiting-approval', 'read the plan'));
    assert.match(
      stdout,
      standing(
        1,
        'foedrum:sub-orders',
        'nothing to do; the sub-orders brew \\(#2, #3\\), and each pull request comes to you on tap\\.',
      ),
    );
    assert.match(
      stdout,
      standing(
        2,
        'foedrum:awaiting-merge',
        'review and merge <https://github\\.com/demo/lib/pull/\\d+>\\.',
      ),
    );
    assert.doesNotMatch(stdout, /foedrum:on-tap/);
  });
});
