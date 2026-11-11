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
