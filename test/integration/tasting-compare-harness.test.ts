// The comparison's harness (#1156), run whole on the Nip fixture with every brewer scripted: each run
// it brews shows the live line `foedrum brew` shows where ADR 0174's rule holds, and prints the start
// and end lines as before where it does not. Real git and node, no gh, no claude.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  compare,
  type HarnessScreen,
  harnessScreen,
  type Mode,
  write,
} from '../../scripts/tasting-compare/harness.ts';
import type { TerminalStream } from '../../src/cli/live-terminal.ts';
import { removeTree } from '../../src/platform/remove.ts';
import { hangGuardMs } from '../helpers/load.ts';
import { NIP_ORDER, NIP_SCRIPT, NIP_TARGET_FILES } from '../helpers/nip-fixture.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

/** Every scripted attempt of a run, which the run's hang guard counts. */
const attempts = Object.values(NIP_SCRIPT).reduce((n, turns) => n + turns.length, 0);

/** Nip's comparison: one setup, whose order is Nip's own, brewed by its scripted brewers. */
const nipMode = (orderFile: string, more: Partial<Mode<'nip'>> = {}): Mode<'nip'> => ({
  folders: ['nip'],
  setups: ['nip'],
  order: () => orderFile,
  recipeOf: () => 'nip',
  breweryFiles: () => ({}),
  target: async (_setup, scratch, git) => {
    await git(scratch, ['init', '-q', '--bare', '--initial-branch=main', 'web.git']);
    await git(scratch, ['clone', '-q', 'web.git', 'web']);
    const web = join(scratch, 'web');
    for (const [path, text] of Object.entries(NIP_TARGET_FILES)) write(join(web, path), text);
    await git(web, ['add', '--all']);
    await git(web, ['commit', '-q', '-m', 'Start web']);
    await git(web, ['push', '-q', 'origin', 'main']);
  },
  script: async () => NIP_SCRIPT,
  scriptedStep: 'implement',
  next: (records, runs) =>
    records.length < runs ? { setup: 'nip', run: records.length + 1, retry: false } : undefined,
  recordOf: async (events) => ({
    ended: events.some(({ event }) => event.type === 'batch.on_tap') ? 'on_tap' : 'not on tap',
    attempts: [],
  }),
  table: (records) => `table of ${records.length} runs\n`,
  ...more,
});

/** A terminal stream that records each call, in order, with the lines written elsewhere. */
const recordingStream = (calls: string[], more: Partial<TerminalStream> = {}): TerminalStream => ({
  isTTY: true,
  columns: 100,
  rows: 30,
  on: () => {},
  off: () => {},
  cursorTo: (x) => calls.push(`cursorTo(${x})`) > 0,
  moveCursor: (dx, dy) => calls.push(`moveCursor(${dx}, ${dy})`) > 0,
  clearLine: (direction) => calls.push(`clearLine(${direction})`) > 0,
  clearScreenDown: () => calls.push('clearScreenDown()') > 0,
  write: (text) => calls.push(`write(${JSON.stringify(text)})`) > 0,
  ...more,
});

describe('the comparison harness', () => {
  let dir: TempDir;
  let orderFile: string;
  let folder: string;
  /** What the harness wrote to standard output and standard error, in order. */
  let output: string[];
  /** The environment as the test found it: the harness sets git's variables in it. */
  const env = { ...process.env };
  beforeEach(() => {
    dir = makeTempDir('tasting-compare-harness');
    orderFile = join(dir.path, 'order.md');
    writeFileSync(orderFile, `${NIP_ORDER.title}\n${NIP_ORDER.body}`);
    folder = join(dir.path, 'nip');
    output = [];
    // Only the harness's own text: the test runner's reports are bytes, and go on their way.
    for (const [stream, prefix] of [
      [process.stdout, ''],
      [process.stderr, 'stderr: '],
    ] as const) {
      const through = stream.write.bind(stream) as (chunk: unknown) => boolean;
      mock.method(stream, 'write', (chunk: unknown) =>
        typeof chunk === 'string' ? output.push(`${prefix}${chunk}`) > 0 : through(chunk),
      );
    }
  });
  afterEach(async () => {
    mock.restoreAll();
    for (const name of Object.keys(process.env)) {
      if (!(name in env)) delete process.env[name];
    }
    Object.assign(process.env, env);
    await removeTree(dir.path);
  });

  it('prints the start and end lines of a run, and the table, as plain lines where CI is set', {
    timeout: attempts * hangGuardMs,
  }, async () => {
    // The default screen is standard output's, and ADR 0174's rule fails there whatever it is.
    process.env.CI = 'true';
    await compare(nipMode(orderFile), { folder, runs: 1, dryRun: true, claude: 'never started' });

    assert.equal(output[0], `tasting-compare: 1 runs of nip in ${folder}, the brewers scripted\n`);
    assert.equal(output[1], 'tasting-compare: nip-1\n');
    const ended = output.at(-3) ?? '';
    assert.match(ended, /^tasting-compare: nip-1 ended (?:on_tap|not on tap) in \d+ s\n$/);
    assert.deepEqual(output.slice(-2), ['\n', 'table of 1 runs\n']);
    assert.equal(
      output.filter((text) => text.includes('\u001b')).length,
      0,
      'no control sequence of a live line',
    );
    assert.equal(readFileSync(join(folder, 'table.md'), 'utf8'), 'table of 1 runs\n');
  });

  it('keeps a live line on the terminal while a run brews, with the start and end lines over it', {
    timeout: attempts * hangGuardMs,
  }, async () => {
    const calls: string[] = [];
    const screen: HarnessScreen = harnessScreen(recordingStream(calls), {});
    await compare(nipMode(orderFile), {
      folder,
      runs: 1,
      dryRun: true,
      claude: 'never started',
      screen,
    });

    // A live line is drawn in place: the cursor to the first column, the line without a line
    // break, and the rest of the row cleared. A lasting line ends with its line break.
    const live = calls.flatMap((call, i) =>
      calls[i - 1] === 'cursorTo(0)' && calls[i + 1] === 'clearLine(1)' ? [call] : [],
    );
    assert.ok(live.length > 0, calls.join('\n'));
    assert.ok(
      live.every((call) => !call.endsWith('\\n")')),
      live.join('\n'),
    );
    const lasting = calls.filter((call) => call.startsWith('write(') && call.endsWith('\\n")'));
    assert.ok(lasting.includes('write("tasting-compare: nip-1\\n")'), lasting.join('\n'));
    assert.ok(
      lasting.some((call) =>
        /^write\("tasting-compare: nip-1 ended (?:on_tap|not on tap) in \d+ s\\n"\)$/.test(call),
      ),
      lasting.join('\n'),
    );
    // The live line is off the screen after the last run's end line, before the table, which
    // standard output gets.
    assert.deepEqual(calls.slice(-3), ['cursorTo(0)', 'clearLine(0)', 'write("\\n")']);
    assert.equal(output.at(-1), 'table of 1 runs\n');
  });

  it('clears the live line before it says why a run could not run, and stops', async () => {
    const calls: string[] = [];
    const screen = harnessScreen(recordingStream(calls), {});
    mock.method(process, 'exit', (code: number) => {
      throw new Error(`exit ${code}`);
    });
    const broken = nipMode(orderFile, {
      target: async () => {
        throw new Error('no target');
      },
    });

    await assert.rejects(
      compare(broken, { folder, runs: 1, dryRun: true, claude: 'never started', screen }),
      /^Error: exit 1$/,
    );

    const said = output.filter((text) => text.startsWith('stderr: '));
    assert.deepEqual(said, ['stderr: tasting-compare: nip-1 could not run: no target\n']);
    assert.deepEqual(calls.slice(-2), ['cursorTo(0)', 'clearLine(0)']);
  });
});
