// What a Brewery's test line saves, read from the line alone (ADR 0376): each runner's line that
// saves a report already, coverage that is there already, quotes, and lines of two commands.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { npmTestLine, readTestLine } from '../../src/checks/test-line.ts';

describe('readTestLine: a line that saves a report already (ADR 0376)', () => {
  it('reads each runner whose line saves its report, with nothing to add', () => {
    for (const line of [
      'node --test --test-reporter=junit --test-reporter-destination=junit.xml --experimental-test-coverage test/',
      'vitest run --coverage --reporter=junit --outputFile.junit=junit.xml',
      'npm test -- --coverage --reporter=default --reporter=junit --outputFile.junit=junit.xml',
      'pytest --cov --junit-xml=junit.xml',
      'python -m pytest --cov=app --junitxml=junit.xml',
      'dotnet test Svc.sln --logger:"junit;LogFilePath=TestResults/{assembly}.junit.xml" --collect:"XPlat Code Coverage"',
      'dotnet test --logger junit --collect "XPlat Code Coverage"',
    ]) {
      const read = readTestLine(line);
      assert.equal(read.saves, true, line);
      assert.equal(read.withReport, undefined, line);
      assert.deepEqual(read.advice, [], line);
    }
  });

  it('names the coverage package of a line that saves a report and no coverage', () => {
    assert.match(
      readTestLine('vitest run --reporter=junit --outputFile.junit=junit.xml').advice.join(),
      /@vitest\/coverage-v8/,
    );
    assert.match(readTestLine('pytest --junit-xml=junit.xml').advice.join(), /pytest-cov/);
    assert.match(
      readTestLine('dotnet test --logger:"junit;LogFilePath=x.xml"').advice.join(),
      /coverlet\.collector/,
    );
  });

  it('counts a report only where the reporter and its file are both given', () => {
    for (const [line, saves] of [
      ['vitest run --reporter=junit', false],
      ['vitest run --reporter junit --outputFile junit.xml', true],
      ['dotnet test --logger:trx', false],
      ['dotnet test --logger trx', false],
      ['node --test --test-reporter=tap --test-reporter-destination=out.tap test/', true],
      ['pytest --junit-xml junit.xml', true],
    ] as const) {
      assert.equal(readTestLine(line).saves, saves, line);
    }
  });

  it('does not count a node destination of stdout or stderr as a saved report', () => {
    for (const to of ['stdout', 'stderr']) {
      const line = `node --test --test-reporter=junit --test-reporter-destination=${to} test/`;
      assert.equal(readTestLine(line).saves, false, line);
    }
  });
});

describe('readTestLine: the words of a line (ADR 0376)', () => {
  it('reads a quoted ;, | or & as part of one command', () => {
    for (const line of ['pytest -k "a;b"', "pytest -k 'a|b'", 'pytest -k "a&b"']) {
      const read = readTestLine(line);
      assert.equal(read.runner, 'pytest', line);
      assert.equal(read.withReport, `${line} --junit-xml=junit.xml`, line);
    }
  });

  it('reads an unquoted ;, | or & as a line of two commands, whose runner it does not know', () => {
    for (const line of ['pytest; echo', 'node --test | tee out.txt', 'pytest & echo']) {
      assert.deepEqual(readTestLine(line), { runner: undefined, saves: false, advice: [] }, line);
    }
  });

  it('knows node.exe, and vitest by its junit output file', () => {
    assert.equal(readTestLine('node.exe --test test/').runner, 'node');
    assert.equal(readTestLine('npm test -- --outputFile.junit=junit.xml').runner, 'vitest');
    // node without --test runs a script, not the test runner.
    assert.equal(readTestLine('node test/run.js').runner, undefined);
  });
});

describe('npmTestLine: the line init writes for a package.json test script (ADR 0376)', () => {
  it('keeps a node script that saves its reports, and npm test for one it does not read', () => {
    const saving =
      'node --test --test-reporter=junit --test-reporter-destination=junit.xml --experimental-test-coverage test/';
    assert.equal(npmTestLine(saving), saving);
    assert.equal(
      npmTestLine('vitest run --reporter=junit --outputFile.junit=junit.xml'),
      'npm test',
    );
    assert.equal(npmTestLine('jest --ci'), 'npm test');
  });
});

describe('readTestLine: the fixes of the review (ADR 0376)', () => {
  it('adds no node flags to a line whose reporters already name a destination of their own or none, and says what to add', () => {
    for (const line of [
      'node --test --test-reporter=tap test/',
      'node --test --test-reporter-destination=out.txt test/',
    ]) {
      assert.deepEqual(
        readTestLine(line),
        {
          runner: 'node',
          saves: false,
          advice: [
            'for a test report, add --test-reporter=junit --test-reporter-destination=junit.xml right after --test, and give every --test-reporter of the line a --test-reporter-destination of its own: node refuses a line where they do not pair up',
          ],
        },
        line,
      );
      assert.equal(npmTestLine(line), line);
    }
  });

  it('does not count a vitest output file of another reporter as a saved test report', () => {
    const json = readTestLine('vitest run --reporter=json --outputFile=results.json');
    assert.equal(json.saves, false);
    assert.equal(
      json.withReport,
      'vitest run --reporter=json --outputFile=results.json --reporter=default --reporter=junit --outputFile.junit=junit.xml',
    );
    assert.equal(readTestLine('vitest run --reporter=junit --outputFile=junit.xml').saves, true);
  });

  it('knows a runner by its name in any case, with a folder or a Windows extension', () => {
    for (const [line, runner] of [
      ['Node.exe --test test/', 'node'],
      [String.raw`"C:\Program Files\nodejs\node.exe" --test test/`, 'node'],
      ['/usr/local/bin/node --test test/', 'node'],
      ['pytest.exe tests', 'pytest'],
      ['DOTNET Test Svc.sln', 'dotnet'],
      ['vitest.cmd run', 'vitest'],
    ] as const) {
      assert.equal(readTestLine(line).runner, runner, line);
    }
  });

  it('reads a line break outside quotes as a line of two commands', () => {
    assert.deepEqual(readTestLine('node --test\nrm -rf build'), {
      runner: undefined,
      saves: false,
      advice: [],
    });
  });
});

describe('readTestLine: flags read as node and vitest read them (ADR 0376)', () => {
  it("pairs each node reporter with its destination by position, and reads node's and vitest's spaced flags", () => {
    for (const [line, saves] of [
      [
        'node --test --test-reporter=junit --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=lcov.info test/',
        false,
      ],
      ['node --test --test-reporter junit --test-reporter-destination junit.xml test/', true],
      ['vitest run --reporter=junit --outputFile.junit junit.xml', true],
      ['npm test -- --outputFile.junit junit.xml', true],
    ] as const) {
      assert.equal(readTestLine(line).saves, saves, line);
    }
  });
});
