// House-yeast rules (ADR 0015, ADR 0018): reads rule files and selects those whose scope matches a
// change and a lens, within a token budget (ADR 0122). Pure: /brew-review selects through it
// (scripts/house-yeast.ts), and in src/ a batch can too (#434).

import { posix } from 'node:path';
import { HouseYeastRule, type HouseYeastSelection } from '../schemas/house-yeast.ts';
import { readDoc } from '../schemas/read.ts';
import type { PromptInput } from './prompt.ts';

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

export const defaultBudget = 2000;

const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, '; ');

/** Reads rule files given with `/` paths, as the skill writes them; a rule's id is its file name without `.md`. */
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
    } else if (
      doc.frontmatter.scope.language !== undefined &&
      !Object.values(languages).includes(doc.frontmatter.scope.language)
    ) {
      // A language no extension has would never match, and the rule would drop out silently.
      read.invalid.push({
        path,
        reason: `language "${doc.frontmatter.scope.language}" is none of ${[...new Set(Object.values(languages))].join(', ')}`,
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

/** A rule with neither globs nor a language: it matches every change, so curation is due (ADR 0015). */
export const unscoped = ({ scope }: HouseYeastRule): boolean =>
  scope.globs === undefined && scope.language === undefined;

// A rule's lens by its name matches that lens in either folder: diff/<name> or plan/<name> (ADR 0169).
const lensMatches = (ruleLens: string | undefined, lens: string | undefined): boolean =>
  ruleLens === undefined ||
  (lens !== undefined && (ruleLens === lens || ruleLens === lens.slice(lens.indexOf('/') + 1)));

const matches = ({ rule }: Rule, files: readonly string[], lens?: string): boolean =>
  rule.status === 'active' &&
  lensMatches(rule.scope.lens, lens) &&
  (unscoped(rule) || files.some((file) => fileMatches(rule.scope, file)));

// Lower comes first: a rule for this lens, then globs, a language alone, the whole repository.
const rank = ({ scope }: HouseYeastRule): [number, number] => [
  scope.lens === undefined ? 1 : 0,
  scope.globs !== undefined ? 0 : scope.language !== undefined ? 1 : 2,
];

// Not localeCompare: a locale's collation would make the order, and so the cut, differ by machine.
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byPriority = (a: Rule, b: Rule): number => {
  const [lensA, scopeA] = rank(a.rule);
  const [lensB, scopeB] = rank(b.rule);
  return (
    lensA - lensB ||
    scopeA - scopeB ||
    byCodeUnits(b.rule.created, a.rule.created) ||
    byCodeUnits(a.rule.id, b.rule.id)
  );
};

/** A rule as a lens reads it: its heading and body. */
export const section = ({ rule, body }: Rule): string =>
  `## ${rule.id} (${rule.kind})\n\n${body}\n`;

// An estimate, about four characters a token: a budget of this size needs no tokenizer (ADR 0122).
const price = (rule: Rule): number => Math.ceil(section(rule).length / 4);

/**
 * The active rules whose scope matches the change and the lens, in order of priority, within the
 * budget: a rule that would pass what is left is cut, and the next one is tried.
 */
export const selectRules = (
  rules: readonly Rule[],
  change: { files: readonly string[]; lens?: string },
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

/** A rule file of the Brewery that could not be read, with why. */
export interface UnreadRuleFile {
  path: string;
  unreadable: string;
}

/**
 * The rule files `git ls-tree -z <commit> -- .foedrum/house-yeast/` lists: the regular `.md` files
 * directly in the folder, by path and blob id; never a link or a folder (ADR 0169).
 */
export const ruleBlobs = (lsTree: string): { path: string; blob: string }[] =>
  lsTree.split('\0').flatMap((entry) => {
    const [, blob, path] = /^100(?:644|755) blob ([0-9a-f]+)\t(.+\.md)$/.exec(entry) ?? [];
    return blob === undefined || path === undefined ? [] : [{ path, blob }];
  });

/**
 * The text of each of `blobs`, from what `git cat-file --batch` printed for their ids, in order;
 * throws when the output does not hold them.
 */
export const blobTexts = (
  blobs: readonly { path: string; blob: string }[],
  batch: string,
): RuleFile[] => {
  // Each blob is `<id> blob <size>`, a line feed, its bytes and a line feed: sizes count bytes.
  const bytes = Buffer.from(batch, 'utf8');
  let at = 0;
  return blobs.map(({ path, blob }) => {
    const lineEnd = bytes.indexOf(0x0a, at);
    const header = lineEnd < 0 ? '' : bytes.subarray(at, lineEnd).toString('utf8');
    const [, id, size = ''] = /^([0-9a-f]+) blob (\d+)$/.exec(header) ?? [];
    const end = lineEnd + 1 + Number(size);
    if (id !== blob || end >= bytes.length) {
      throw new Error(`git cat-file did not print the blob ${blob} of ${path}`);
    }
    at = end + 1;
    return { path, text: bytes.subarray(lineEnd + 1, end).toString('utf8') };
  });
};

/**
 * The Brewery's rule files by layer (ADR 0169): those directly in `house-yeast/` are the Brewery
 * layer, and for a repository whose rules are kept in the Brewery, those in
 * `house-yeast/<owner>/<name>/` are its repository layer.
 */
export const breweryRules = (
  files: readonly (RuleFile | UnreadRuleFile)[],
  repo: string,
  keptIn: 'repo' | 'brewery',
): { brewery: (RuleFile | UnreadRuleFile)[]; repository: (RuleFile | UnreadRuleFile)[] } => {
  // GitHub's names are not case-sensitive, so neither is the folder of one.
  const folder = `house-yeast/${repo.toLowerCase()}/`;
  const inFolder = ({ path }: { path: string }): boolean =>
    path.toLowerCase().startsWith(folder) && !path.slice(folder.length).includes('/');
  return {
    brewery: files.filter(({ path }) => /^house-yeast\/[^/]+$/.test(path)),
    repository: keptIn === 'brewery' ? files.filter(inFolder) : [],
  };
};

/** The rules one attempt gets: its inputs, and what it records (ADR 0169). */
export interface PickedRules {
  inputs: PromptInput[];
  record: HouseYeastSelection;
}

/** The rules of `files`, with those that could not be read among the invalid. */
const readLayer = (files: readonly (RuleFile | UnreadRuleFile)[]): Rules => {
  const read = readRules(files.flatMap((file) => ('text' in file ? [file] : [])));
  const unread = files.flatMap((file) =>
    'unreadable' in file ? [{ path: file.path, reason: file.unreadable }] : [],
  );
  return { rules: read.rules, invalid: [...read.invalid, ...unread] };
};

/**
 * The rules of both layers whose scope matches `change`, within `budget`: a repository rule over a
 * Brewery rule of its id (ADR 0018), each selected one as an input named `houseYeast`, and the ids
 * selected and cut and the files left out as invalid, which the attempt records (ADR 0169).
 */
export const pickRules = (
  layers: {
    repository: readonly (RuleFile | UnreadRuleFile)[];
    brewery: readonly (RuleFile | UnreadRuleFile)[];
  },
  change: { files: readonly string[]; lens?: string },
  budget: number = defaultBudget,
): PickedRules => {
  const repository = readLayer(layers.repository);
  const brewery = readLayer(layers.brewery);
  const own = new Set(repository.rules.map(({ rule }) => rule.id));
  const rules = [...repository.rules, ...brewery.rules.filter(({ rule }) => !own.has(rule.id))];
  const { selected, cut } = selectRules(rules, change, budget);
  const invalid = [...repository.invalid, ...brewery.invalid].map(({ path }) => path);
  const idsOf = (priced: readonly Priced[]): string[] => priced.map(({ rule }) => rule.rule.id);
  return {
    inputs: selected.map(({ rule }) => ({
      name: 'houseYeast',
      source: { kind: 'house-yeast', rule: rule.rule.id, path: rule.path },
      text: section(rule),
    })),
    record: {
      selected: idsOf(selected),
      cut: idsOf(cut),
      ...(invalid.length === 0 ? {} : { invalid }),
    },
  };
};
