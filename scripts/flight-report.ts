// node scripts/flight-report.ts --baseline <Flight folder> --candidate <Flight folder> (#1084,
// ADR 0411): compares two Flights of scripts/flight.ts order by order from their results.jsonl
// records. It writes report.md into the candidate's folder and prints it: each order's hidden tests
// passed in each Flight, runs outside its paths, tokens and time, a verdict by ADR 0404's rule, and
// one summary line; never a cost in money. Its decisions are scripts/flight/report.ts.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { FlightRecord } from './flight/core.ts';
import { FLIGHT_REPORT_OPTIONS, flightReportRun } from './flight/report.ts';
import { readRecordsIn } from './tasting-compare/core.ts';

const defaults = join(resolve(import.meta.dirname, '..'), 'defaults');

const ran = flightReportRun(
  parseArgs({ options: FLIGHT_REPORT_OPTIONS }).values,
  (folder) => readRecordsIn<string, FlightRecord>(folder),
  {
    recipeText: (name) => {
      const file = join(defaults, 'recipes', `${name}.jsonc`);
      return /^[a-z0-9-]+$/.test(name) && existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    },
    modelsText: readFileSync(join(defaults, 'models.jsonc'), 'utf8'),
    today: new Date(),
  },
);
if (ran.kind === 'refused') {
  process.stderr.write(`${ran.message}\n`);
  process.exit(2);
}
writeFileSync(ran.file, ran.report);
process.stdout.write(ran.report);
