import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import { FLIGHT_OPTIONS, flightArgsOf } from '../../scripts/flight/core.ts';
import { FLIGHT_REPORT_OPTIONS, flightReportArgsOf } from '../../scripts/flight/report.ts';

/** The message `parseArgs` throws for `args`, the tool's own text. */
const thrownBy = (args: string[], options: ParseArgsConfig['options']): string => {
  try {
    parseArgs({ args, options });
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail(`parseArgs accepted ${args.join(' ')}`);
};

describe('the Flight scripts refuse what parseArgs refuses in one line (#1161)', () => {
  it('refuses an option missing its value when another option follows it', () => {
    assert.deepEqual(flightArgsOf(['--recipe', '--runs', '2']), {
      kind: 'refused',
      message: '--recipe needs a value',
    });
    assert.deepEqual(flightReportArgsOf(['--baseline', '--candidate', 'next']), {
      kind: 'refused',
      message: '--baseline needs a value',
    });
  });

  it('refuses an option it does not have with the text parseArgs gives', () => {
    const args = ['--recipe', 'nip', '--speed', 'fast'];
    assert.deepEqual(flightArgsOf(args), {
      kind: 'refused',
      message: thrownBy(args, FLIGHT_OPTIONS),
    });
    assert.match(thrownBy(args, FLIGHT_OPTIONS), /--speed/);
    const reportArgs = ['--baseline', 'base', '--speed'];
    assert.deepEqual(flightReportArgsOf(reportArgs), {
      kind: 'refused',
      message: thrownBy(reportArgs, FLIGHT_REPORT_OPTIONS),
    });
  });

  it('refuses a value given to a flag with the text parseArgs gives, not as a missing value', () => {
    const args = ['--recipe', 'nip', '--dry-run=yes'];
    const read = flightArgsOf(args);
    assert.deepEqual(read, { kind: 'refused', message: thrownBy(args, FLIGHT_OPTIONS) });
    assert.doesNotMatch(read.kind === 'refused' ? read.message : '', /needs a value/);
  });
});
