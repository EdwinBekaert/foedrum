// The unblinding of a scored comparison (ADR 0403): a scorer's marks of the blinded lists, run by
// run, counted by setup through codes.md into the table #879's comments show. It counts marks and
// judges nothing: whether a finding names a key item is the scorer's.

import { ModelLevel } from '../../src/schemas/models.ts';
import { z } from '../../src/schemas/zod.ts';
import { escapeCell } from './core.ts';
import { FAMILIES, isAsked } from './real.ts';

/** The texts the table is made of: the key's markdown, the comparison's codes.md and the marks' JSON. */
export interface ScoreInput {
  key: string;
  codes: string;
  marks: string;
}

/** What the scorer marked of one run of a list: the key items it caught, and each finding outside the key. */
const Marks = z.object({
  runs: z.array(
    z.object({
      order: z.number().int(),
      code: z.string(),
      caught: z.array(z.string()),
      outside: z.array(z.object({ finding: z.string(), verdict: z.enum(['true', 'false']) })),
    }),
  ),
});

interface KeyItem {
  id: string;
  order: number;
}

/** A table row's cells, split on the `|` that are not escaped. */
const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

/** Every row of every table in the key whose header has an Id and an Order column, as #879's has. */
const keyOf = (key: string): KeyItem[] => {
  const items: KeyItem[] = [];
  let columns: { id: number; order: number } | undefined;
  for (const line of key.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) {
      columns = undefined;
      continue;
    }
    const cells = cellsOf(line);
    const [id, order] = [cells.indexOf('Id'), cells.indexOf('Order')];
    if (id !== -1 && order !== -1) columns = { id, order };
    else if (columns !== undefined && !/^-+$/.test(cells[0] ?? '')) {
      const number = /^#(\d+)$/.exec(cells[columns.order] ?? '');
      if (number?.[1] !== undefined) {
        items.push({ id: cells[columns.id] ?? '', order: Number(number[1]) });
      }
    }
  }
  return items;
};

/** One scored run as codes.md names it: its order, its setup without the order, its tokens and its Tasters' models. */
interface CodedRun {
  order: number;
  label: string;
  tokens: number | undefined;
  models: string[];
}

const unescaped = (cell: string): string =>
  cell.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replace(/\\(.)/g, '$1');

/** codes.md's runs by code, one row per Taster summed into its run, in the order they first come. */
const runsOf = (codes: string): Map<string, CodedRun> => {
  const runs = new Map<string, CodedRun>();
  for (const line of codes.split(/\r?\n/)) {
    const cells = cellsOf(line);
    if (
      !line.startsWith('|') ||
      cells.length !== 10 ||
      cells[0] === 'Code' ||
      /^-+$/.test(cells[0] ?? '')
    ) {
      continue;
    }
    const [code = '', setup = '', , , model = '-', , , , , total = '-'] = cells;
    const named = /^(\d+)-(.+)$/.exec(setup);
    if (named?.[1] === undefined || named[2] === undefined) continue;
    const run = runs.get(code) ?? {
      order: Number(named[1]),
      label: named[2],
      tokens: 0,
      models: [],
    };
    run.tokens = total === '-' || run.tokens === undefined ? undefined : run.tokens + Number(total);
    if (model !== '-') run.models.push(...unescaped(model).split(', '));
    runs.set(code, run);
  }
  return runs;
};

/** The model a settings setup asks for: its level's family or its model id (ADR 0402); a fixed profile's is not read. */
const askedOf = (label: string): string | undefined => {
  const settings = /^taster-(.+)-[a-z]+-(?:apart|together)-(?:reads|bare)$/.exec(label);
  if (settings?.[1] === undefined) return undefined;
  const level = ModelLevel.safeParse(settings[1]);
  return level.success ? FAMILIES[level.data] : settings[1];
};

const thousands = (tokens: number): string =>
  `${Math.round(tokens / 1000).toLocaleString('en-US')}k`;

const tokensCell = (runs: readonly CodedRun[]): string => {
  const known = runs.flatMap(({ tokens }) => (tokens === undefined ? [] : [tokens]));
  if (known.length === 0) return '-';
  const [low, high] = [Math.min(...known), Math.max(...known)];
  const mean = thousands(known.reduce((sum, each) => sum + each, 0) / known.length);
  return low === high ? mean : `${mean} (${thousands(low)}–${thousands(high)})`;
};

const ranOnCell = (label: string, runs: readonly CodedRun[]): string => {
  const counts = new Map<string, number>();
  for (const model of runs.flatMap(({ models }) => models)) {
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  const asked = askedOf(label);
  return (
    [...counts]
      .map(([model, count]) => {
        const other = asked !== undefined && !isAsked(asked, model) ? `, not asked: ${asked}` : '';
        return escapeCell(`${model} (${count})${other}`);
      })
      .join('; ') || '-'
  );
};

const outsideCell = (verdicts: readonly string[]): string => {
  const [right, wrong] = [
    verdicts.filter((each) => each === 'true').length,
    verdicts.filter((each) => each === 'false').length,
  ];
  const parts = [right === 0 ? '' : `${right} true`, wrong === 0 ? '' : `${wrong} false`];
  return parts.filter((part) => part !== '').join(', ') || 'none';
};

/**
 * The table of a scored comparison: per setup, its catches of each key item, its findings outside
 * the key, its tokens per batch and the models its Tasters ran on; throws on marks that do not fit
 * the key or codes.md, every problem at once.
 */
export const scoredTable = ({ key, codes, marks }: ScoreInput): string => {
  const items = keyOf(key).sort((a, b) => a.order - b.order);
  const orders = new Set(items.map(({ order }) => order));
  const runs = runsOf(codes);
  // A file an editor saved with a BOM is the same marks (CLAUDE.md, Cross-platform).
  const bare = marks.charCodeAt(0) === 0xfeff ? marks.slice(1) : marks;
  const marked = (() => {
    try {
      return Marks.parse(JSON.parse(bare)).runs;
    } catch (error) {
      // A parser's message can quote the scorer's text, so it goes on one line too.
      throw new Error(
        `the marks are not the JSON the scorer is asked for: ${escapeCell((error as Error).message)}`,
      );
    }
  })();
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { order, code: written, caught } of marked) {
    // The scorer's values go on one line each, so none can forge a refusal line.
    const code = escapeCell(written);
    if (!orders.has(order)) {
      problems.push(`the mark of ${code} is of #${order}, which is not in the key`);
    } else if (runs.get(written)?.order !== order) {
      problems.push(`the mark's code ${code} is not in codes.md for #${order}`);
    }
    if (seen.has(written)) problems.push(`the mark's code ${code} is given more than once`);
    seen.add(written);
    for (const id of caught) {
      if (!items.some((item) => item.id === id && item.order === order)) {
        problems.push(
          `${escapeCell(id)}, marked caught in ${code}, is not a key item of #${order}`,
        );
      }
    }
  }
  const scored = [...runs].filter(([, { order }]) => orders.has(order));
  for (const [code, { order }] of scored) {
    if (!marked.some((each) => each.code === code)) {
      problems.push(`run ${code} of #${order} has no mark`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const labels = [...new Set(scored.map(([, { label }]) => label))];
  const rows = labels.map((label) => {
    const own = scored.filter(([, run]) => run.label === label);
    const marksOf = own.flatMap(([code]) => marked.filter((each) => each.code === code));
    const catches = items.map(({ id, order }) => {
      const ofOrder = marksOf.filter((each) => each.order === order);
      if (ofOrder.length === 0) return '-';
      return `${ofOrder.filter(({ caught }) => caught.includes(id)).length}/${ofOrder.length}`;
    });
    const verdicts = marksOf.flatMap(({ outside }) => outside.map(({ verdict }) => verdict));
    const coded = own.map(([, run]) => run);
    return `| \`${label}\` | ${[...catches, outsideCell(verdicts), tokensCell(coded), ranOnCell(label, coded)].join(' | ')} |`;
  });
  const header = [
    'Setup',
    ...items.map(({ id }) => escapeCell(id)),
    'Findings outside the key',
    'Tokens per batch, mean (range)',
    'Ran on',
  ];
  return `${[`| ${header.join(' | ')} |`, `|${'---|'.repeat(header.length)}`, ...rows].join('\n')}\n`;
};
