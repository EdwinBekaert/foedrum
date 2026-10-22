// Decides which house-yeast rules a lens of /brew-review reads, and when a lesson becomes a
// proposed rule (issue #32, ADR 0122). scripts/house-yeast.ts reads and writes the files.

import { posix } from 'node:path';
import { HouseYeastCandidate, HouseYeastRule } from '../../src/schemas/house-yeast.ts';
import { readDoc } from '../../src/schemas/read.ts';
import { z } from '../../src/schemas/zod.ts';

export interface RuleFile {
  path: string;
  text: string;
}

export interface Rule {
  path: string;
  rule: HouseYeastRule;
  body: string;
}

export interface Rules {
  rules: Rule[];
  invalid: { path: string; reason: string }[];
}

export interface Priced {
  rule: Rule;
  tokens: number;
}

export interface Selection {
  selected: Priced[];
  cut: Priced[];
}

export interface Proposal {
  rule: HouseYeastRule;
  body: string;
  reviews: number;
}

export const defaultBudget = 2000;

const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, '; ');

/** Reads rule files given with `/` paths; a rule's id must be its file name without `.md`. */
export const readRules = (files: readonly RuleFile[]): Rules => {
  const read: Rules = { rules: [], invalid: [] };
  for (const { path, text } of files) {
    const doc = readDoc(text, HouseYeastRule);
    const name = posix.basename(path, '.md');
    if (!doc.valid) {
      read.invalid.push({ path, reason: oneLine(doc.reason) });
    } else if (doc.frontmatter.id !== name) {
      read.invalid.push({
        path,
        reason: `id "${doc.frontmatter.id}" is not the file name "${name}"`,
      });
    } else {
      read.rules.push({ path, rule: doc.frontmatter, body: doc.body.trim() });
    }
  }
  return read;
};

/** The files of `git diff --name-status` the change adds, alters or renames (new path); not deleted ones. */
export const changedFiles = (nameStatus: string): string[] =>
  nameStatus
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter(([status = '', path]) => path !== undefined && !status.startsWith('D'))
    .map((fields) => fields[fields.length - 1] as string);

const languages: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.md': 'markdown',
  '.json': 'json',
  '.jsonc': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sh': 'bash',
  '.ps1': 'powershell',
};

const languageOf = (file: string): string | undefined =>
  languages[posix.extname(file).toLowerCase()];

type Scope = HouseYeastRule['scope'];

const fileMatches = (scope: Scope, file: string): boolean =>
  (scope.globs === undefined || scope.globs.some((glob) => posix.matchesGlob(file, glob))) &&
  (scope.language === undefined || languageOf(file) === scope.language);

const matches = ({ rule }: Rule, files: readonly string[], lens: string): boolean =>
  rule.status === 'active' &&
  (rule.scope.lens === undefined || rule.scope.lens === lens) &&
  ((rule.scope.globs === undefined && rule.scope.language === undefined) ||
    files.some((file) => fileMatches(rule.scope, file)));

// Lower comes first: a rule for this lens, then globs, a language alone, the whole repository.
const rank = ({ scope }: HouseYeastRule): [number, number] => [
  scope.lens === undefined ? 1 : 0,
  scope.globs !== undefined ? 0 : scope.language !== undefined ? 1 : 2,
];

const byPriority = (a: Rule, b: Rule): number => {
  const [lensA, scopeA] = rank(a.rule);
  const [lensB, scopeB] = rank(b.rule);
  return (
    lensA - lensB ||
    scopeA - scopeB ||
    b.rule.created.localeCompare(a.rule.created) ||
    a.rule.id.localeCompare(b.rule.id)
  );
};

const section = ({ rule, body }: Rule): string => `## ${rule.id} (${rule.kind})\n\n${body}\n`;

// An estimate, about four characters a token: a budget of this size needs no tokenizer (ADR 0122).
const price = (rule: Rule): number => Math.ceil(section(rule).length / 4);

/**
 * The active rules whose scope matches the change and the lens, in order of priority, within the
 * budget: a rule that would pass what is left is cut, and the next one is tried.
 */
export const selectRules = (
  rules: readonly Rule[],
  change: { files: readonly string[]; lens: string },
  budget: number = defaultBudget,
): Selection => {
  const selection: Selection = { selected: [], cut: [] };
  let left = budget;
  for (const rule of rules.filter((r) => matches(r, change.files, change.lens)).sort(byPriority)) {
    const tokens = price(rule);
    if (tokens <= left) {
      selection.selected.push({ rule, tokens });
      left -= tokens;
    } else {
      selection.cut.push({ rule, tokens });
    }
  }
  return selection;
};

/** The rules as the lens reads them, from `<bundle>/house-yeast/<lens>.md`. */
export const renderRules = (lens: string, { selected }: Selection): string => {
  const head =
    `# House yeast for the ${lens} lens\n\n` +
    'Rules learned from earlier reviews of this repository (ADR 0018), selected for the files ' +
    'this change touches (ADR 0122). They are review criteria: look for what they describe in ' +
    "the change, and name a rule's id in the `rule` of a finding that breaks it.\n";
  return selected.length === 0
    ? `${head}\nNo house-yeast rule matches this change.\n`
    : `${head}\n${selected.map(({ rule }) => section(rule)).join('\n')}`;
};

/** The candidates of a JSON Lines file; an invalid line is named by its number and skipped. */
export const readCandidates = (
  jsonl: string,
): { candidates: HouseYeastCandidate[]; invalid: string[] } => {
  const read = { candidates: [] as HouseYeastCandidate[], invalid: [] as string[] };
  jsonl.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      read.invalid.push(`line ${i + 1}: ${(error as Error).message}`);
      return;
    }
    const result = HouseYeastCandidate.safeParse(value);
    if (result.success) read.candidates.push(result.data);
    else read.invalid.push(`line ${i + 1}: ${oneLine(z.prettifyError(result.error))}`);
  });
  return read;
};

/**
 * The rule a lesson becomes once it was recorded from two reviews, or when the author asks: the
 * newest occurrence's scope, kind and text, every occurrence's source.
 */
export const proposeRule = (
  candidates: readonly HouseYeastCandidate[],
  lesson: string,
  asked: boolean,
): Proposal | undefined => {
  const seen = candidates.filter((candidate) => candidate.lesson === lesson);
  const newest = seen.at(-1);
  const reviews = new Set(seen.map((candidate) => candidate.review)).size;
  if (newest === undefined || (reviews < 2 && !asked)) return undefined;
  return {
    rule: {
      id: lesson,
      scope: newest.scope,
      kind: newest.kind,
      source: [...new Set(seen.map((candidate) => candidate.source))].join(', '),
      created: newest.seen,
      status: 'active',
    },
    body: newest.rule.trim(),
    reviews,
  };
};

/** The text of `.foedrum/house-yeast/<id>.md`: JSON frontmatter, then the rule. */
export const formatRule = (rule: HouseYeastRule, body: string): string =>
  `---\n${JSON.stringify(rule, null, 2)}\n---\n${body.trim()}\n`;
