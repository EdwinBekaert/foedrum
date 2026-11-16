import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type Files,
  folderFiles,
  type ProofRun,
  proofProblem,
  proofRuns,
  readOrder,
  startingTree,
  withLayer,
} from '../../scripts/flight-orders.ts';
import { makeTempDir } from '../helpers/temp-dir.ts';

const ORDER_JSON = JSON.stringify({
  trap: { kind: 'edge-case', line: 'A night shift ends the next day.' },
  allowedPaths: ['src/', 'test/'],
});

const files = (changes: Record<string, string | undefined> = {}): Files => {
  const all: Record<string, string | undefined> = {
    'order.md': 'Count a shift\n\nAdd shiftMinutes.\n',
    'order.json': ORDER_JSON,
    'base/INSTRUCTIONS.fixture.md': '# Rules\n',
    'base/src/shift.mjs': 'export {};\n',
    'base/test/shift.test.mjs': "import '../src/shift.mjs';\n",
    'solution/src/shift.mjs': 'export const shiftMinutes = () => 0;\n',
    'hidden/test/hidden/shift.test.mjs': 'night\n',
    'hidden/test/hidden/day.test.mjs': 'day\n',
    ...changes,
  };
  return Object.fromEntries(
    Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
};

const refusal = (changes: Record<string, string | undefined>): string => {
  try {
    readOrder('timesheet', files(changes));
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail('the order was read');
};

test('reads an order: its title, text, trap, allowed paths and its three trees', () => {
  const order = readOrder('timesheet', files());
  assert.equal(order.name, 'timesheet');
  assert.equal(order.title, 'Count a shift');
  assert.equal(order.text, 'Count a shift\n\nAdd shiftMinutes.\n');
  assert.deepEqual(order.trap, { kind: 'edge-case', line: 'A night shift ends the next day.' });
  assert.deepEqual(order.allowedPaths, ['src/', 'test/']);
  assert.deepEqual(Object.keys(order.base).sort(), [
    'INSTRUCTIONS.fixture.md',
    'src/shift.mjs',
    'test/shift.test.mjs',
  ]);
  assert.deepEqual(order.solution, { 'src/shift.mjs': 'export const shiftMinutes = () => 0;\n' });
  assert.deepEqual(Object.keys(order.hidden).sort(), [
    'test/hidden/day.test.mjs',
    'test/hidden/shift.test.mjs',
  ]);
});

test('refuses an order with no reference solution', () => {
  assert.match(refusal({ 'solution/src/shift.mjs': undefined }), /timesheet: no solution\//);
});

test('refuses an order with no hidden tests', () => {
  const message = refusal({
    'hidden/test/hidden/shift.test.mjs': undefined,
    'hidden/test/hidden/day.test.mjs': undefined,
  });
  assert.match(message, /timesheet: no hidden\//);
});

test('refuses a hidden file outside test/hidden/', () => {
  const message = refusal({ 'hidden/test/shift.test.mjs': 'x\n' });
  assert.match(message, /timesheet: hidden\/test\/shift\.test\.mjs is not under test\/hidden\//);
});

test('refuses a hidden file in a sibling folder whose name starts with hidden', () => {
  const message = refusal({ 'hidden/test/hiddenx/shift.test.mjs': 'x\n' });
  assert.match(
    message,
    /timesheet: hidden\/test\/hiddenx\/shift\.test\.mjs is not under test\/hidden\//,
  );
});

test('reads the title of an order.md with CRLF line ends', () => {
  const order = readOrder(
    'timesheet',
    files({ 'order.md': 'Count a shift\r\n\r\nAdd shiftMinutes.\r\n' }),
  );
  assert.equal(order.title, 'Count a shift');
});

test('refuses an order with no base', () => {
  const message = refusal({
    'base/INSTRUCTIONS.fixture.md': undefined,
    'base/src/shift.mjs': undefined,
    'base/test/shift.test.mjs': undefined,
  });
  assert.match(message, /timesheet: no base\//);
});

test('refuses an order with no order.md', () => {
  assert.match(refusal({ 'order.md': undefined }), /timesheet: no order\.md/);
});

test('refuses an order.json whose trap is of no known kind', () => {
  const json = JSON.stringify({ trap: { kind: 'typo', line: 'x' }, allowedPaths: ['src/'] });
  assert.match(refusal({ 'order.json': json }), /timesheet: order\.json .*at trap\.kind/);
});

test('refuses an order.json with no allowed paths', () => {
  const json = JSON.stringify({ trap: { kind: 'edge-case', line: 'x' }, allowedPaths: [] });
  assert.match(refusal({ 'order.json': json }), /timesheet: order\.json .*at allowedPaths/);
});

test('refuses an order with no order.json', () => {
  assert.match(refusal({ 'order.json': undefined }), /timesheet: no order\.json/);
});

test('refuses an order.json that is not JSON', () => {
  assert.match(refusal({ 'order.json': '{ trap' }), /timesheet: order\.json is not JSON/);
});

const BOM = String.fromCodePoint(0xfeff);

test('reads an order.json and an order.md that start with a byte order mark as without one', () => {
  const order = readOrder(
    'timesheet',
    files({ 'order.json': `${BOM}${ORDER_JSON}`, 'order.md': `${BOM}Count a shift\n` }),
  );
  assert.equal(order.trap.kind, 'edge-case');
  assert.equal(order.title, 'Count a shift');
  assert.equal(order.text, 'Count a shift\n');
});

test('names every problem of an order at once, one per line', () => {
  const message = refusal({ 'order.md': undefined, 'solution/src/shift.mjs': undefined });
  assert.equal(message.split('\n').length, 2);
  assert.match(message, /no order\.md/);
  assert.match(message, /no solution\//);
});

test("a layer adds and replaces files, and the root's instruction file is laid down as CLAUDE.md", () => {
  const tree = withLayer(
    { 'src/a.mjs': 'a\n', 'src/b.mjs': 'b\n' },
    {
      'src/b.mjs': 'b2\n',
      'src/c.mjs': 'c\n',
      'INSTRUCTIONS.fixture.md': '# Rules\n',
      'docs/INSTRUCTIONS.fixture.md': 'kept\n',
    },
  );
  assert.deepEqual(tree, {
    'src/a.mjs': 'a\n',
    'src/b.mjs': 'b2\n',
    'src/c.mjs': 'c\n',
    'CLAUDE.md': '# Rules\n',
    'docs/INSTRUCTIONS.fixture.md': 'kept\n',
  });
});

test('the starting tree is the base with its instruction file as CLAUDE.md', () => {
  const tree = startingTree(readOrder('timesheet', files()));
  assert.deepEqual(Object.keys(tree).sort(), ['CLAUDE.md', 'src/shift.mjs', 'test/shift.test.mjs']);
});

test('the proof runs the hidden tests on the base, to fail, and with the solution, to pass', () => {
  const [onBase, withSolution, ...more] = proofRuns(readOrder('timesheet', files()));
  assert.equal(more.length, 0);
  const tests = ['test/hidden/day.test.mjs', 'test/hidden/shift.test.mjs'];
  assert.deepEqual(onBase, {
    expect: 'fail',
    tests,
    tree: {
      'CLAUDE.md': '# Rules\n',
      'src/shift.mjs': 'export {};\n',
      'test/shift.test.mjs': "import '../src/shift.mjs';\n",
      'test/hidden/shift.test.mjs': 'night\n',
      'test/hidden/day.test.mjs': 'day\n',
    },
  });
  assert.equal(withSolution?.expect, 'pass');
  assert.deepEqual(withSolution?.tests, tests);
  assert.equal(withSolution?.tree['src/shift.mjs'], 'export const shiftMinutes = () => 0;\n');
  assert.equal(withSolution?.tree['test/hidden/shift.test.mjs'], 'night\n');
  assert.equal(withSolution?.tree['CLAUDE.md'], '# Rules\n');
});

test("the hidden tests are laid over the solution, so a solution's file at a hidden test's path is replaced", () => {
  const order = readOrder(
    'timesheet',
    files({ 'solution/test/hidden/shift.test.mjs': 'from the solution\n' }),
  );
  const withSolution = proofRuns(order).find((each) => each.expect === 'pass');
  assert.equal(withSolution?.tree['test/hidden/shift.test.mjs'], 'night\n');
});

const run = (expect: ProofRun['expect']): ProofRun => ({
  expect,
  tree: {},
  tests: ['test/hidden/shift.test.mjs'],
});

test('refuses hidden tests that pass on the starting repository', () => {
  assert.match(proofProblem(run('fail'), 0) ?? '', /pass on the starting repository/);
  assert.equal(proofProblem(run('fail'), 1), undefined);
});

test('refuses hidden tests that fail with the reference solution', () => {
  assert.match(proofProblem(run('pass'), 1) ?? '', /fail with the reference solution/);
  assert.equal(proofProblem(run('pass'), 0), undefined);
});

test('refuses a proof run that did not finish, whatever it expects', () => {
  assert.match(proofProblem(run('fail'), null) ?? '', /did not finish/);
  assert.match(proofProblem(run('pass'), null) ?? '', /did not finish/);
});

test("reads a folder's files by their path from it, with / between the parts", () => {
  const dir = makeTempDir('flight-orders');
  try {
    mkdirSync(join(dir.path, 'base', 'src'), { recursive: true });
    writeFileSync(join(dir.path, 'order.md'), 'Title\n');
    writeFileSync(join(dir.path, 'base', 'src', 'a.mjs'), 'a\n');
    assert.deepEqual(folderFiles(dir.path), { 'order.md': 'Title\n', 'base/src/a.mjs': 'a\n' });
  } finally {
    dir.remove();
  }
});
