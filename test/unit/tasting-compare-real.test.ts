import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { BREWERY, localConfig, TARGET, USER } from '../../scripts/demo/core.ts';
import {
  type RunRecord,
  readRecordsIn,
  type TasterAttempt,
} from '../../scripts/tasting-compare/core.ts';
import {
  bareTaster,
  blinded,
  changedFiles,
  codeOf,
  comparisonStop,
  highTaster,
  modelStop,
  nextRealRun,
  orderOf,
  REAL_RECIPE,
  REAL_SETUPS,
  type RealRecord,
  type RealSetup,
  realBreweryFiles,
  realCommentsOf,
  realFolders,
  realRecipeOf,
  realRecipeText,
  realRecordOf,
  realTable,
  refuseSameTaster,
  scriptedRealTastings,
  scriptedTranscript,
  selectRealSetups,
  transcriptReads,
} from '../../scripts/tasting-compare/real.ts';
import { modelOf } from '../../src/brewers/attempt-plan.ts';
import { claudeArgs } from '../../src/brewers/claude-command.ts';
import { serveSetup } from '../../src/cli/serve-config.ts';
import { readBreweryFiles } from '../../src/engine/brewery-files.ts';
import { loadRecipes } from '../../src/engine/recipe-files.ts';
import { parseJsonc } from '../../src/formats/jsonc.ts';
import type { Event } from '../../src/schemas/events.ts';
import { Recipe } from '../../src/schemas/recipe.ts';
import { nipBreweryFiles } from '../helpers/nip-fixture.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const root = resolve(import.meta.dirname, '..', '..');
const WORKTREE = resolve('scratch', 'attempts', 'correctness', '1');
const OUTSIDE = resolve('scratch', 'docs', 'adr', '0327.md');

/** One tool call of a transcript and its result, as claude writes them (read from a run of 2.1.310). */
interface Call {
  name: string;
  input: Record<string, unknown>;
  denied?: true;
}

const callLines = ({ name, input, denied }: Call, at: number): string[] => {
  const id = `toolu_${at}`;
  return [
    JSON.stringify({
      type: 'assistant',
      cwd: WORKTREE,
      message: {
        model: 'claude-sonnet-5-5',
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
      },
    }),
    JSON.stringify({
      type: 'user',
      cwd: WORKTREE,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: denied === true ? 'Permission to use it has been denied' : 'the file',
            ...(denied === true ? { is_error: true } : {}),
          },
        ],
      },
      permissionDecision: { decision: denied === true ? 'reject' : 'accept', source: 'config' },
    }),
  ];
};

/** A transcript of `calls`, with the lines of other types around them that it also holds. */
const transcript = (...calls: readonly Call[]): string =>
  [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
    JSON.stringify({
      type: 'user',
      cwd: WORKTREE,
      message: { role: 'user', content: 'The order' },
    }),
    ...calls.flatMap(callLines),
    '',
  ].join('\n');

const read = (file_path: string): Call => ({ name: 'Read', input: { file_path } });
const outDoc: Call = {
  name: 'Edit',
  input: { file_path: join(WORKTREE, 'taste.md'), old_string: '', new_string: 'done' },
};

const finding = (why: string) => ({
  file: 'src/a.ts',
  line: 3,
  severity: 'major' as const,
  why,
  introduced: true,
});

/** An event of a run's store, with only the fields the record reads. */
const event = (fields: Record<string, unknown>) => ({ event: fields as unknown as Event });

/** One Taster's two events, in a session named after it. */
const tasted = (stepId: string, output: Record<string, unknown>) => [
  event({
    type: 'step.started',
    batchId: '1-1',
    stepId,
    attempt: 1,
    session: { id: `session-${stepId}`, worktree: WORKTREE },
  }),
  event({
    type: 'step.finished',
    batchId: '1-1',
    stepId,
    attempt: 1,
    outcome: { kind: 'succeeded', output },
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    receipt: { turns: 5, durationMs: 6, models: [{ model: 'claude-sonnet-5-5' }] },
  }),
];

/** A record of `setup`'s `run`, with one Taster finding `why`. */
const record = (setup: RealSetup, run: number, why: string): RealRecord => ({
  setup,
  run,
  ended: 'on_tap',
  wallMs: 1,
  attempts: [attempt('correctness', [finding(why)])],
});

const attempt = (
  stepId: string,
  findings: TasterAttempt['findings'],
  more: Partial<TasterAttempt> = {},
): TasterAttempt => ({
  stepId,
  lenses: [`diff/${stepId}`],
  failure: undefined,
  findings,
  usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
  turns: 5,
  durationMs: 6,
  ...more,
});

const TASTERS = { today: 'the old text', current: 'the default text' };

const SETUPS: readonly RealSetup[] = [
  '855-today',
  '855-reads',
  '855-lens',
  '855-opus',
  '855-high',
  '855-opus-bare',
  '855-high-bare',
  '855-opus-together',
  '864-today',
  '864-reads',
  '864-lens',
  '864-opus',
  '864-high',
  '864-opus-bare',
  '864-high-bare',
  '864-opus-together',
  '867-today',
  '867-reads',
  '867-lens',
  '867-opus',
  '867-high',
  '867-opus-bare',
  '867-high-bare',
  '867-opus-together',
  '867-comments',
];

describe('tasting-compare --real', () => {
  describe('the runs', () => {
    it("the real mode's next run goes order by order and setup by setup, and picks up where it stopped", () => {
      const records: RealRecord[] = [];
      const walked: string[] = [];
      for (let next = nextRealRun(records, 2); next !== undefined; next = nextRealRun(records, 2)) {
        walked.push(`${next.setup}#${next.run}`);
        records.push(record(next.setup, next.run, 'a finding'));
      }
      assert.deepEqual(
        walked,
        SETUPS.flatMap((setup) => [`${setup}#1`, `${setup}#2`]),
      );

      // A stopped comparison, its records out of order: the first run with none comes next.
      const stopped = [record('855-reads', 2, 'x'), record('855-today', 2, 'x')];
      stopped.push(record('855-today', 1, 'x'));
      assert.deepEqual(nextRealRun(stopped, 2), { setup: '855-reads', run: 1, retry: false });
    });

    it('runs a failed run once more, and goes on after a second failure', () => {
      const failed: RealRecord = {
        ...record('855-today', 1, 'x'),
        ended: 'stuck: attempts_exhausted',
      };
      assert.deepEqual(nextRealRun([failed], 1), { setup: '855-today', run: 1, retry: true });
      assert.deepEqual(nextRealRun([failed, failed], 1), {
        setup: '855-reads',
        run: 1,
        retry: false,
      });
    });

    it('runs a run again when a Taster failed it by reading outside its worktree', () => {
      const [taster] = realRecordOf([...tasted('correctness', { findings: [] })], () =>
        transcript(read(OUTSIDE), outDoc),
      ).attempts;
      assert.ok(taster);
      const run: RealRecord = { ...record('855-today', 1, 'x'), attempts: [taster] };
      assert.deepEqual(nextRealRun([run], 1), { setup: '855-today', run: 1, retry: true });
    });

    it('keeps each setup with its own order', () => {
      assert.equal(orderOf('864-today').head, '5590e9c5');
      assert.equal(orderOf('867-reads').base, '02eba0cd');
    });
  });

  describe('a head', () => {
    it('a head that deletes a file is refused', () => {
      assert.throws(
        () => changedFiles('M\0src/a.ts\0D\0docs/gone.md\0'),
        /docs\/gone\.md.*deletes|deletes.*docs\/gone\.md/,
      );
    });

    it('takes the files a head adds or changes, in the order git names them', () => {
      assert.deepEqual(changedFiles('M\0src/b.ts\0A\0D\0M\0a b.md\0'), ['src/b.ts', 'D', 'a b.md']);
    });

    it('refuses a change it would not commit as it is: another kind of file', () => {
      assert.throws(() => changedFiles('T\0src/link\0'), /src\/link/);
    });

    it('refuses a head that changes no file', () => {
      assert.throws(() => changedFiles(''), /no file/);
    });
  });

  describe('what a Taster read', () => {
    it('a Taster that read a file outside its worktree fails its run', () => {
      const [taster] = realRecordOf(tasted('correctness', { findings: [] }), () =>
        transcript(read(OUTSIDE), outDoc),
      ).attempts;
      assert.match(taster?.failure ?? '', /outside its worktree/);
      assert.match(taster?.failure ?? '', /0327\.md/);
      assert.deepEqual(taster?.outside, [OUTSIDE]);
    });

    it('reads a relative path against the worktree, .. too', () => {
      const { outside, opened } = transcriptReads(
        transcript(read('../../docs/adr/0327.md'), read('src/a.ts')),
        WORKTREE,
      );
      assert.deepEqual(outside, [resolve(WORKTREE, '../../docs/adr/0327.md')]);
      assert.deepEqual(opened, ['src/a.ts']);
    });

    it("holds a sibling whose name starts with the worktree's to be outside", () => {
      const sibling = `${WORKTREE}-other`;
      const { outside } = transcriptReads(transcript(read(join(sibling, 'a.ts'))), WORKTREE);
      assert.deepEqual(outside, [join(sibling, 'a.ts')]);
    });

    it('holds any file to be inside a worktree at the root', () => {
      const top = parse(WORKTREE).root;
      const { outside } = transcriptReads(transcript(read(join(top, 'a.ts'))), top);
      assert.deepEqual(outside, []);
    });

    it('a Grep or a Glob that searched outside fails too', () => {
      for (const call of [
        { name: 'Grep', input: { pattern: 'x', path: '..' } },
        { name: 'Glob', input: { pattern: '*', path: dirname(OUTSIDE) } },
        { name: 'Glob', input: { pattern: '../other/*' } },
        { name: 'Glob', input: { pattern: `${dirname(OUTSIDE).replaceAll('\\', '/')}/*` } },
        { name: 'Glob', input: { pattern: 'src/**/../../../*' } },
        { name: 'Glob', input: { pattern: '/*' } },
        { name: 'Glob', input: { pattern: `${parse(WORKTREE).root.replaceAll('\\', '/')}*` } },
      ]) {
        const { outside } = transcriptReads(transcript(call), WORKTREE);
        assert.equal(outside.length, 1, JSON.stringify(call));
      }
    });

    it('a Read of a path from the home folder fails the run, as it never lies in the worktree', () => {
      const { outside, opened } = transcriptReads(transcript(read('~/notes.md')), WORKTREE);
      assert.deepEqual(outside, ['~/notes.md']);
      assert.deepEqual(opened, []);
    });

    it('a Grep or a Glob from the home folder fails the run', () => {
      for (const call of [
        { name: 'Grep', input: { pattern: 'x', path: '~' } },
        { name: 'Glob', input: { pattern: '*', path: '~/code' } },
        { name: 'Glob', input: { pattern: '~/*' } },
        { name: 'Glob', input: { pattern: '~other/*.md' } },
      ]) {
        const { outside } = transcriptReads(transcript(call), WORKTREE);
        assert.equal(outside.length, 1, JSON.stringify(call));
      }
    });

    it('a refused read from the home folder is listed as refused', () => {
      const denied = { ...read('~/notes.md'), denied: true as const };
      assert.deepEqual(transcriptReads(transcript(denied), WORKTREE).refused, ['~/notes.md']);
    });

    it('a folder named with a ~ inside the worktree is inside', () => {
      const { outside } = transcriptReads(transcript(read('src/~/a.ts')), WORKTREE);
      assert.deepEqual(outside, []);
    });

    it('a Glob with a .. in a brace group fails the run', () => {
      for (const pattern of ['{../other,src}/*', '{..,src}/*', '{src,..}/*', '{src,../other}/*']) {
        const call = { name: 'Glob', input: { pattern } };
        const { outside } = transcriptReads(transcript(call), WORKTREE);
        assert.deepEqual(outside, [pattern]);
      }
    });

    it('a Glob with a brace group and two dots in a name stays inside', () => {
      for (const pattern of ['src/{a,b}.ts', 'src/a..b*', '{src,test}/*.ts']) {
        const call = { name: 'Glob', input: { pattern } };
        assert.deepEqual(transcriptReads(transcript(call), WORKTREE).outside, [], pattern);
      }
    });

    it('a Grep or a Glob of the worktree stays inside', () => {
      for (const call of [
        { name: 'Grep', input: { pattern: 'x' } },
        { name: 'Grep', input: { pattern: 'x', path: 'src' } },
        { name: 'Glob', input: { pattern: '**/*.ts' } },
        { name: 'Glob', input: { pattern: 'src/*.ts', path: WORKTREE } },
      ]) {
        const { outside, problem } = transcriptReads(transcript(call), WORKTREE);
        assert.deepEqual({ outside, problem }, { outside: [], problem: undefined });
      }
    });

    it('a read the permissions refused read nothing: it is listed, and fails no run', () => {
      const denied = { ...read(OUTSIDE), denied: true as const };
      const [taster] = realRecordOf(tasted('correctness', { findings: [] }), () =>
        transcript(denied, outDoc),
      ).attempts;
      assert.equal(taster?.failure, undefined);
      assert.deepEqual(taster?.outside, []);
      assert.deepEqual(taster?.refused, [OUTSIDE]);
    });

    it('keeps the files a Taster opened by path, once each, and not its out doc', () => {
      const [taster] = realRecordOf(tasted('correctness', { findings: [] }), () =>
        transcript(read(join(WORKTREE, 'src', 'b.ts')), read('src/a.ts'), read('src/b.ts'), outDoc),
      ).attempts;
      assert.deepEqual(taster?.opened, ['src/b.ts', 'src/a.ts']);
    });

    it('a Taster that opened no file and wrote its out doc passes its run, with no file listed as opened', () => {
      const [taster] = realRecordOf(tasted('correctness', { findings: [] }), () =>
        transcript(outDoc),
      ).attempts;
      assert.equal(taster?.failure, undefined);
      assert.deepEqual(taster?.opened, []);
      assert.deepEqual(taster?.outside, []);
    });

    it('a tool whose reads it cannot tell fails the run', () => {
      const [taster] = realRecordOf(tasted('correctness', { findings: [] }), () =>
        transcript({ name: 'Bash', input: { command: 'cat ../x' } }, outDoc),
      ).attempts;
      assert.match(taster?.failure ?? '', /Bash/);
    });

    it('a tool that came back refused is no read, whatever the tool', () => {
      const { problem } = transcriptReads(
        transcript({ name: 'Bash', input: { command: 'cat x' }, denied: true }),
        WORKTREE,
      );
      assert.equal(problem, undefined);
    });

    it('a transcript it cannot find fails the run, and claims no read', () => {
      const [taster] = realRecordOf(
        tasted('correctness', { findings: [] }),
        () => undefined,
      ).attempts;
      assert.match(taster?.failure ?? '', /transcript/);
      assert.deepEqual(taster?.opened, []);
    });

    it('a transcript that shows no tool call fails the run: a Taster writes its out doc with one', () => {
      const [taster] = realRecordOf(tasted('correctness', { findings: [] }), () =>
        transcript(),
      ).attempts;
      assert.match(taster?.failure ?? '', /no tool call/);
    });

    it('a call whose result it cannot find fails the run: what it read cannot be told', () => {
      const [use] = callLines(read(OUTSIDE), 9);
      const { problem } = transcriptReads(`${use}\n${transcript(outDoc)}`, WORKTREE);
      assert.match(problem ?? '', /result/);
    });

    it('a transcript that cannot be read stops the comparison, and a read outside fails only its run', () => {
      const brewed = tasted('correctness', { findings: [] });
      const lost = realRecordOf(brewed, () => undefined);
      assert.match(
        comparisonStop({ setup: '855-reads', ...lost }) ?? '',
        /correctness: .*transcript could not be found/,
      );

      const outside = realRecordOf(brewed, () => transcript(read(OUTSIDE), outDoc));
      assert.equal(comparisonStop({ setup: '855-reads', ...outside }), undefined);
      const run: RealRecord = { ...record('855-today', 1, 'x'), attempts: outside.attempts };
      assert.deepEqual(nextRealRun([run], 1), { setup: '855-today', run: 1, retry: true });
    });

    it('every way a transcript cannot say stops the comparison', () => {
      const [use] = callLines(read('src/a.ts'), 9);
      for (const text of [
        transcript(),
        `${transcript(outDoc)}{"type":"assist`,
        `${use}\n${transcript(outDoc)}`,
        transcript({ name: 'Bash', input: { command: 'cat x' } }, outDoc),
      ]) {
        const reading = realRecordOf(tasted('security', { findings: [] }), () => text);
        assert.match(comparisonStop({ setup: '855-reads', ...reading }) ?? '', /^security: /, text);
      }
    });

    it('an attempt that failed by itself stops nothing, though its transcript says nothing', () => {
      const failed = event({
        type: 'step.finished',
        batchId: '1-1',
        stepId: 'security',
        attempt: 1,
        outcome: { kind: 'failed', retryable: false, reason: 'it stalled' },
      });
      assert.equal(
        comparisonStop({ setup: '855-reads', ...realRecordOf([failed], () => undefined) }),
        undefined,
      );
    });

    it('a stop keeps a tool name from forging a line of the output', () => {
      const forged = { name: 'Bash\nforged line', input: {} };
      const reading = realRecordOf(tasted('security', { findings: [] }), () =>
        transcript(forged, outDoc),
      );
      assert.doesNotMatch(comparisonStop({ setup: '855-reads', ...reading }) ?? 'none', /\n/);
      assert.match(comparisonStop({ setup: '855-reads', ...reading }) ?? '', /forged line/);
    });

    it('takes the out doc body from the transcript, past its frontmatter', () => {
      const written: Call = {
        name: 'Edit',
        input: {
          file_path: 'taste.md',
          old_string: '',
          new_string: '---\n{ "status": "done" }\n---\n\nI read CLAUDE.md.\n',
        },
      };
      assert.equal(transcriptReads(transcript(written), WORKTREE).body, 'I read CLAUDE.md.');
    });

    it('follows later Edits of the out doc, and a Write of it', () => {
      const edit = (old_string: string, new_string: string): Call => ({
        name: 'Edit',
        input: { file_path: join(WORKTREE, 'taste.md'), old_string, new_string },
      });
      const doc = '---\n{}\n---\nfirst $& text';
      const edited = transcript(edit('', doc), edit('first', 'second'));
      assert.equal(transcriptReads(edited, WORKTREE).body, 'second $& text');
      const write: Call = {
        name: 'Write',
        input: { file_path: 'taste.md', content: '---\n{}\n---\nwritten' },
      };
      assert.equal(transcriptReads(transcript(edit('', doc), write), WORKTREE).body, 'written');
    });

    it('a change of another file, or a refused one, is no body', () => {
      const other: Call = {
        name: 'Edit',
        input: { file_path: 'other.md', old_string: '', new_string: 'other' },
      };
      const refused: Call = {
        name: 'Edit',
        input: { file_path: 'taste.md', old_string: '', new_string: 'refused' },
        denied: true,
      };
      assert.equal(transcriptReads(transcript(other, refused), WORKTREE).body, undefined);
    });

    it('a record keeps the body of a Taster', () => {
      const written: Call = {
        name: 'Write',
        input: { file_path: 'taste.md', content: '---\n{}\n---\nI read the diff.' },
      };
      const [taster] = realRecordOf(tasted('security', { findings: [] }), () =>
        transcript(written),
      ).attempts;
      assert.equal(taster?.body, 'I read the diff.');
    });

    it('a transcript with a line it cannot read fails the run', () => {
      const { problem } = transcriptReads(`${transcript(outDoc)}{"type":"assist`, WORKTREE);
      assert.match(problem ?? '', /line/);
    });

    it('reads calls only from what the model and the tools said, not from a line of another type', () => {
      const logged = (type: string, block: Record<string, unknown>) =>
        JSON.stringify({ type, message: { content: [block] } });
      const use = { type: 'tool_use', id: 'x', name: 'Read', input: { file_path: OUTSIDE } };
      const result = { type: 'tool_result', tool_use_id: 'x' };
      const lines = [logged('api-request-blob', use), logged('api-request-blob', result)];
      const { outside } = transcriptReads(`${lines.join('\n')}\n${transcript(outDoc)}`, WORKTREE);
      assert.deepEqual(outside, []);
    });

    it('takes a call only from a line of the model, and its result only from a line of the tools', () => {
      const logged = (type: string, block: Record<string, unknown>) =>
        JSON.stringify({ type, message: { content: [block] } });
      const use = { type: 'tool_use', id: 'x', name: 'Read', input: { file_path: OUTSIDE } };
      const result = { type: 'tool_result', tool_use_id: 'x' };
      for (const lines of [
        [logged('user', use), logged('user', result)],
        [logged('assistant', use), logged('assistant', result)],
      ]) {
        const { outside } = transcriptReads(`${lines.join('\n')}\n${transcript(outDoc)}`, WORKTREE);
        assert.deepEqual(outside, []);
      }
    });

    it('holds a Write inside to be no read, and an Edit or a Write outside to reach outside', () => {
      const write = (file_path: string): Call => ({
        name: 'Write',
        input: { file_path, content: 'text' },
      });
      const inside = transcriptReads(transcript(write(join(WORKTREE, 'taste.md'))), WORKTREE);
      assert.deepEqual([inside.opened, inside.outside, inside.problem], [[], [], undefined]);
      assert.deepEqual(transcriptReads(transcript(write(OUTSIDE)), WORKTREE).outside, [OUTSIDE]);
      const edit = { name: 'Edit', input: { file_path: OUTSIDE, old_string: '', new_string: 'x' } };
      assert.deepEqual(transcriptReads(transcript(edit), WORKTREE).outside, [OUTSIDE]);
    });

    it('a Read that names no path cannot be told', () => {
      const { problem } = transcriptReads(transcript({ name: 'Read', input: {} }), WORKTREE);
      assert.match(problem ?? '', /Read/);
    });

    it('a read inside that came back as an error is neither opened nor refused outside', () => {
      const failed = { ...read('src/gone.ts'), denied: true as const };
      const { opened, refused } = transcriptReads(transcript(failed), WORKTREE);
      assert.deepEqual([opened, refused], [[], []]);
    });

    it('reads a .. before any wildcard, and a pattern with none, by where it lands', () => {
      const reachedBy = (pattern: string) =>
        transcriptReads(transcript({ name: 'Glob', input: { pattern } }), WORKTREE).outside;
      assert.deepEqual(reachedBy('src/../*.ts'), []);
      assert.deepEqual(reachedBy('src/a.ts'), []);
      assert.deepEqual(reachedBy('../x.md'), [resolve(WORKTREE, '../x.md')]);
    });

    it('reads every wildcard, and backslashes, in a Glob that goes up', () => {
      for (const pattern of ['sr?/../../../*', '[a]/../../*', 'src\\**\\..\\..\\..\\*']) {
        const call = { name: 'Glob', input: { pattern } };
        assert.deepEqual(transcriptReads(transcript(call), WORKTREE).outside, [pattern]);
      }
    });

    it('an earlier failure of the attempt stays its reason', () => {
      const failed = event({
        type: 'step.finished',
        batchId: '1-1',
        stepId: 'security',
        attempt: 1,
        outcome: { kind: 'failed', retryable: false, reason: 'it stalled' },
      });
      const [taster] = realRecordOf([failed], () => undefined).attempts;
      assert.match(taster?.failure ?? '', /it stalled/);
    });
  });

  describe('a record', () => {
    it("a record keeps each Taster's riskLeft", () => {
      const { attempts } = realRecordOf(
        [
          ...tasted('correctness', { findings: [], riskLeft: ['the store may be stale'] }),
          ...tasted('security', { findings: [] }),
        ],
        () => transcript(outDoc),
      );
      assert.deepEqual(attempts[0]?.riskLeft, ['the store may be stale']);
      assert.equal(attempts[1]?.riskLeft, undefined);
    });

    it('keeps the model each attempt ran on, and its tokens', () => {
      const [taster] = realRecordOf(tasted('correctness', { findings: [] }), () =>
        transcript(outDoc),
      ).attempts;
      assert.deepEqual(taster?.models, ['claude-sonnet-5-5']);
      assert.equal(taster?.usage?.cacheWriteTokens, 4);
    });

    it('reads each Taster in its own session', () => {
      const asked: string[] = [];
      realRecordOf(
        [...tasted('security', { findings: [] }), ...tasted('acceptance', { findings: [] })],
        (id, worktree) => {
          asked.push(`${id} ${worktree}`);
          return transcript(outDoc);
        },
      );
      assert.deepEqual(asked, [`session-security ${WORKTREE}`, `session-acceptance ${WORKTREE}`]);
    });

    it('reads each attempt in its own session, an implementer and a second attempt around it', () => {
      const started = (stepId: string, attempt: number, id: string, worktree: string) =>
        event({
          type: 'step.started',
          batchId: '1-1',
          stepId,
          attempt,
          session: { id, worktree },
        });
      const ended = (stepId: string, attempt: number) =>
        event({
          type: 'step.finished',
          batchId: '1-1',
          stepId,
          attempt,
          outcome: { kind: 'succeeded', output: { findings: [] } },
        });
      const other = `${WORKTREE}-second`;
      const asked: string[] = [];
      const { attempts } = realRecordOf(
        [
          started('implement', 1, 'session-implement', WORKTREE),
          ended('implement', 1),
          started('security', 1, 'session-first', WORKTREE),
          started('acceptance', 1, 'session-acceptance', WORKTREE),
          ended('security', 1),
          ended('acceptance', 1),
          started('security', 2, 'session-second', other),
          ended('security', 2),
        ],
        (id, worktree) => {
          asked.push(`${id} ${worktree}`);
          const reached = id === 'session-first' ? [read(OUTSIDE)] : [];
          const written = { ...outDoc, input: { ...outDoc.input, file_path: 'taste.md' } };
          return transcript(...reached, written);
        },
      );
      assert.deepEqual(asked, [
        `session-first ${WORKTREE}`,
        `session-acceptance ${WORKTREE}`,
        `session-second ${other}`,
      ]);
      assert.deepEqual(
        attempts.map(({ failure }) => failure !== undefined),
        [true, false, false],
      );
    });

    it('reads how the batch ended, and only the Tasters', () => {
      const implement = event({
        type: 'step.finished',
        batchId: '1-1',
        stepId: 'implement',
        attempt: 1,
        outcome: { kind: 'succeeded', output: {} },
      });
      const onTap = event({ type: 'batch.on_tap', batchId: '1-1', pullRequests: [] });
      const { ended, attempts } = realRecordOf(
        [implement, ...tasted('security', { findings: [] }), onTap],
        () => transcript(outDoc),
      );
      assert.equal(ended, 'on_tap');
      assert.deepEqual(
        attempts.map(({ stepId }) => stepId),
        ['security'],
      );
    });
  });

  describe('the recipe', () => {
    const tasteOf = (text: string) => {
      const parsed = Recipe.parse(parseJsonc(text));
      const taste = parsed.steps.find((step) => 'id' in step && step.id === 'taste');
      assert.ok(taste !== undefined && 'parallel' in taste);
      return taste.parallel;
    };

    it('real-nip keeps the three Tasters the comparison measured (ADR 0343)', () => {
      const named = tasteOf(realRecipeText('855-reads')).map((step) => [step.id, step.lens]);
      assert.deepEqual(named, [
        ['correctness', 'diff/correctness'],
        ['acceptance', 'diff/acceptance'],
        ['security', 'diff/security'],
      ]);
    });

    it('real-nip says it tastes with less than nip does now (ADR 0343)', () => {
      const { description } = Recipe.parse(parseJsonc(realRecipeText('855-reads')));
      assert.doesNotMatch(description ?? '', /as nip tastes it/);
      assert.match(description ?? '', /correctness, acceptance and security/);
      assert.doesNotMatch(description ?? '', /design conformance/);
    });

    it('blocks nowhere, so every run ends', () => {
      for (const step of tasteOf(realRecipeText('855-reads'))) {
        assert.equal(step.blocking, undefined, step.id);
        assert.equal(step.onBlocked, undefined, step.id);
      }
    });

    it('is named as the label of every order, loads as a Brewery file, and opens a pull request', () => {
      const recipe = Recipe.parse(parseJsonc(realRecipeText('855-reads')));
      assert.equal(recipe.name, REAL_RECIPE);
      assert.equal(recipe.testFirst, false);
      assert.ok(recipe.steps.some((step) => 'action' in step && step.action === 'openPullRequest'));
      const brewery = makeTempDir('tasting-compare-real');
      try {
        const files = realBreweryFiles('855-reads', TASTERS);
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(dirname(join(brewery.path, path)), { recursive: true });
          writeFileSync(join(brewery.path, path), text);
        }
        const loaded = loadRecipes(readBreweryFiles(brewery.path));
        assert.deepEqual(loaded.valid ? [] : loaded.problems, []);
        assert.ok(loaded.valid && loaded.recipes.find(REAL_RECIPE) !== undefined);
      } finally {
        brewery.remove();
      }
    });

    it('refuses a comparison whose two setups would taste with one Taster text', () => {
      assert.throws(() => refuseSameTaster('the text\n', 'the text\n'), /same Taster/);
      assert.throws(() => refuseSameTaster('the\r\ntext\r\n', 'the\ntext\n'), /same Taster/);
    });

    it('lets a comparison of two Taster texts go on', () => {
      assert.doesNotThrow(() => refuseSameTaster('version 7\n', 'version 8\n'));
    });

    it('the today setup replaces the Taster, and the reads setup keeps the default', () => {
      assert.equal(realBreweryFiles('864-today', TASTERS)['brewers/taster.md'], 'the old text');
      assert.equal(realBreweryFiles('864-reads', TASTERS)['brewers/taster.md'], undefined);
    });

    describe('the lens setup (#889, ADR 0337)', () => {
      const lensRecipe = () => {
        const text = realBreweryFiles('855-lens', TASTERS)['recipes/real-nip-lens.jsonc'];
        assert.ok(text !== undefined, 'the lens setup has no recipe of its own');
        return text;
      };

      it("the lens setup's Tasters are the lenses of the default nip recipe (ADR 0343)", () => {
        const nip = readFileSync(join(root, 'defaults', 'recipes', 'nip.jsonc'), 'utf8');
        const named = (steps: ReturnType<typeof tasteOf>) =>
          steps.map((step) => ({ id: step.id, brewer: step.brewer, lens: step.lens }));
        assert.deepEqual(named(tasteOf(lensRecipe())), named(tasteOf(nip)));
      });

      it("the lens setup's Tasters are real-nip's and design conformance", () => {
        const named = (steps: ReturnType<typeof tasteOf>) =>
          steps.map((step) => ({ id: step.id, brewer: step.brewer, lens: step.lens }));
        assert.deepEqual(named(tasteOf(lensRecipe())), [
          ...named(tasteOf(realRecipeText('855-reads'))),
          { id: 'design-conformance', brewer: 'taster', lens: 'diff/design-conformance' },
        ]);
      });

      it('its recipe blocks nowhere, so every run ends', () => {
        for (const step of tasteOf(lensRecipe())) {
          assert.equal(step.blocking, undefined, step.id);
          assert.equal(step.onBlocked, undefined, step.id);
        }
      });

      it('its recipe names design conformance', () => {
        const { description } = Recipe.parse(parseJsonc(lensRecipe()));
        assert.match(description ?? '', /correctness, acceptance, security and design conformance/);
        assert.doesNotMatch(description ?? '', /as nip tastes it/);
      });

      it('each setup brews the recipe of its own kind', () => {
        assert.deepEqual(
          SETUPS.map((setup) => realRecipeOf(setup)),
          SETUPS.map((setup) =>
            setup.endsWith('-lens')
              ? 'real-nip-lens'
              : setup.endsWith('-together')
                ? 'real-nip-together'
                : REAL_RECIPE,
          ),
        );
      });

      it("its recipe is named as an order's label and loads as a Brewery file, on the default Taster", () => {
        const files = realBreweryFiles('855-lens', TASTERS);
        assert.equal(files['brewers/taster.md'], undefined);
        assert.equal(Recipe.parse(parseJsonc(lensRecipe())).name, 'real-nip-lens');
        const brewery = makeTempDir('tasting-compare-real');
        try {
          for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(brewery.path, path)), { recursive: true });
            writeFileSync(join(brewery.path, path), text);
          }
          const loaded = loadRecipes(readBreweryFiles(brewery.path));
          assert.deepEqual(loaded.valid ? [] : loaded.problems, []);
          assert.ok(loaded.valid && loaded.recipes.find('real-nip-lens') !== undefined);
        } finally {
          brewery.remove();
        }
      });

      it('a record reads the fourth Taster of a run', () => {
        const { attempts } = realRecordOf(
          [
            ...tasted('correctness', { findings: [] }),
            ...tasted('design-conformance', { findings: [finding('a stale page')] }),
          ],
          () => transcript(outDoc),
        );
        assert.deepEqual(
          attempts.map(({ stepId, lenses }) => [stepId, lenses]),
          [
            ['correctness', ['diff/correctness']],
            ['design-conformance', ['diff/design-conformance']],
          ],
        );
      });

      it("a list shows the fourth Taster last, in its recipe's order", () => {
        const run: RealRecord = {
          ...record('855-lens', 1, 'x'),
          attempts: [
            attempt('design-conformance', [finding('a stale page')]),
            attempt('security', [finding('a hole')]),
          ],
        };
        const list = blinded([run], 'a seed').lists[855] ?? '';
        const at = (name: string) => list.indexOf(`### ${name} (`);
        assert.ok(at('security') >= 0, list);
        assert.ok(at('security') < at('design-conformance'), list);
      });
    });
  });

  describe('the blinded lists', () => {
    const records: RealRecord[] = [
      record('867-reads', 1, 'a finding of the second setup'),
      record('855-reads', 2, 'another on 855'),
      record('855-today', 1, 'a finding on 855'),
      record('855-reads', 1, 'a third on 855'),
    ];

    it('a blinded list names no setup, and the codes file maps every code back to one', () => {
      const { lists, codes } = blinded(records, 'a seed');
      const list = lists['855'] ?? '';
      assert.doesNotMatch(list, /today|reads/);
      for (const why of ['another on 855', 'a finding on 855', 'a third on 855']) {
        assert.match(list, new RegExp(why));
      }
      assert.doesNotMatch(list, /second setup/);
      assert.deepEqual(Object.keys(lists).sort(), ['855', '867']);
      for (const [setup, run] of [
        ['855-today', 1],
        ['855-reads', 1],
        ['855-reads', 2],
        ['867-reads', 1],
      ] as const) {
        const code = codeOf('a seed', setup, run);
        assert.match(lists[setup.slice(0, 3)] ?? '', new RegExp(`Run ${code}`));
        assert.match(codes, new RegExp(`\\| ${code} \\| ${setup} \\| ${run} \\|`));
      }
    });

    it('a blinded list gives the same run a different code under a different seed', () => {
      assert.notEqual(codeOf('one', '855-today', 1), codeOf('two', '855-today', 1));
      assert.equal(codeOf('one', '855-today', 1), codeOf('one', '855-today', 1));
      assert.notEqual(codeOf('one', '855-today', 1), codeOf('one', '855-today', 2));
      assert.notEqual(codeOf('one', '855-today', 1), codeOf('one', '855-reads', 1));
      const { lists } = blinded(records, 'one');
      assert.doesNotMatch(lists['855'] ?? '', new RegExp(codeOf('two', '855-today', 1)));
    });

    it('lists the runs by their code, so their order says nothing of their setup', () => {
      const { lists } = blinded(records, 'a seed');
      const shown = [...(lists['855'] ?? '').matchAll(/^## Run (\w+)$/gm)].map((match) => match[1]);
      assert.equal(shown.length, 3);
      assert.deepEqual(shown, [...shown].sort());
    });

    it('lists a run in its code order, whatever order its setups come in', () => {
      const many = SETUPS.slice(0, 2).flatMap((setup) =>
        [1, 2, 3].map((run) => record(setup, run, 'x')),
      );
      const shown = [
        ...(blinded(many, 'a seed').lists['855'] ?? '').matchAll(/^## Run (\w+)$/gm),
      ].map((match) => match[1]);
      const inRunOrder = many.map(({ setup, run }) => codeOf('a seed', setup, run));
      assert.notDeepEqual(inRunOrder, [...inRunOrder].sort());
      assert.deepEqual(shown, [...inRunOrder].sort());
    });

    it("shows each run's Tasters in the recipe's order, whatever order they finished in", () => {
      const run: RealRecord = {
        ...record('855-today', 1, 'x'),
        attempts: [attempt('security', []), attempt('correctness', []), attempt('acceptance', [])],
      };
      const { lists, codes } = blinded([run], 'a seed');
      assert.deepEqual(
        [...(lists['855'] ?? '').matchAll(/^### (\w+)/gm)].map((match) => match[1]),
        ['correctness', 'acceptance', 'security'],
      );
      assert.deepEqual(
        [...codes.matchAll(/\| 855-today \| 1 \| (\w+) \|/g)].map((match) => match[1]),
        ['correctness', 'acceptance', 'security'],
      );
    });

    it('says when a finding was there before the change, and only then', () => {
      const run: RealRecord = {
        ...record('855-today', 1, 'x'),
        attempts: [
          attempt('security', [
            { ...finding('new one'), introduced: true },
            { ...finding('old one'), introduced: false },
          ]),
        ],
      };
      const list = blinded([run], 'a seed').lists['855'] ?? '';
      assert.match(list, /there before the change: old one/);
      assert.doesNotMatch(list, /there before the change: new one/);
    });

    it("keeps a risk's and a failure's line breaks from forging a line", () => {
      const forged = 'first\n## Run 0\nFailed: 867-reads run 9: forged';
      const run: RealRecord = {
        ...record('855-today', 1, 'x'),
        attempts: [attempt('security', [], { riskLeft: [forged] })],
      };
      const failed: RealRecord = {
        ...record('855-today', 2, 'x'),
        attempts: [attempt('security', [], { failure: forged })],
      };
      const { lists, codes } = blinded([run, failed], 'a seed');
      assert.equal([...(lists['855'] ?? '').matchAll(/^## Run /gm)].length, 1);
      assert.equal([...codes.matchAll(/^Failed: /gm)].length, 1);
    });

    it('shows a dash for the model and the tokens an attempt has none of', () => {
      const run: RealRecord = {
        ...record('855-today', 1, 'x'),
        attempts: [attempt('security', [], { usage: undefined })],
      };
      assert.match(
        blinded([run], 'a seed').codes,
        /\| 855-today \| 1 \| security \| - \| - \| - \| - \| - \| - \|/,
      );
    });

    it('the table it prints is a row per setup and one line after them', () => {
      assert.deepEqual(realTable([record('867-reads', 1, 'x')]).split('\n'), [
        '| Setup | Runs to score | Failed goes | Retried | Opened the instruction file |',
        '|---|---|---|---|---|',
        '| 855-today | 0 | 0 | 0 | 0 of 0 |',
        '| 855-reads | 0 | 0 | 0 | 0 of 0 |',
        '| 855-lens | 0 | 0 | 0 | 0 of 0 |',
        '| 855-opus | 0 | 0 | 0 | 0 of 0 |',
        '| 855-high | 0 | 0 | 0 | 0 of 0 |',
        '| 855-opus-bare | 0 | 0 | 0 | 0 of 0 |',
        '| 855-high-bare | 0 | 0 | 0 | 0 of 0 |',
        '| 855-opus-together | 0 | 0 | 0 | 0 of 0 |',
        '| 864-today | 0 | 0 | 0 | 0 of 0 |',
        '| 864-reads | 0 | 0 | 0 | 0 of 0 |',
        '| 864-lens | 0 | 0 | 0 | 0 of 0 |',
        '| 864-opus | 0 | 0 | 0 | 0 of 0 |',
        '| 864-high | 0 | 0 | 0 | 0 of 0 |',
        '| 864-opus-bare | 0 | 0 | 0 | 0 of 0 |',
        '| 864-high-bare | 0 | 0 | 0 | 0 of 0 |',
        '| 864-opus-together | 0 | 0 | 0 | 0 of 0 |',
        '| 867-today | 0 | 0 | 0 | 0 of 0 |',
        '| 867-reads | 1 | 0 | 0 | 0 of 1 |',
        '| 867-lens | 0 | 0 | 0 | 0 of 0 |',
        '| 867-opus | 0 | 0 | 0 | 0 of 0 |',
        '| 867-high | 0 | 0 | 0 | 0 of 0 |',
        '| 867-opus-bare | 0 | 0 | 0 | 0 of 0 |',
        '| 867-high-bare | 0 | 0 | 0 | 0 of 0 |',
        '| 867-opus-together | 0 | 0 | 0 | 0 of 0 |',
        '| 867-comments | 0 | 0 | 0 | 0 of 0 |',
        '',
        'Score lists/<order>.md by hand, then read bodies/<order>.md, then open codes.md, which says which setup each code is.',
        '',
      ]);
    });

    it('writes each body apart, per order under its code, and leaves it out of the list', () => {
      const run: RealRecord = {
        ...record('855-today', 1, 'x'),
        attempts: [
          attempt('security', [], { body: 'I read CLAUDE.md.' }),
          attempt('correctness', []),
        ],
      };
      const other = record('867-reads', 1, 'y');
      const { lists, bodies } = blinded([run, other], 'a seed');
      const body = bodies['855'] ?? '';
      assert.match(body, new RegExp(`^## Run ${codeOf('a seed', '855-today', 1)}$`, 'm'));
      assert.match(body, /### correctness \(diff\/correctness\)\n+No body\./);
      assert.match(body, /### security \(diff\/security\)\n+> I read CLAUDE\.md\./);
      assert.doesNotMatch(lists['855'] ?? '', /I read CLAUDE/);
      assert.deepEqual(Object.keys(bodies).sort(), ['855', '867']);
      assert.doesNotMatch(body, /today|reads/);
    });

    it("keeps a body's lines from forging a line of its file", () => {
      const [separator] = [0x2028].map((code) => String.fromCodePoint(code));
      const forged = `first\n## Run 0${separator}### forged\r\n\n## Run 1`;
      const run: RealRecord = {
        ...record('855-today', 1, 'x'),
        attempts: [attempt('security', [], { body: forged })],
      };
      const body = blinded([run], 'a seed').bodies['855'] ?? '';
      assert.equal([...body.matchAll(/^## Run /gm)].length, 1);
      assert.equal([...body.matchAll(/^### /gm)].length, 1);
      assert.equal(body.includes(separator ?? 'none'), false);
    });

    it('shows a riskLeft line apart from the findings', () => {
      const run: RealRecord = {
        ...record('855-today', 1, 'x'),
        attempts: [attempt('security', [], { riskLeft: ['only a run would show it'] })],
      };
      const list = blinded([run], 'a seed').lists['855'] ?? '';
      assert.match(list, /security \(diff\/security\)\n+No findings\./);
      assert.match(
        list,
        /Risks left, which do not count as findings:\n+- only a run would show it/,
      );
    });

    it("keeps a model's line breaks and Markdown from forging a line of the list", () => {
      const [lineSeparator, paragraphSeparator] = [0x2028, 0x2029].map((code) =>
        String.fromCodePoint(code),
      );
      const forged = `first\n## Run 0${lineSeparator}## Run 1${paragraphSeparator}## Run 2\r\n## Run 3`;
      const list = blinded([record('855-today', 1, forged)], 'a seed').lists['855'] ?? '';
      assert.equal([...list.matchAll(/^## Run /gm)].length, 1);
      assert.equal(list.includes(lineSeparator ?? 'none'), false);
      assert.equal(list.includes(paragraphSeparator ?? 'none'), false);
    });

    it('leaves a failed run out of the list and names it, with why, in the codes file', () => {
      const failed: RealRecord = {
        ...record('855-today', 2, 'a finding of a failed run'),
        attempts: [
          attempt('correctness', [finding('a finding of a failed run')], {
            failure: 'it read a file outside its worktree',
          }),
        ],
      };
      const { lists, codes } = blinded([failed, ...records], 'a seed');
      assert.doesNotMatch(lists['855'] ?? '', /failed run/);
      assert.match(codes, /Failed: 855-today run 2: .*outside its worktree/);
    });

    it('uses a second go of a failed run under the run it retried', () => {
      const failed: RealRecord = { ...record('855-today', 1, 'first go'), ended: 'not ended' };
      const again: RunRecord<RealSetup> = { ...record('855-today', 1, 'second go'), retry: true };
      const list = blinded([failed, again], 'a seed').lists['855'] ?? '';
      assert.match(list, /second go/);
      assert.doesNotMatch(list, /first go/);
    });

    it('keeps the first scored go of a run when a run has two', () => {
      const first = record('855-today', 1, 'first scored go');
      const second = record('855-today', 1, 'later go');
      const list = blinded([first, second], 'a seed').lists['855'] ?? '';
      assert.match(list, /first scored go/);
      assert.doesNotMatch(list, /later go/);
    });

    it('reports the tokens and the model of each Taster in the codes file only', () => {
      const run: RealRecord = {
        ...record('855-today', 1, 'x'),
        attempts: [attempt('security', [], { models: ['claude-sonnet-5-5'] })],
      };
      const { lists, codes } = blinded([run], 'a seed');
      assert.match(codes, /\| security \| claude-sonnet-5-5 \| 1 \| 2 \| 3 \| 4 \| 10 \|/);
      assert.doesNotMatch(lists['855'] ?? '', /claude-sonnet|\b10\b/);
    });

    it('the table it prints counts the runs of each setup, scored, failed and retried, and no code', () => {
      const failed: RealRecord = { ...record('855-today', 2, 'x'), ended: 'not ended' };
      const again: RealRecord = { ...record('855-today', 2, 'y'), retry: true };
      const table = realTable([failed, ...records, again]);
      assert.match(table, /\| 855-today \| 2 \| 1 \| 1 \| 0 of 2 \|/);
      assert.match(table, /\| 855-reads \| 2 \| 0 \| 0 \|/);
      assert.match(table, /\| 864-today \| 0 \| 0 \| 0 \|/);
      assert.match(table, /\| 867-reads \| 1 \| 0 \| 0 \|/);
      assert.doesNotMatch(table, new RegExp(codeOf('a seed', '855-today', 1)));
    });
  });

  describe('the dry run', () => {
    it('plays each Taster of the recipe, with a finding on the file it is given and a risk left', () => {
      const tastings = scriptedRealTastings('src/a.ts');
      assert.deepEqual(Object.keys(tastings), [
        'correctness',
        'acceptance',
        'security',
        'design-conformance',
        'together',
      ]);
      const [turn] = tastings.security ?? [];
      assert.equal(turn?.tasting?.findings[0]?.file, 'src/a.ts');
      assert.equal(Array.isArray(turn?.doc?.riskLeft), true);
    });

    it('holds no line of a key: its scripted findings say they are scripted', () => {
      for (const [turn] of Object.values(scriptedRealTastings('src/a.ts'))) {
        assert.match(String(turn?.tasting?.findings[0]?.why), /scripted/);
      }
    });

    it('its transcript reads as a Taster that stayed inside', () => {
      const reads = transcriptReads(scriptedTranscript(WORKTREE, 'opus'), WORKTREE);
      assert.deepEqual(reads.outside, []);
      assert.equal(reads.problem, undefined);
      assert.deepEqual(reads.opened, ['CLAUDE.md']);
    });

    it('its transcript names the model the attempt was planned with', () => {
      const reads = transcriptReads(scriptedTranscript(WORKTREE, 'opus'), WORKTREE);
      assert.deepEqual(reads.models, ['opus']);
    });
  });
});

describe('tasting-compare --real: the opus and high setups (ADR 0344)', () => {
  const DEFAULT_TASTER = readFileSync(join(root, 'defaults', 'brewers', 'taster.md'), 'utf8');
  const REAL_TASTERS = { today: 'the old text', current: DEFAULT_TASTER };
  const SESSION = '00000000-0000-4000-8000-000000000001';

  /** A step's brewer and its `claude` line, through serve's own setup of the scratch Brewery. */
  const commandLine = (setup: RealSetup, stepId = 'correctness'): string[] => {
    const brewery = makeTempDir('tasting-compare-real');
    try {
      const { 'models.jsonc': _, ...nip } = nipBreweryFiles({
        brewery: BREWERY,
        target: TARGET,
        user: USER,
      });
      const files: Record<string, string> = {
        ...nip,
        ...realBreweryFiles(setup, REAL_TASTERS),
        '.foedrum/local.jsonc': localConfig(join(brewery.path, 'work'), join(brewery.path, 'web')),
      };
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(brewery.path, path)), { recursive: true });
        writeFileSync(join(brewery.path, path), text);
      }
      const ready = serveSetup({
        root: brewery.path,
        home: join(brewery.path, 'home'),
        platform: process.platform,
        env: {},
        files: {
          config: files['foedrum.jsonc'],
          local: files['.foedrum/local.jsonc'],
          models: files['models.jsonc'],
          brewery: readBreweryFiles(brewery.path),
        },
        diagnosis: {
          tools: [{ name: 'claude', version: undefined, path: 'claude' }],
          isolation: { level: 'permissions only', why: 'a test' },
          problems: [],
        },
      });
      assert.ok(ready.kind !== 'refused', JSON.stringify(ready));
      const step = ready.setup.brewers.find(realRecipeOf(setup), stepId);
      assert.ok(step !== undefined, stepId);
      return claudeArgs({
        model: modelOf(ready.setup.models, step.brewer),
        effort: step.brewer.effort,
        settingsFile: 'settings.json',
        tools: ['Read'],
        session: { kind: 'new', id: SESSION },
      });
    } finally {
      brewery.remove();
    }
  };

  const withValue = (args: readonly string[], option: string, value: string): string[] =>
    args.map((arg, at) => (args[at - 1] === option ? value : arg));

  it("the opus setup differs from reads by the Taster's model alone", () => {
    const reads = realBreweryFiles('855-reads', REAL_TASTERS);
    const { 'models.jsonc': models, ...others } = realBreweryFiles('855-opus', REAL_TASTERS);
    assert.deepEqual(others, reads);
    assert.ok(models !== undefined);
    assert.deepEqual(JSON.parse(models), { models: { opus: 'opus' }, brewers: { taster: 'opus' } });

    const line = commandLine('855-opus');
    assert.equal(line[line.indexOf('--model') + 1], 'opus');
    assert.equal(line[line.indexOf('--effort') + 1], 'medium');
    assert.deepEqual(withValue(line, '--model', 'sonnet'), commandLine('855-reads'));
    // Only the Taster moves: another brewer of the same alias stays where it was.
    assert.deepEqual(commandLine('855-opus', 'implement'), commandLine('855-reads', 'implement'));
  });

  it("the high setup differs from reads by the Taster's effort alone", () => {
    const reads = realBreweryFiles('855-reads', REAL_TASTERS);
    const { 'brewers/taster.md': taster, ...others } = realBreweryFiles('855-high', REAL_TASTERS);
    assert.deepEqual(others, reads);
    assert.equal(taster, DEFAULT_TASTER.replace('"effort": "medium"', '"effort": "high"'));
    assert.notEqual(taster, DEFAULT_TASTER);

    const line = commandLine('855-high');
    assert.equal(line[line.indexOf('--effort') + 1], 'high');
    assert.equal(line[line.indexOf('--model') + 1], 'sonnet');
    assert.deepEqual(withValue(line, '--effort', 'medium'), commandLine('855-reads'));
  });

  it('both taste each order on its own, with no comment, as its reads setup does: regression test', () => {
    for (const setup of selectRealSetups('opus,high')) {
      const reads = `${setup.slice(0, 3)}-reads` as RealSetup;
      assert.equal(orderOf(setup), orderOf(reads), setup);
      assert.equal(realRecipeOf(setup), REAL_RECIPE, setup);
      assert.equal(
        realBreweryFiles(setup, REAL_TASTERS)[`recipes/${REAL_RECIPE}.jsonc`],
        realBreweryFiles(reads, REAL_TASTERS)[`recipes/${REAL_RECIPE}.jsonc`],
        setup,
      );
      assert.deepEqual(
        realCommentsOf(setup, 'the-maintainer', () => 'a comment'),
        [],
        setup,
      );
    }
  });

  it('the other setups write no models.jsonc, and only today replaces the Taster: regression test', () => {
    for (const setup of ['855-today', '855-reads', '855-lens', '867-comments'] as const) {
      assert.equal(realBreweryFiles(setup, REAL_TASTERS)['models.jsonc'], undefined, setup);
    }
    assert.equal(realBreweryFiles('855-today', REAL_TASTERS)['brewers/taster.md'], 'the old text');
    for (const setup of ['855-reads', '855-lens', '867-comments'] as const) {
      assert.equal(realBreweryFiles(setup, REAL_TASTERS)['brewers/taster.md'], undefined, setup);
    }
  });

  describe('the high Taster', () => {
    it('refuses a default Taster that does not hold medium effort', () => {
      assert.throws(() => highTaster('{ "effort": "low" }'), /effort/);
    });

    it('refuses a default Taster that says it twice, as it could not tell which', () => {
      assert.throws(() => highTaster('"effort": "medium"\n"effort": "medium"\n'), /effort/);
    });

    it('changes that one value and no other text', () => {
      assert.equal(
        highTaster('before\n  "effort": "medium",\nafter $& medium\n'),
        'before\n  "effort": "high",\nafter $& medium\n',
      );
    });
  });

  describe('the model a run ran on', () => {
    const on = (text: string, model: string): string => text.replaceAll('claude-sonnet-5-5', model);

    it('a transcript names the models its session ran on, once each', () => {
      const text = on(transcript(read('a.ts'), outDoc), 'claude-opus-5-5');
      assert.deepEqual(transcriptReads(text, WORKTREE).models, ['claude-opus-5-5']);
      const both = `${transcript(outDoc)}${on(transcript(outDoc), 'claude-opus-5-5')}`;
      assert.deepEqual(transcriptReads(both, WORKTREE).models, [
        'claude-sonnet-5-5',
        'claude-opus-5-5',
      ]);
    });

    it('leaves out the line claude made up for a failed call: it ran on no model', () => {
      const madeUp = JSON.stringify({
        type: 'assistant',
        message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] },
      });
      const text = `${madeUp}\n${transcript(outDoc)}`;
      assert.deepEqual(transcriptReads(text, WORKTREE).models, ['claude-sonnet-5-5']);
    });

    it("reads a model only from the model's own lines", () => {
      const logged = JSON.stringify({
        type: 'api-request-blob',
        message: { model: 'claude-haiku-5-5', content: [] },
      });
      const asked = JSON.stringify({
        type: 'user',
        message: { model: 'claude-haiku-5-5', content: 'The order' },
      });
      const text = `${logged}\n${asked}\n${transcript(outDoc)}`;
      assert.deepEqual(transcriptReads(text, WORKTREE).models, ['claude-sonnet-5-5']);
    });

    it("a record keeps the transcript's model, which is the one codes.md shows", () => {
      const [taster] = realRecordOf(tasted('correctness', { findings: [] }), () =>
        on(transcript(outDoc), 'claude-opus-5-5'),
      ).attempts;
      assert.deepEqual(taster?.models, ['claude-opus-5-5']);
      const run: RealRecord = {
        ...record('855-opus', 1, 'x'),
        attempts: [taster as TasterAttempt],
      };
      assert.match(
        blinded([run], 'a seed').codes,
        /\| 855-opus \| 1 \| correctness \| claude-opus-5-5 \|/,
      );
    });

    const ranOn = (setup: RealSetup, ...models: (readonly string[])[]) => ({
      setup,
      attempts: models.map((each, at) => attempt(`taster-${at}`, [], { models: each })),
    });

    it('the stop of a run reads the model its transcript names', () => {
      const brewed = tasted('correctness', { findings: [] });
      const opus = realRecordOf(brewed, () => on(transcript(outDoc), 'claude-opus-5-5'));
      assert.match(comparisonStop({ setup: '855-reads', ...opus }) ?? '', /claude-opus-5-5/);
      assert.equal(comparisonStop({ setup: '855-opus', ...opus }), undefined);
    });

    it('a run on the model its setup asked for stops nothing', () => {
      assert.equal(modelStop(ranOn('855-opus', ['claude-opus-5-5'])), undefined);
      for (const setup of [
        '855-today',
        '855-reads',
        '855-lens',
        '855-high',
        '867-comments',
      ] as const) {
        assert.equal(modelStop(ranOn(setup, ['claude-sonnet-5-5'])), undefined, setup);
      }
    });

    it('an opus run on sonnet stops the comparison and names both', () => {
      const stop = modelStop(ranOn('855-opus', ['claude-sonnet-5-5']));
      assert.match(stop ?? '', /taster-0/);
      assert.match(stop ?? '', /claude-sonnet-5-5/);
      assert.match(stop ?? '', /opus/);
    });

    it('a high run on opus stops the comparison', () => {
      assert.match(modelStop(ranOn('855-high', ['claude-opus-5-5'])) ?? '', /sonnet/);
    });

    it('one Taster of a run on another model stops it, the last too', () => {
      const stop = modelStop(ranOn('855-opus', ['claude-opus-5-5'], ['claude-sonnet-5-5']));
      assert.match(stop ?? '', /taster-1/);
    });

    it('a session on two models stops it, as one was not asked for', () => {
      const stop = modelStop(ranOn('855-opus', ['claude-opus-5-5', 'claude-sonnet-5-5']));
      assert.match(stop ?? '', /claude-sonnet-5-5/);
    });

    it('a Taster that finished and whose transcript names no model stops it', () => {
      assert.match(modelStop(ranOn('855-opus', [])) ?? '', /no model/);
    });

    it('an attempt that failed by itself, with no model, stops nothing', () => {
      const failed = attempt('security', [], { failure: 'it stalled', models: [] });
      assert.equal(modelStop({ setup: '855-opus', attempts: [failed] }), undefined);
    });

    it('a failed attempt on another model still stops it', () => {
      const failed = attempt('security', [], {
        failure: 'it stalled',
        models: ['claude-haiku-5-5'],
      });
      assert.match(modelStop({ setup: '855-opus', attempts: [failed] }) ?? '', /claude-haiku-5-5/);
    });

    it("keeps a model's text from forging a line of the output", () => {
      const [separator] = [0x2028].map((code) => String.fromCodePoint(code));
      const stop = modelStop(ranOn('855-opus', [`forged\nline${separator}more`]));
      assert.match(stop ?? '', /forged/);
      assert.doesNotMatch(stop ?? '', /\n/);
      assert.equal((stop ?? '').includes(separator ?? 'none'), false);
    });

    it("a dry run's transcript on opus passes an opus setup's check and stops a reads setup's: regression test", () => {
      const dry = (model: string) => transcriptReads(scriptedTranscript(WORKTREE, model), WORKTREE);
      const attempts = [attempt('security', [], { models: dry('opus').models ?? [] })];
      assert.equal(modelStop({ setup: '855-opus', attempts }), undefined);
      assert.match(modelStop({ setup: '855-reads', attempts }) ?? '', /sonnet/);
    });
  });

  describe('--setups', () => {
    it('names the setups of every order, in the order a whole run walks them', () => {
      assert.deepEqual(selectRealSetups('high,opus'), [
        '855-opus',
        '855-high',
        '864-opus',
        '864-high',
        '867-opus',
        '867-high',
      ]);
    });

    it('takes the one setup of a single order', () => {
      assert.deepEqual(selectRealSetups('comments'), ['867-comments']);
    });

    it('refuses a name no setup has, and says which it knows', () => {
      assert.throws(
        () => selectRealSetups('opus,hihg'),
        /hihg.*today, reads, lens, opus, high, opus-bare, high-bare, opus-together, comments/,
      );
    });

    it('refuses an empty name and an order of the name', () => {
      for (const names of ['', 'opus,', '855-opus']) {
        assert.throws(() => selectRealSetups(names), /no setup/, names);
      }
    });

    it('walks only the chosen setups, whatever else the records hold', () => {
      const chosen = selectRealSetups('opus,high');
      const records: RealRecord[] = [record('855-reads', 1, 'x'), record('855-today', 2, 'x')];
      const walked: string[] = [];
      for (
        let next = nextRealRun(records, 1, chosen);
        next !== undefined;
        next = nextRealRun(records, 1, chosen)
      ) {
        walked.push(next.setup);
        records.push(record(next.setup, next.run, 'x'));
      }
      assert.deepEqual(walked, chosen);
    });

    it('goes on where a stopped run of them stopped, from the records', () => {
      const chosen = selectRealSetups('opus,high');
      const stopped = [record('855-high', 1, 'x'), record('855-opus', 1, 'x')];
      assert.deepEqual(nextRealRun(stopped, 1, chosen), {
        setup: '864-opus',
        run: 1,
        retry: false,
      });
    });
  });

  describe('the bare and together setups (ADR 0347)', () => {
    const BARE = () => bareTaster(DEFAULT_TASTER);
    const NIP_LENSES = ['diff/correctness', 'diff/acceptance', 'diff/security'];

    it("the opus-bare setup differs from opus by the Taster's read of the rules alone", () => {
      const opus = realBreweryFiles('855-opus', REAL_TASTERS);
      const { 'brewers/taster.md': taster, ...others } = realBreweryFiles(
        '855-opus-bare',
        REAL_TASTERS,
      );
      assert.deepEqual(others, opus);
      assert.equal(taster, BARE());
      assert.notEqual(taster, DEFAULT_TASTER);
      assert.deepEqual(commandLine('855-opus-bare'), commandLine('855-opus'));
    });

    it("the high-bare setup differs from high by the Taster's read of the rules alone", () => {
      const { 'brewers/taster.md': high, ...highOthers } = realBreweryFiles(
        '855-high',
        REAL_TASTERS,
      );
      const { 'brewers/taster.md': taster, ...others } = realBreweryFiles(
        '855-high-bare',
        REAL_TASTERS,
      );
      assert.deepEqual(others, highOthers);
      // high's effort and bare's cut, whichever comes first.
      assert.equal(taster, highTaster(BARE()));
      assert.equal(taster, bareTaster(high ?? ''));
      assert.notEqual(taster, high);
      assert.deepEqual(commandLine('855-high-bare'), commandLine('855-high'));
    });

    it('the opus-together setup tastes the three lenses in one step on Opus', () => {
      const files = realBreweryFiles('855-opus-together', REAL_TASTERS);
      assert.equal(realRecipeOf('855-opus-together'), 'real-nip-together');
      const recipe = Recipe.parse(parseJsonc(files['recipes/real-nip-together.jsonc'] ?? ''));
      const tasters = recipe.steps.filter((step) => 'brewer' in step && step.brewer === 'taster');
      assert.deepEqual(tasters, [{ id: 'together', brewer: 'taster', lenses: NIP_LENSES }]);
      assert.equal(
        recipe.steps.some((step) => 'parallel' in step),
        false,
      );
      assert.equal(files['brewers/taster.md'], BARE());
      assert.equal(
        files['models.jsonc'],
        realBreweryFiles('855-opus', REAL_TASTERS)['models.jsonc'],
      );

      const line = commandLine('855-opus-together', 'together');
      assert.equal(line[line.indexOf('--model') + 1], 'opus');
      assert.deepEqual(line, commandLine('855-opus-bare'));
    });

    it('the together recipe loads as a Brewery file, blocks nowhere, and opens a pull request', () => {
      const files = realBreweryFiles('855-opus-together', REAL_TASTERS);
      const brewery = makeTempDir('tasting-compare-real');
      try {
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(dirname(join(brewery.path, path)), { recursive: true });
          writeFileSync(join(brewery.path, path), text);
        }
        const loaded = loadRecipes(readBreweryFiles(brewery.path));
        assert.deepEqual(loaded.valid ? [] : loaded.problems, []);
      } finally {
        brewery.remove();
      }
      const recipe = Recipe.parse(parseJsonc(files['recipes/real-nip-together.jsonc'] ?? ''));
      assert.ok(recipe.steps.some((step) => 'action' in step && step.action === 'openPullRequest'));
      for (const step of recipe.steps) {
        assert.equal('blocking' in step ? step.blocking : undefined, undefined);
      }
    });

    it('the bare Taster leaves out every line that tells it to read the rules', () => {
      const bare = BARE();
      for (const words of [
        'CLAUDE.md',
        'AGENTS.md',
        'Rules read',
        "read the repository's rules",
        'read them yourself',
        '**What to read.**',
      ]) {
        assert.equal(bare.includes(words), false, words);
        assert.equal(DEFAULT_TASTER.includes(words), true, words);
      }
    });

    it('the bare Taster keeps every other line of the default byte for byte', () => {
      const bare = BARE().split('\n');
      const all = DEFAULT_TASTER.split('\n');
      assert.equal(bare.length, all.length - 6);
      const changed = bare.filter((line) => !all.includes(line));
      assert.equal(changed.length, 1, changed.join('\n'));
      const [shortened = ''] = changed;
      assert.ok(shortened.startsWith('- **Read the change first.**'), shortened);
      assert.ok(all.some((line) => line !== shortened && line.startsWith(shortened)));
      for (const kept of [
        "## The repository's rules",
        '- **What they are.**',
        '- **When the change edits them.**',
        '## Out doc',
        '## Your handover',
      ]) {
        assert.ok(
          bare.some((line) => line.startsWith(kept)),
          kept,
        );
      }
      // Every line it keeps stays in the default's order.
      let at = 0;
      for (const line of bare.filter((each) => each !== shortened)) {
        at = all.indexOf(line, at);
        assert.ok(at >= 0, line);
        at += 1;
      }
    });

    it('refuses a default Taster that no longer holds one of the texts it cuts', () => {
      for (const words of [
        'your first tool call reads',
        "On a diff, read the repository's rules as the section below says",
        "nothing has loaded the repository's rules for you",
        '**What to read.**',
        'starts with a line `Rules read:`',
      ]) {
        assert.throws(
          () => bareTaster(DEFAULT_TASTER.replace(words, 'other words')),
          /bare would compare nothing/,
          words,
        );
      }
    });

    it('refuses a default Taster that holds a text it cuts twice, as it could not tell which', () => {
      const first = DEFAULT_TASTER.split('\n').find((line) => line.includes('**What to read.**'));
      assert.throws(
        () => bareTaster(`${DEFAULT_TASTER}\n${first}\n`),
        /bare would compare nothing/,
      );
    });

    it('the opus-bare and opus-together setups ask for opus, and high-bare for sonnet', () => {
      const ranOn = (setup: RealSetup, model: string) => ({
        setup,
        attempts: [attempt('together', [], { models: [model] })],
      });
      for (const setup of ['855-opus-bare', '867-opus-together'] as const) {
        assert.equal(modelStop(ranOn(setup, 'claude-opus-5-5')), undefined, setup);
        assert.match(modelStop(ranOn(setup, 'claude-sonnet-5-5')) ?? '', /asks for opus/, setup);
      }
      assert.equal(modelStop(ranOn('864-high-bare', 'claude-sonnet-5-5')), undefined);
      assert.match(modelStop(ranOn('864-high-bare', 'claude-opus-5-5')) ?? '', /asks for sonnet/);
    });

    it('--setups names the three of them alone, order by order', () => {
      assert.deepEqual(selectRealSetups('opus-together,opus-bare,high-bare'), [
        '855-opus-bare',
        '855-high-bare',
        '855-opus-together',
        '864-opus-bare',
        '864-high-bare',
        '864-opus-together',
        '867-opus-bare',
        '867-high-bare',
        '867-opus-together',
      ]);
    });

    it('a record reads the together Taster with its three lenses', () => {
      const lensed = { ...finding('a hole'), lens: 'diff/security' };
      const { attempts } = realRecordOf(tasted('together', { findings: [lensed] }), () =>
        transcript(outDoc),
      );
      assert.deepEqual(
        attempts.map(({ stepId, lenses, findings }) => [stepId, lenses, findings.length]),
        [['together', NIP_LENSES, 1]],
      );
    });

    const together = (): TasterAttempt => ({
      ...attempt(
        'together',
        [
          { ...finding('a hole'), lens: 'diff/security' },
          { ...finding('a missed item'), lens: 'diff/acceptance' },
          { ...finding('a wrong sum'), lens: 'diff/correctness' },
        ],
        {
          riskLeft: ['diff/security: the token was not read', 'no lens named here'],
          models: ['claude-opus-5-5'],
        },
      ),
      lenses: NIP_LENSES,
    });

    it("an opus-together run's list has the headings of an opus-bare run's, in the same order", () => {
      const bare: RealRecord = {
        ...record('855-opus-bare', 1, 'x'),
        attempts: [
          attempt('security', [finding('a hole')]),
          attempt('correctness', [finding('a wrong sum')]),
          attempt('acceptance', [finding('a missed item')]),
        ],
      };
      const joined: RealRecord = { ...record('855-opus-together', 1, 'x'), attempts: [together()] };
      const headings = (run: RealRecord) =>
        [...(blinded([run], 'a seed').lists['855'] ?? '').matchAll(/^###? .*$/gm)]
          .map(([line]) => line)
          .filter((line) => !line.startsWith('## Run '));
      assert.deepEqual(headings(joined), [
        '### correctness (diff/correctness)',
        '### acceptance (diff/acceptance)',
        '### security (diff/security)',
      ]);
      assert.deepEqual(headings(joined), headings(bare));
      assert.doesNotMatch(blinded([joined], 'a seed').lists['855'] ?? '', /together/);
    });

    it('shows each of its findings and risks under the lens it names, the rest under the first', () => {
      const run: RealRecord = { ...record('855-opus-together', 1, 'x'), attempts: [together()] };
      const list = blinded([run], 'a seed').lists['855'] ?? '';
      const under = (lens: string) => {
        const from = list.indexOf(`### ${lens} (`);
        const next = list.indexOf('### ', from + 1);
        return list.slice(from, next === -1 ? undefined : next);
      };
      assert.match(under('correctness'), /a wrong sum/);
      assert.match(under('correctness'), /- no lens named here/);
      assert.match(under('acceptance'), /a missed item/);
      assert.match(under('security'), /a hole/);
      assert.match(under('security'), /^- the token was not read$/m);
      assert.doesNotMatch(under('correctness'), /a hole|a missed item|token/);
    });

    it('codes.md keeps one row for the together Taster, with its model', () => {
      const run: RealRecord = { ...record('855-opus-together', 1, 'x'), attempts: [together()] };
      const { codes } = blinded([run], 'a seed');
      const rows = codes.split('\n').filter((line) => line.includes('855-opus-together'));
      assert.equal(rows.length, 1);
      assert.match(rows[0] ?? '', /\| together \| claude-opus-5-5 \|/);
    });

    it('the table counts, per setup, the Tasters of its scored runs that opened the instruction file', () => {
      const opened = (setup: RealSetup, run: number, ...files: (readonly string[])[]) => ({
        ...record(setup, run, 'x'),
        attempts: files.map((each, at) => attempt(`taster-${at}`, [], { opened: each })),
      });
      const table = realTable([
        opened('855-opus-bare', 1, ['src/a.ts', 'CLAUDE.md'], ['src/a.ts'], []),
        opened('855-opus-bare', 2, ['AGENTS.md'], ['docs/CLAUDE.md'], ['claude.md.bak']),
        { ...opened('855-opus-bare', 3, ['CLAUDE.md']), ended: 'not ended' },
        opened('855-opus-together', 1, ['CLAUDE.md']),
      ]);
      assert.match(table, /\| 855-opus-bare \| 2 \| 1 \| 0 \| 2 of 6 \|/);
      assert.match(table, /\| 855-opus-together \| 1 \| 0 \| 0 \| 1 of 1 \|/);
      assert.match(table, /\| 855-opus \| 0 \| 0 \| 0 \| 0 of 0 \|/);
    });

    it('the dry run plays the together Taster with a finding of each lens, each naming it', () => {
      const [turn] = scriptedRealTastings('src/a.ts').together ?? [];
      assert.deepEqual(
        turn?.tasting?.findings.map((each) => (each as { lens?: string }).lens),
        NIP_LENSES,
      );
    });
  });

  describe('--comparison (ADR 0347)', () => {
    it('a comparison has a folder of its own under the real folder', () => {
      assert.deepEqual(realFolders(undefined), ['real']);
      assert.deepEqual(realFolders('933'), ['real', '933']);
      assert.deepEqual(realFolders('bare-and-together'), ['real', 'bare-and-together']);
    });

    it('refuses a name with a path part, or none', () => {
      for (const name of ['', '..', '../933', '933/x', '933\\x', 'C:', '.', '~', 'a b', '-933']) {
        assert.throws(() => realFolders(name), /--comparison/, name);
      }
    });

    it("a comparison's lists and codes.md hold none of the records outside its folder", () => {
      const tmp = makeTempDir('tasting-compare-real');
      try {
        const results = (folder: string, ...records: RealRecord[]) => {
          mkdirSync(folder, { recursive: true });
          writeFileSync(
            join(folder, 'results.jsonl'),
            records.map((each) => `${JSON.stringify(each)}\n`).join(''),
          );
        };
        const outer = join(tmp.path, ...realFolders(undefined));
        const inner = join(tmp.path, ...realFolders('933'));
        results(
          outer,
          record('855-reads', 1, 'an earlier finding'),
          record('864-opus', 1, 'older'),
        );
        results(inner, record('855-reads', 1, 'a control finding'));
        const read = readRecordsIn<RealSetup>(inner);
        assert.deepEqual(
          read.map(({ setup, run }) => [setup, run]),
          [['855-reads', 1]],
        );
        const { lists, codes } = blinded(read, 'a seed');
        assert.match(lists['855'] ?? '', /a control finding/);
        assert.doesNotMatch(lists['855'] ?? '', /an earlier finding/);
        assert.deepEqual(Object.keys(lists), ['855']);
        assert.doesNotMatch(codes, /864-opus/);
        assert.deepEqual(readRecordsIn(join(tmp.path, 'none')), []);
      } finally {
        tmp.remove();
      }
    });
  });
});

describe('tasting-compare --real: 867-comments (ADR 0333)', () => {
  const read = (file: string) =>
    readFileSync(new URL(`../fixtures/tasting-compare/real/${file}`, import.meta.url), 'utf8');

  it('holds the one comment #867 had before it brewed, in its exact words and date', () => {
    const comments = realCommentsOf('867-comments', 'the-maintainer', read);
    assert.equal(comments.length, 1);
    const [only] = comments;
    assert.equal(only?.author, 'the-maintainer');
    assert.equal(only?.association, 'OWNER');
    assert.equal(only?.created, '2026-11-05T19:44:00Z');
    assert.match(only?.body ?? '', /^Wider than first seen: `foedrum brew` hits it too\./);
    assert.match(only?.body ?? '', /through serve or brew\.$/);
  });

  it('no other setup holds a comment', () => {
    for (const setup of REAL_SETUPS.filter((each) => each !== '867-comments')) {
      assert.deepEqual(realCommentsOf(setup, 'the-maintainer', read), [], setup);
    }
  });

  it('the lens setups hold no comment: regression test', () => {
    const lens = REAL_SETUPS.filter((each) => each.endsWith('-lens'));
    assert.deepEqual(lens, ['855-lens', '864-lens', '867-lens']);
    for (const setup of lens) {
      assert.deepEqual(realCommentsOf(setup, 'the-maintainer', read), [], setup);
    }
  });

  it('brews nip without the lens setup Taster: regression test', () => {
    assert.equal(realRecipeOf('867-comments'), REAL_RECIPE);
    assert.deepEqual(Object.keys(realBreweryFiles('867-comments', TASTERS)), [
      `recipes/${REAL_RECIPE}.jsonc`,
    ]);
  });

  it('differs from 867-reads only by the comment: the default Taster, the same order and the same files', () => {
    assert.deepEqual(
      realBreweryFiles('867-comments', TASTERS),
      realBreweryFiles('867-reads', TASTERS),
    );
    assert.equal(orderOf('867-comments'), orderOf('867-reads'));
  });
});
