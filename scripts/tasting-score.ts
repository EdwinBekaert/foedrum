// node scripts/tasting-score.ts --folder <comparison folder> --key <key.md> --marks <marks.json>
// (#1081, ADR 0403): unblinds a scored comparison of tasting-compare --real. It reads the folder's
// codes.md, the key the brew-tasting skill took from the issues at run time and the scorer's marks,
// writes the table #879's comments show to scored.md in the folder and prints it. It refuses marks
// that do not fit the key or codes.md. Its decisions are scripts/tasting-compare/score.ts.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { scoreRun } from './tasting-compare/score.ts';

const { values } = parseArgs({
  options: {
    folder: { type: 'string' },
    key: { type: 'string' },
    marks: { type: 'string' },
  },
});
const scored = scoreRun(values, {
  read: (path) => readFileSync(path, 'utf8'),
  write: writeFileSync,
});
if (scored.kind === 'refused') {
  process.stderr.write(`${scored.message}
`);
  process.exit(2);
}
process.stdout.write(scored.table);
