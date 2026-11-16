// node scripts/tasting-score.ts --folder <comparison folder> --key <key.md> --marks <marks.json>
// (#1081, ADR 0403): unblinds a scored comparison of tasting-compare --real. It reads the folder's
// codes.md, the key the brew-tasting skill took from the issues at run time and the scorer's marks,
// writes the table #879's comments show to scored.md in the folder and prints it. It refuses marks
// that do not fit the key or codes.md. Its decisions are scripts/tasting-compare/score.ts.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { scoredTable } from './tasting-compare/score.ts';

const { values } = parseArgs({
  options: {
    folder: { type: 'string' },
    key: { type: 'string' },
    marks: { type: 'string' },
  },
});
const { folder, key, marks } = values;
if (folder === undefined || key === undefined || marks === undefined) {
  process.stderr.write('give --folder, --key and --marks\n');
  process.exit(2);
}
try {
  const table = scoredTable({
    key: readFileSync(key, 'utf8'),
    codes: readFileSync(join(folder, 'codes.md'), 'utf8'),
    marks: readFileSync(marks, 'utf8'),
  });
  writeFileSync(join(folder, 'scored.md'), table);
  process.stdout.write(table);
} catch (error) {
  process.stderr.write(`tasting-score: ${(error as Error).message}\n`);
  process.exit(2);
}
