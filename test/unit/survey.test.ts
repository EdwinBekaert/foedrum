// The Maltster's survey around the brewer runner (ADR 0282, ADR 0298): a survey needs no session
// when the base's test map is fresh or the Brewery keeps it, and the Maltster's commits may change
// the test map only, through injected maps, manifests, git and an inner runner (ADR 0021).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { surveyed } from '../../src/checks/survey.ts';
import type { ManifestFreshness, MapRead } from '../../src/checks/test-map.ts';
import type { AttemptEnd, AttemptStart, BrewerRunner } from '../../src/engine/brewer-runner.ts';
import { fold } from '../../src/engine/fold.ts';
import type { Event } from '../../src/schemas/events.ts';
import { readOutDoc, SurveyOutDoc } from '../../src/schemas/out-doc.ts';
import type { TestMap } from '../../src/schemas/test-map.ts';

const worktree = join('/work', 'acme.api', 'attempts', '12-1', 'survey', '1');
const clone = join('/work', 'acme.api', 'clone.git');
const ref = { batchId: '12-1', stepId: 'survey', attempt: 1 };
const deadlineAt = '2026-10-31T12:30:00.000Z';
const base = 'a'.repeat(40);

const events: Event[] = [
  { type: 'batch.ordered', batchId: '12-1', order: { issue: 12 }, routeBy: deadlineAt },
  { type: 'batch.recipe_chosen', batchId: '12-1', recipe: 'nip', reason: 'l', source: 'label' },
  { type: 'step.scheduled', ...ref, deadlineAt },
  {
    type: 'step.started',
    ...ref,
    worktree: { repo: 'acme/api', path: worktree, branch: 'foedrum/12-1/survey/1', commit: base },
  },
];

const map: TestMap = {
  derivedFrom: { globs: ['**/package.json'], paths: ['package.json'] },
  modules: [
    {
      name: 'api',
      code: ['src/**'],
      tests: { paths: ['test/**'] },
      testReport: { format: 'tap', path: 'reports/test.tap' },
      coverage: 'none',
    },
  ],
};

const proposed: AttemptEnd = {
  ending: {
    kind: 'succeeded',
    output: { status: 'done', summary: 'Proposed the test map', map: 'new' },
  },
};

const setup = ({
  read = { kind: 'none' } as MapRead,
  keptIn = 'repo' as 'repo' | 'brewery',
  manifests = { kind: 'fresh' } as ManifestFreshness,
  /** What the inner runner's attempt ends with. */
  inner = proposed,
  /** The files git says the attempt's commits changed. */
  changed = ['.foedrum/test-map.jsonc'],
} = {}) => {
  const asked: string[] = [];
  const started: AttemptStart[] = [];
  const runner: BrewerRunner = {
    start: (attempt) => {
      started.push(attempt);
      return { ended: Promise.resolve(inner), stop: () => {} };
    },
    progress: () => undefined,
  };
  const survey = surveyed({
    runner,
    state: () => fold(events),
    surveys: ({ stepId }) => stepId === 'survey',
    mapOnly: ({ stepId }) => stepId === 'survey',
    testMap: async (repo, commit) => {
      asked.push(`map of ${repo} at ${commit}`);
      return read;
    },
    keptIn: () => keptIn,
    manifests: async (root, read) => {
      asked.push(`manifests ${read.derivedFrom.globs.join(' ')} in ${root}`);
      return manifests;
    },
    git: async (cwd, args) => {
      asked.push(`git ${args.join(' ')} in ${cwd}`);
      return { code: 0, stdout: changed.map((path) => `${path}\0`).join(''), stderr: '' };
    },
    clone: () => clone,
  });
  const run = () =>
    survey.start({ ref, limits: { outDoc: { file: 'survey.md', schema: SurveyOutDoc } } }).ended;
  return { run, asked, started };
};

/** The map an end's out doc says the survey left, read as the driver keeps it. */
const mapOfDoc = (end: AttemptEnd): string | undefined => {
  assert.ok(end.outDoc !== undefined, 'the end carries its out doc');
  const read = readOutDoc(end.outDoc, SurveyOutDoc);
  assert.ok(read.valid, read.valid ? '' : read.reason);
  return read.frontmatter.status === 'done' ? read.frontmatter.map : undefined;
};

describe('surveyed: the Maltster runs only for a missing or stale map (ADR 0298)', () => {
  it("skips the survey when the base's map is fresh, with no session", async () => {
    const { run, asked, started } = setup({ read: { kind: 'map', map } });
    const end = await run();
    assert.deepEqual(started, []);
    assert.equal(end.ending.kind, 'succeeded');
    assert.equal(mapOfDoc(end), 'fresh');
    assert.deepEqual(
      end.ending.kind === 'succeeded' && (end.ending.output as { map?: string }).map,
      'fresh',
    );
    assert.deepEqual(asked, [
      `map of acme/api at ${base}`,
      `manifests **/package.json in ${worktree}`,
    ]);
  });

  it('a survey under the Brewery fallback ends without a session', async () => {
    const { run, asked, started } = setup({ keptIn: 'brewery' });
    const end = await run();
    assert.deepEqual(started, []);
    assert.equal(end.ending.kind, 'succeeded');
    assert.equal(mapOfDoc(end), 'brewery');
    // A survey cannot write the Brewery: its map is not even read.
    assert.deepEqual(asked, []);
  });

  it("runs the Maltster's session when the base has no map, and takes its commit of the test map", async () => {
    const { run, asked, started } = setup();
    const end = await run();
    assert.equal(started.length, 1);
    assert.deepEqual(end, proposed);
    assert.deepEqual(asked, [
      `map of acme/api at ${base}`,
      `git diff --name-only -z --no-renames ${base} refs/heads/foedrum/12-1/survey/1 in ${clone}`,
    ]);
  });

  it("runs the Maltster's session when the base's map is stale by its manifests", async () => {
    const stale: ManifestFreshness = { kind: 'stale', added: ['svc/package.json'], removed: [] };
    const { run, started } = setup({ read: { kind: 'map', map }, manifests: stale });
    const end = await run();
    assert.equal(started.length, 1);
    assert.deepEqual(end, proposed);
  });

  it("runs the Maltster's session when the base's map cannot be read", async () => {
    const { run, started } = setup({ read: { kind: 'unreadable', reason: 'not JSON' } });
    await run();
    assert.equal(started.length, 1);
  });

  it('blocks the survey on its environment when the manifests cannot be listed', async () => {
    const unread = { kind: 'unread', reason: 'fatal: not a git repository' } as const;
    const { run, started } = setup({ read: { kind: 'map', map }, manifests: unread });
    const end = await run();
    assert.deepEqual(started, []);
    assert.deepEqual(end.ending, {
      kind: 'blocked',
      blockerKind: 'environment',
      summary:
        'the manifests of the test map of acme/api cannot be listed: fatal: not a git repository',
    });
  });

  it('the Maltster may change only the test map', async () => {
    const { run } = setup({ changed: ['.foedrum/test-map.jsonc', 'src/app.ts', 'package.json'] });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: true,
      reason:
        'the guard testMapOnly: the attempt changed src/app.ts, package.json; it may change .foedrum/test-map.jsonc only (ADR 0298)',
    });
  });

  it('fails a survey whose out doc says the map is fresh, which only the engine says', async () => {
    const inner: AttemptEnd = {
      ending: { kind: 'succeeded', output: { status: 'done', summary: 'Fine', map: 'fresh' } },
    };
    const { run } = setup({ inner });
    const end = await run();
    assert.deepEqual(end.ending, {
      kind: 'failed',
      retryable: true,
      reason:
        'the survey says its map is fresh, which only Foedrum says before a survey runs: say new or stale (ADR 0298)',
    });
  });
});
