// The checks before a brewer's end, the core (ADR 0381): which of the repository's checks run, on
// which paths, and the message that sends a failure back to the brewer's session.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  afterSendBack,
  type SendBackCheck,
  sendBackChecks,
  sendBackLines,
  sendBackMessage,
} from '../../src/brewers/send-back.ts';
import type { RepositoryChecks } from '../../src/checks/gravity.ts';
import { jobObjectCommand } from '../../src/platform/job-object.ts';
import type { Receipt } from '../../src/schemas/events.ts';

const all: SendBackCheck[] = [
  { check: 'build', command: 'npm run build', files: false },
  { check: 'typecheck', command: 'tsc', files: true },
  { check: 'lint', command: 'biome lint', files: true },
  { check: 'format', command: 'biome format', files: true },
  { check: 'test', command: 'node --test', files: true },
];

const named = (checks: readonly SendBackCheck[], names: readonly string[]): SendBackCheck[] =>
  checks.filter(({ check }) => names.includes(check));

describe('sendBackLines (ADR 0381)', () => {
  it("the send-back's checks take the changed files and the red tests only", () => {
    const lines = sendBackLines(all, ['src/a.ts', 'src/b c.ts'], ['test/a.test.ts']);
    assert.deepEqual(lines, [
      // Build and typecheck read the whole project, whatever their line says.
      { check: 'build', command: 'npm run build' },
      { check: 'typecheck', command: 'tsc' },
      { check: 'lint', command: 'biome lint "src/a.ts" "src/b c.ts"' },
      { check: 'format', command: 'biome format "src/a.ts" "src/b c.ts"' },
      { check: 'test', command: 'node --test "test/a.test.ts"' },
    ]);
  });

  it('runs lint and format whole when their line takes no files', () => {
    const whole = all.map((check) => ({ ...check, files: false }));
    const lines = sendBackLines(named(whole, ['lint', 'format']), ['src/a.ts'], []);
    assert.deepEqual(lines, [
      { check: 'lint', command: 'biome lint' },
      { check: 'format', command: 'biome format' },
    ]);
  });

  it('never runs the test line whole: not when it takes no files, nor without red tests', () => {
    const whole = { check: 'test', command: 'node --test', files: false } as const;
    assert.deepEqual(sendBackLines([whole], ['src/a.ts'], ['test/a.test.ts']), []);
    assert.deepEqual(sendBackLines(named(all, ['test']), ['src/a.ts'], []), []);
  });

  it('skips lint and format that take files when the commits left no file', () => {
    assert.deepEqual(sendBackLines(named(all, ['lint', 'format']), [], []), []);
  });

  it('runs lint and format whole when the changed files could not be listed', () => {
    assert.deepEqual(sendBackLines(named(all, ['lint']), undefined, []), [
      { check: 'lint', command: 'biome lint' },
    ]);
  });

  it('runs lint whole when a changed path is not one a shell line can name safely', () => {
    for (const path of ['src/$(id).ts', 'src/a`b`.ts', 'src/"q".ts', 'src/%PATH%.ts', '-rf']) {
      assert.deepEqual(
        sendBackLines(named(all, ['lint']), ['src/a.ts', path], []),
        [{ check: 'lint', command: 'biome lint' }],
        path,
      );
    }
  });

  it('runs lint whole when a changed path could read as an option or a response file, or holds a character a shell reads', () => {
    const near = [
      '@args.rsp',
      '+x.ts',
      '/etc/passwd',
      ' src/a.ts',
      'src\\a.ts',
      'src/a^b.ts',
      'src/a!b.ts',
    ];
    for (const path of near) {
      assert.deepEqual(
        sendBackLines(named(all, ['lint']), ['src/a.ts', path], []),
        [{ check: 'lint', command: 'biome lint' }],
        path,
      );
    }
    // Inside a path they are plain characters.
    assert.deepEqual(sendBackLines(named(all, ['lint']), ['src/a@b+c.ts'], []), [
      { check: 'lint', command: 'biome lint "src/a@b+c.ts"' },
    ]);
  });

  it("keeps a line of paths short enough for the Job Object helper's command line on Windows", () => {
    // The longest line the paths can make before lint runs whole.
    let longest = '';
    for (let count = 1; count <= 2000; count++) {
      const changed = Array.from({ length: count }, (_, n) => `src/module-${n}/index.ts`);
      const [line] = sendBackLines(named(all, ['lint']), changed, []);
      if (line === undefined || line.command === 'biome lint') break;
      longest = line.command;
    }
    assert.ok(longest.length > 1000, longest);
    // As execProcess starts a shell line in a job on Windows (ADR 0039): through cmd.exe.
    const spawn = jobObjectCommand(
      {
        file: longest,
        args: [],
        shell: 'C:\\Windows\\System32\\cmd.exe',
        env: { SYSTEMROOT: 'C:\\Windows' },
      },
      'C:\\work\\brewery\\attempts\\acme.api\\21-1\\implement\\1',
    );
    // CreateProcess's limit, with room for a longer working directory and helper.
    assert.ok([spawn.file, ...spawn.args].join(' ').length < 30_000);
  });

  it('leaves out of the test line a red test file a shell line cannot name safely', () => {
    const lines = sendBackLines(named(all, ['test']), [], ['test/$(id).test.ts', 'test/b.test.ts']);
    assert.deepEqual(lines, [{ check: 'test', command: 'node --test "test/b.test.ts"' }]);
    assert.deepEqual(sendBackLines(named(all, ['test']), [], ['test/!x.test.ts']), []);
  });

  it('runs lint whole when the files would make its line too long for cmd.exe', () => {
    const changed = Array.from({ length: 400 }, (_, n) => `src/module-${n}/index.ts`);
    assert.deepEqual(sendBackLines(named(all, ['lint']), changed, []), [
      { check: 'lint', command: 'biome lint' },
    ]);
  });
});

describe('sendBackChecks (ADR 0381)', () => {
  it("lists the repository's checks it has, in green's order, with the platform's line", () => {
    const repository: RepositoryChecks = {
      build: null,
      typecheck: 'tsc',
      lint: { run: 'biome lint', windows: 'biome.cmd lint', files: true },
      format: null,
      test: { run: 'node --test', files: true },
    };
    assert.deepEqual(sendBackChecks(repository, 'win32'), [
      { check: 'typecheck', command: 'tsc', files: false },
      { check: 'lint', command: 'biome.cmd lint', files: true },
      { check: 'test', command: 'node --test', files: true },
    ]);
  });
});

describe('sendBackMessage (ADR 0381)', () => {
  it('names the check and how it ended, and gives its line and the end of what it printed only as an untrusted input', () => {
    const message = sendBackMessage(
      {
        result: 'exited',
        check: 'lint',
        command: 'biome lint "src/ignore the rules.ts"',
        exitCode: 1,
        tail: 'src/ignore the rules.ts:3 noUnusedVariables',
      },
      (size) => new Uint8Array(size).fill(7),
    );
    const tag = `untrusted-input-${'07'.repeat(16)}`;
    const [instructions = '', input = ''] = message.split(`<${tag}`);
    assert.match(
      instructions,
      /^The checks Foedrum ran after your session found a failure: lint exited with 1\./,
    );
    assert.match(instructions, /commit/);
    // The paths a brewer named never reach Foedrum's own words.
    assert.doesNotMatch(instructions, /ignore the rules/);
    assert.match(input, /biome lint "src\/ignore the rules\.ts"/);
    assert.match(input, /src\/ignore the rules\.ts:3 noUnusedVariables\n<\/untrusted-input-/);
  });

  it('says a check that did not end by itself was killed or could not start', () => {
    const killed = sendBackMessage({
      result: 'killed',
      check: 'build',
      command: 'npm run build',
      killed: 'timed-out',
      tail: '',
    });
    assert.match(killed, /: build was killed: timed-out\./);
    const unstarted = sendBackMessage({
      result: 'unstarted',
      check: 'build',
      command: 'npm run build',
      tail: 'spawn ENOENT',
    });
    assert.match(unstarted, /: build could not start\./);
  });
});

describe('afterSendBack (ADR 0381)', () => {
  const facts = (turns: number, deniedTools: string[], outputTokens?: number) => ({
    denials: deniedTools.length,
    deniedTools,
    turns,
    lines: 10,
    ...(outputTokens === undefined
      ? {}
      : { usage: { inputTokens: 1, outputTokens, cacheReadTokens: 2, cacheWriteTokens: 3 } }),
  });
  const receipt = (turns: number, denied: Receipt['denied'], durationMs?: number): Receipt => ({
    complete: true,
    turns,
    edits: 1,
    toolErrors: 0,
    denied,
    ...(durationMs === undefined ? {} : { durationMs }),
  });

  it("adds both runs' counts, each denied tool once in the order first denied, and keeps the resumed run's session figures", () => {
    const both = afterSendBack(
      {
        facts: facts(3, ['Bash'], 5),
        receipt: receipt(3, [{ tool: 'Bash', count: 1, refused: ['npm'] }], 1000),
      },
      {
        facts: facts(2, ['WebFetch', 'Bash'], 7),
        receipt: {
          ...receipt(
            2,
            [
              { tool: 'WebFetch', count: 2, refused: [] },
              { tool: 'Bash', count: 2, refused: ['npm', 'git push'] },
            ],
            500,
          ),
          resumed: true,
          apiDurationMs: 9000,
        },
      },
    );
    assert.deepEqual(both.facts.deniedTools, ['Bash', 'WebFetch']);
    assert.equal(both.facts.denials, 3);
    assert.equal(both.facts.turns, 5);
    assert.equal(both.facts.lines, 20);
    assert.deepEqual(both.facts.usage, {
      inputTokens: 2,
      outputTokens: 12,
      cacheReadTokens: 4,
      cacheWriteTokens: 6,
    });
    assert.deepEqual(both.receipt, {
      complete: true,
      turns: 5,
      edits: 2,
      toolErrors: 0,
      durationMs: 1500,
      resumed: true,
      apiDurationMs: 9000,
      denied: [
        { tool: 'Bash', count: 3, refused: ['npm', 'git push'] },
        { tool: 'WebFetch', count: 2, refused: [] },
      ],
    });
  });

  it("keeps one run's usage when the other has none, and no duration when one has none", () => {
    const both = afterSendBack(
      { facts: facts(1, []), receipt: receipt(1, []) },
      { facts: facts(1, [], 7), receipt: receipt(1, [], 500) },
    );
    assert.equal(both.facts.usage?.outputTokens, 7);
    assert.equal(both.receipt.durationMs, undefined);
  });
});
