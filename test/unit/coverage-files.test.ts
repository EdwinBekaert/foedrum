// The coverage report files of a worktree (ADR 0274): LCOV by file, Cobertura merged from every
// `coverage.cobertura.xml` under a folder pattern, each file read as a test report is (ADR 0078).

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readCoverage } from '../../src/formats/coverage-files.ts';
import type { CoverageReport } from '../../src/formats/coverage-report.ts';
import { MAX_REPORT_BYTES } from '../../src/formats/test-report.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

const spike = (file: string): string =>
  readFileSync(
    join(import.meta.dirname, '..', 'fixtures', 'coverage-spike', 'cs', '2-green', file),
    'utf8',
  );

describe('readCoverage', () => {
  let dir: TempDir;
  before(() => {
    dir = makeTempDir('coverage-files');
  });
  after(() => dir.remove());

  const write = (path: string, text: string | Buffer): void => {
    const file = join(dir.path, ...path.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };

  const read = (format: 'lcov' | 'cobertura', path: string): CoverageReport => {
    const parsed = readCoverage(format, path, dir.path);
    assert.ok(parsed.readable, parsed.readable ? '' : parsed.reason);
    return parsed.report;
  };

  it('merges every coverage.cobertura.xml under a folder by the most hits per line', () => {
    // The spike's two test projects, each written by coverlet under a GUID folder of its own,
    // their source moved from the machine they were captured on into this worktree.
    const here = (text: string) => text.replaceAll('C:\\spike\\cs\\', `${dir.path}/`);
    write(
      't/Text.Tests/TestResults/0b1f/coverage.cobertura.xml',
      here(spike('Text.Tests.cobertura.xml')),
    );
    write(
      't/Calc.Tests/TestResults/9e2a/coverage.cobertura.xml',
      here(spike('Calc.Tests.cobertura.xml')),
    );
    // Neither is read: another name, and a folder the pattern does not match.
    write('t/Calc.Tests/TestResults/9e2a/other.xml', 'not xml');
    write('t/Calc.Tests/Old/coverage.cobertura.xml', 'not xml');
    const report = read('cobertura', 't/*/TestResults');
    assert.deepEqual([...report.keys()].sort(), [
      'src/Calc/Calculator.cs',
      'src/Calc/Legacy.cs',
      'src/Text/Label.cs',
    ]);
    const calculator = report.get('src/Calc/Calculator.cs');
    // Text.Tests reaches Calculator less (line 12 once, one branch of two); Calc.Tests more.
    assert.deepEqual(calculator?.get(12), { hits: 4, branches: { taken: 2, total: 2 } });
    assert.deepEqual(calculator?.get(20), { hits: 0 });
    assert.ok((report.get('src/Text/Label.cs')?.size ?? 0) > 0);
    // A pattern under which coverlet wrote nothing is a reason, not an empty report.
    const none = readCoverage('cobertura', 'none/*/TestResults', dir.path);
    assert.equal(none.readable, false);
    assert.match(
      none.readable ? '' : none.reason,
      /no coverage\.cobertura\.xml under none\/\*\/TestResults/,
    );
  });

  it('reads a report over 16 MiB as a reason', () => {
    write('big/lcov.info', Buffer.alloc(MAX_REPORT_BYTES + 1, 'D'));
    const big = readCoverage('lcov', 'big/lcov.info', dir.path);
    assert.equal(big.readable, false);
    assert.match(
      big.readable ? '' : big.reason,
      /big\/lcov\.info: it is larger than 16777216 bytes/,
    );
    write('fits/lcov.info', 'SF:a.ts\nDA:1,1\nend_of_record\n');
    assert.deepEqual([...read('lcov', 'fits/lcov.info').keys()], ['a.ts']);
    const missing = readCoverage('lcov', 'gone/lcov.info', dir.path);
    assert.equal(missing.readable, false);
    assert.match(missing.readable ? '' : missing.reason, /no LCOV report at gone\/lcov\.info/);
  });

  it("marks a report it cannot read as the environment's, never one that does not parse", () => {
    write('big/lcov.info', Buffer.alloc(MAX_REPORT_BYTES + 1, 'D'));
    const big = readCoverage('lcov', 'big/lcov.info', dir.path);
    assert.equal(big.readable ? undefined : big.environment, true);
    write('bad/lcov.info', 'Error: Cannot find module\n');
    const bad = readCoverage('lcov', 'bad/lcov.info', dir.path);
    assert.equal(bad.readable ? true : bad.environment, undefined);
  });

  it('tells two Cobertura sources apart by the file in the worktree', () => {
    // `a.ts` lands inside the root under both sources; only `two/lib/a.ts` is there.
    write('two/lib/a.ts', 'export {};\n');
    write(
      'two/TestResults/7c3d/coverage.cobertura.xml',
      `<coverage><sources><source>${dir.path}/two/</source><source>${dir.path}/two/lib/</source></sources>
<packages><package><classes><class filename="a.ts"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>`,
    );
    assert.deepEqual([...read('cobertura', 'two/TestResults').keys()], ['two/lib/a.ts']);
  });

  it('refuses the merge when one matched report does not read, naming that file', () => {
    // A broken report left out of the merge would show fewer hits than the run made.
    write('broken/A/TestResults/1a/coverage.cobertura.xml', '<coverage></coverage>');
    write('broken/B/TestResults/2b/coverage.cobertura.xml', 'Build FAILED.');
    const merged = readCoverage('cobertura', 'broken/*/TestResults', dir.path);
    assert.equal(merged.readable, false);
    assert.match(
      merged.readable ? '' : merged.reason,
      /^broken\/B\/TestResults\/2b\/coverage\.cobertura\.xml: it is not XML/,
    );
    write('bad/lcov.info', 'Error: Cannot find module\n');
    const lcov = readCoverage('lcov', 'bad/lcov.info', dir.path);
    assert.equal(lcov.readable ? '' : lcov.reason, 'bad/lcov.info: it has no SF record');
  });

  it('keeps the line breaks of a report path out of its reason', () => {
    // The tested code names the folders it writes, and the map names the paths: a line break in
    // either must not start a line of its own where the reason is shown.
    const ls = String.fromCodePoint(0x2028);
    const ps = String.fromCodePoint(0x2029);
    write(`breaks/A/TestResults/x${ls}forged/coverage.cobertura.xml`, 'Build FAILED.');
    const folder = readCoverage('cobertura', 'breaks/*/TestResults', dir.path);
    assert.match(
      folder.readable ? '' : folder.reason,
      /^breaks\/A\/TestResults\/x\\u2028forged\/coverage\.cobertura\.xml: it is not XML/,
    );
    const reasonOf = (format: 'lcov' | 'cobertura', path: string): string => {
      const read = readCoverage(format, path, dir.path);
      return read.readable ? '' : read.reason;
    };
    assert.equal(
      reasonOf('lcov', `gone${ps}x/lcov.info`),
      'no LCOV report at gone\\u2029x/lcov.info',
    );
    assert.equal(
      reasonOf('cobertura', 'none\n/*/TestResults'),
      'no coverage.cobertura.xml under none\\n/*/TestResults',
    );
    assert.equal(
      reasonOf('cobertura', 'none\r/*/TestResults'),
      'no coverage.cobertura.xml under none\\r/*/TestResults',
    );
  });
});
