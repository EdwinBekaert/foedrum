// The ADR index, rebuilt from the records (issue #312): the table in docs/adr/README.md and the
// "Amended by" / "Superseded by" part of each record's status line, worked out by reversing every
// record's `Amends [NNNN](…)` / `Supersedes [NNNN](…)` links. Pure: file texts in, new texts out;
// scripts/adr-index.ts reads and writes the folder (ADR 0021).

export interface AdrFile {
  /** The file's name in docs/adr/, such as `0024-state-branch.md`. */
  name: string;
  text: string;
}

export type Rebuild =
  | {
      ok: true;
      /** README.md's new text. */
      readme: string;
      /** The records whose text changes, with their new text. */
      records: AdrFile[];
      /** One line per difference, `<file>[:<line>]: <what changes>`; empty when nothing does. */
      changes: string[];
    }
  | { ok: false; problems: string[] };

/** What a later record does to an earlier one, named as the earlier one's status line says it. */
type Kind = 'superseded' | 'amended' | 'generalised' | 'extended';

// The table lists them in this order; a superseded record says so first.
const KINDS: Kind[] = ['superseded', 'amended', 'generalised', 'extended'];

// A segment of the later record's status line that starts with one of these links forward.
const FORWARD: Record<string, Kind> = {
  Supersedes: 'superseded',
  Amends: 'amended',
  Generalises: 'generalised',
  Extends: 'extended',
};

const RECORD_NAME = /^(\d{4})-.+\.md$/;
const TITLE = /^# (\d{4})\. (.+)$/;
const STATUS = /^(Date: .*? · Status: )(.*)$/;
const STATUS_LINE = 2; // the third line: title, blank, status
const SEGMENTS = ' · ';
const LINK = /\[(\d{4})\]\([^)\s]*\)/y;
const BACK_PHRASE = /\b(superseded|amended|generalised|extended) by (?=\[\d{4}\]\()/gi;
const SEPARATOR = /(?:\s*,\s*(?:and\s+)?|\s+and\s+)(?=\[\d{4}\]\()/y;
const TABLE_HEADER = '| # | Decision | Status |';
const TABLE_RULE = '|---|---|---|';
const TEMPLATE = '## Template';

interface Link {
  number: string;
  start: number;
  end: number;
  /** How many parentheses outside links are open where it starts. */
  depth: number;
}

// The `[NNNN](…)` links in the text up to `until`, each with the parenthesis depth around it
// (a link's own parentheses do not count), and the depth at `until`.
const walk = (text: string, until = text.length): { links: Link[]; depth: number } => {
  const links: Link[] = [];
  let depth = 0;
  for (let at = 0; at < until; ) {
    LINK.lastIndex = at;
    const link = text[at] === '[' ? LINK.exec(text) : null;
    if (link !== null) {
      links.push({ number: link[1] ?? '', start: at, end: LINK.lastIndex, depth });
      at = LINK.lastIndex;
      continue;
    }
    if (text[at] === '(') depth += 1;
    if (text[at] === ')') depth = Math.max(0, depth - 1);
    at += 1;
  }
  return { links, depth };
};

const linksIn = (text: string): Link[] => walk(text).links;

const depthAt = (text: string, index: number): number => walk(text, index).depth;

interface Entry {
  number: string;
  /** The link and its annotation, such as `[0020](0020-x.md) (input limits)`. */
  text: string;
}

/** A back clause such as `amended by [0011](…) and [0024](…) (why)` inside one segment. */
interface Clause {
  kind: Kind;
  segment: number;
  /** Where its phrase starts, where its list starts and where the list ends. */
  start: number;
  list: number;
  end: number;
  entries: Entry[];
}

// The end of the parenthesis that opens at `open`, or -1.
const closing = (text: string, open: number): number => {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    LINK.lastIndex = at;
    const link = text[at] === '[' ? LINK.exec(text) : null;
    if (link !== null) {
      at = LINK.lastIndex - 1;
      continue;
    }
    if (text[at] === '(') depth += 1;
    if (text[at] === ')') {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
};

const clausesIn = (text: string, segment: number): Clause[] => {
  const clauses: Clause[] = [];
  for (const phrase of text.matchAll(BACK_PHRASE)) {
    if (depthAt(text, phrase.index) > 0) continue;
    const kind = (phrase[1] ?? '').toLowerCase() as Kind;
    const list = phrase.index + phrase[0].length;
    const entries: Entry[] = [];
    let at = list;
    for (;;) {
      LINK.lastIndex = at;
      const link = LINK.exec(text);
      if (link === null) break;
      const start = at;
      at = LINK.lastIndex;
      if (text.startsWith(' (', at)) {
        const close = closing(text, at + 1);
        if (close !== -1) at = close + 1;
      }
      entries.push({ number: link[1] ?? '', text: text.slice(start, at) });
      SEPARATOR.lastIndex = at;
      if (SEPARATOR.exec(text) === null) break;
      at = SEPARATOR.lastIndex;
    }
    clauses.push({ kind, segment, start: phrase.index, list, end: at, entries });
  }
  return clauses;
};

const forwardKind = (segment: string): Kind | undefined => FORWARD[segment.split(' ', 1)[0] ?? ''];

interface Parsed {
  name: string;
  number: string;
  title: string;
  lines: string[];
  prefix: string;
  eol: string;
  segments: string[];
  /** Forward links: kind and the numbers it names, in the order the line names the kinds. */
  forward: Map<Kind, Set<string>>;
  forwardVerbs: Map<Kind, string>;
  links: string[];
}

const parse = (file: AdrFile, problems: string[]): Parsed | undefined => {
  const number = RECORD_NAME.exec(file.name)?.[1] ?? '';
  const lines = file.text.split('\n');
  const [first = ''] = lines;
  const title = TITLE.exec(first.replace(/^﻿/, '').replace(/\r$/, ''));
  if (title === null || title[1] !== number) {
    problems.push(`${file.name}:1: the first line is not \`# ${number}. <title>\``);
    return undefined;
  }
  const raw = lines[STATUS_LINE] ?? '';
  const eol = raw.endsWith('\r') ? '\r' : '';
  const status = STATUS.exec(raw.slice(0, raw.length - eol.length));
  if (status === null) {
    problems.push(`${file.name}:${STATUS_LINE + 1}: no \`Date: … · Status: …\` line`);
    return undefined;
  }
  const segments = (status[2] ?? '').split(SEGMENTS);
  const forward = new Map<Kind, Set<string>>();
  const forwardVerbs = new Map<Kind, string>();
  for (const segment of segments) {
    const kind = forwardKind(segment);
    if (kind === undefined) continue;
    forwardVerbs.set(kind, (segment.split(' ', 1)[0] ?? '').toLowerCase());
    const numbers = forward.get(kind) ?? new Set<string>();
    for (const link of linksIn(segment)) if (link.depth === 0) numbers.add(link.number);
    forward.set(kind, numbers);
  }
  return {
    name: file.name,
    number,
    title: title[2] ?? '',
    lines,
    prefix: status[1] ?? '',
    eol,
    segments,
    forward,
    forwardVerbs,
    links: segments.flatMap((segment) => linksIn(segment).map((link) => link.number)),
  };
};

const listed = (items: string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

const byNumber = (a: string, b: string): number => a.localeCompare(b);

const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

interface Rewritten {
  segments: string[];
  changes: string[];
}

// The status line's segments with every back clause matching `expected`, and what changed.
const rewrite = (
  record: Parsed,
  expected: Map<Kind, Set<string>>,
  fileOf: Map<string, string>,
  problems: string[],
): Rewritten => {
  let segments = [...record.segments];
  const changes: string[] = [];
  for (const kind of KINDS) {
    const want = expected.get(kind) ?? new Set<string>();
    const clauses = segments.flatMap((segment, index) =>
      forwardKind(segment) === undefined
        ? clausesIn(segment, index).filter((clause) => clause.kind === kind)
        : [],
    );
    const credited = new Set(clauses.flatMap((clause) => clause.entries.map((e) => e.number)));
    const added = [...want].filter((number) => !credited.has(number)).sort(byNumber);
    const removed = [...credited].filter((number) => !want.has(number)).sort(byNumber);
    if (added.length === 0 && removed.length === 0) continue;
    changes.push(
      `${kind} by ${[
        added.length > 0 ? `${listed(added)} added` : '',
        removed.length > 0 ? `${listed(removed)} removed` : '',
      ]
        .filter((part) => part !== '')
        .join(', ')}`,
    );
    const fresh = (number: string): Entry => ({
      number,
      text: `[${number}](${fileOf.get(number)})`,
    });
    if (clauses.length === 0) {
      const after = segments.reduce(
        (last, segment, index) =>
          forwardKind(segment) !== undefined || clausesIn(segment, index).length > 0 ? index : last,
        0,
      );
      segments.splice(
        after + 1,
        0,
        `${capitalised(kind)} by ${listed(added.map((number) => fresh(number).text))}`,
      );
      continue;
    }
    // Each clause keeps its own entries that still hold, once; the first takes the new ones.
    const seen = new Set<string>();
    const edits = clauses.map((clause, index) => {
      const kept = clause.entries.filter((entry) => {
        const keep = want.has(entry.number) && !seen.has(entry.number);
        seen.add(entry.number);
        return keep;
      });
      const entries = index === 0 ? [...kept, ...added.map(fresh)] : kept;
      entries.sort((a, b) => byNumber(a.number, b.number));
      return { clause, entries };
    });
    const dropped = new Set<number>();
    for (const { clause, entries } of edits.reverse()) {
      const text = segments[clause.segment] ?? '';
      if (entries.length > 0) {
        const list = listed(entries.map((entry) => entry.text));
        segments[clause.segment] = `${text.slice(0, clause.list)}${list}${text.slice(clause.end)}`;
      } else if (clause.start === 0 && clause.end === text.length && clause.segment > 0) {
        dropped.add(clause.segment);
      } else if (clause.end === text.length && text.slice(0, clause.start).endsWith(', ')) {
        segments[clause.segment] = text.slice(0, clause.start - 2);
      } else {
        problems.push(
          `${record.name}:${STATUS_LINE + 1}: cannot drop "${text.slice(clause.start, clause.end)}" from its text`,
        );
      }
    }
    segments = segments.filter((_, index) => !dropped.has(index));
  }
  return { segments, changes };
};

const row = (record: Parsed, expected: Map<Kind, Set<string>>): string => {
  const verbs = [...record.forward].flatMap(([kind, numbers]) =>
    numbers.size > 0
      ? [`${record.forwardVerbs.get(kind)} ${listed([...numbers].sort(byNumber))}`]
      : [],
  );
  const title = `${record.title}${verbs.length > 0 ? ` (${verbs.join(', ')})` : ''}`;
  const [own = ''] = record.segments;
  const firstClause = clausesIn(own, 0)[0];
  const ownStatus = (firstClause === undefined ? own : own.slice(0, firstClause.start))
    .replace(/,\s*$/, '')
    .trim();
  const parts = KINDS.flatMap((kind) => {
    const numbers = [...(expected.get(kind) ?? [])].sort(byNumber);
    return numbers.length > 0 ? [`${kind} by ${listed(numbers)}`] : [];
  });
  const status =
    ownStatus === ''
      ? capitalised(parts.join('; '))
      : [ownStatus, parts.join('; ')].filter(Boolean).join(', ');
  const cell = (text: string): string => text.replaceAll('|', '\\|');
  return `| [${record.number}](${record.name}) | ${cell(title)} | ${cell(status)} |`;
};

const ROW_NUMBER = /^\| \[(\d{4})\]/;

const rebuildTable = (
  readme: string,
  rows: string[],
  problems: string[],
): { text: string; changes: string[] } | undefined => {
  const lines = readme.split('\n');
  const bare = lines.map((line) => line.replace(/\r$/, ''));
  const header = bare.indexOf(TABLE_HEADER);
  const template = bare.indexOf(TEMPLATE);
  if (header === -1 || bare[header + 1] !== TABLE_RULE || template < header) {
    problems.push(`README.md: no \`${TABLE_HEADER}\` table before \`${TEMPLATE}\``);
    return undefined;
  }
  let end = header + 2;
  while (end < template && bare[end]?.startsWith('|')) end += 1;
  const eol = lines[header]?.endsWith('\r') ? '\r' : '';
  const before = new Map(
    bare.slice(header + 2, end).map((line) => [ROW_NUMBER.exec(line)?.[1] ?? line, line]),
  );
  const after = new Map(rows.map((line) => [ROW_NUMBER.exec(line)?.[1] ?? line, line]));
  const changes = [...new Set([...before.keys(), ...after.keys()])].sort(byNumber).flatMap((n) => {
    const old = before.get(n);
    const now = after.get(n);
    if (old === now) return [];
    return [
      `README.md: row ${n} ${old === undefined ? 'added' : now === undefined ? 'removed' : 'changed'}`,
    ];
  });
  const text = [
    ...lines.slice(0, header + 2),
    ...rows.map((line) => `${line}${eol}`),
    ...lines.slice(end),
  ].join('\n');
  return { text, changes };
};

export const rebuild = (readme: string, records: AdrFile[]): Rebuild => {
  const problems: string[] = [];
  const files = records
    .filter((file) => RECORD_NAME.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parsed = files.flatMap((file) => parse(file, problems) ?? []);
  const fileOf = new Map<string, string>();
  for (const file of files) {
    const number = RECORD_NAME.exec(file.name)?.[1] ?? '';
    const other = fileOf.get(number);
    if (other !== undefined)
      problems.push(`${other} and ${file.name}: two records numbered ${number}`);
    else fileOf.set(number, file.name);
  }
  for (const record of parsed) {
    for (const number of new Set(record.links)) {
      if (!fileOf.has(number)) {
        problems.push(`${record.name}:${STATUS_LINE + 1}: links to ${number}, which has no record`);
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const expected = new Map<string, Map<Kind, Set<string>>>();
  for (const record of parsed) {
    for (const [kind, numbers] of record.forward) {
      for (const number of numbers) {
        const kinds = expected.get(number) ?? new Map<Kind, Set<string>>();
        kinds.set(kind, (kinds.get(kind) ?? new Set()).add(record.number));
        expected.set(number, kinds);
      }
    }
  }

  const changed: AdrFile[] = [];
  const recordChanges: string[] = [];
  const rows: string[] = [];
  for (const record of parsed) {
    const kinds = expected.get(record.number) ?? new Map<Kind, Set<string>>();
    const { segments, changes } = rewrite(record, kinds, fileOf, problems);
    rows.push(row(record, kinds));
    if (changes.length === 0) continue;
    const lines = [...record.lines];
    lines[STATUS_LINE] = `${record.prefix}${segments.join(SEGMENTS)}${record.eol}`;
    changed.push({ name: record.name, text: lines.join('\n') });
    for (const change of changes)
      recordChanges.push(`${record.name}:${STATUS_LINE + 1}: ${change}`);
  }
  const table = rebuildTable(readme, rows, problems);
  if (table === undefined || problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    readme: table.text,
    records: changed,
    changes: [...table.changes, ...recordChanges],
  };
};
