// node scripts/flight-report.ts --baseline <Flight folder> --candidate <Flight folder> (#1084,
// ADR 0411): compares two Flights of scripts/flight.ts order by order from their results.jsonl
// records. It writes report.md into the candidate's folder: each order's hidden tests passed in each
// Flight, how its runs ended, runs outside its paths, tokens in sum and by kind, and time, a verdict
// by ADR 0404's rule, and one summary line that counts the runs that reached a pull request beside
// the orders passed (ADR 0425); never a cost in money. For a real Flight with a swapped brewer, it adds that brewer's tasted
// entry to defaults/models.jsonc, or replaces the one of its combination, writes pull-request.md
// beside report.md and prints its title and description; it branches, commits and pushes nothing
// (ADR 0416). Otherwise it prints the report, and a line on why no entry was written. Its decisions
// are scripts/flight/report.ts.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { FlightRecord } from './flight/core.ts';
import { flightReportArgsOf, flightReportRun } from './flight/report.ts';
import { readRecordsIn } from './tasting-compare/core.ts';

const defaults = join(resolve(import.meta.dirname, '..'), 'defaults');

const args = flightReportArgsOf(process.argv.slice(2));
const ran =
  args.kind === 'refused'
    ? args
    : flightReportRun(args.values, (folder) => readRecordsIn<string, FlightRecord>(folder), {
        recipeText: (name) => {
          const file = join(defaults, 'recipes', `${name}.jsonc`);
          return /^[a-z0-9-]+$/.test(name) && existsSync(file)
            ? readFileSync(file, 'utf8')
            : undefined;
        },
        modelsText: readFileSync(join(defaults, 'models.jsonc'), 'utf8'),
        today: new Date(),
      });
if (ran.kind === 'refused') {
  process.stderr.write(`${ran.message}\n`);
  process.exit(2);
}
writeFileSync(ran.file, ran.report);
const { tasted } = ran;
if (tasted.kind === 'not written') {
  process.stdout.write(ran.report);
  process.stderr.write(`flight-report: ${tasted.why}\n`);
  process.exit(tasted.exitCode);
}
writeFileSync(join(defaults, 'models.jsonc'), tasted.models);
writeFileSync(join(dirname(ran.file), 'pull-request.md'), tasted.description);
process.stdout.write(`${tasted.title}\n\n${tasted.description}`);
