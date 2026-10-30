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

/**
 * The files of `git diff --name-status -z` the change adds, alters or renames (new path), as git
 * wrote them, never quoted; not deleted ones (ADR 0169).
 */
export const changedFilesZ = (nameStatus: string): string[] => {
  // Each entry is its status, then its path, or for a rename or a copy its old and new paths.
  const fields = nameStatus.split('\0');
  const files: string[] = [];
  for (let at = 0; at < fields.length - 1; ) {
    const status = fields[at] ?? '';
    const paths = /^[RC]/.test(status) ? 2 : 1;
    const path = fields[at + paths];
    if (path !== undefined && !status.startsWith('D')) files.push(path);
    at += 1 + paths;
  }
  return files;
};

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

// A rule's lens by its name matches that lens in either folder: diff/<name> or plan/<name>. A lens
// given without its folder, as /brew-review gives its own, is the diff lens of that name (ADR 0169).
const lensMatches = (ruleLens: string | undefined, given: string | undefined): boolean => {
  const lens = given === undefined || given.includes('/') ? given : `diff/${given}`;
  return (
    ruleLens === undefined ||
    (lens !== undefined && (ruleLens === lens || ruleLens === lens.slice(lens.indexOf('/') + 1)))
  );
};

const matches = (
  { rule }: Rule,
  files: readonly string[],
  lens: string | undefined,
  everyLens: boolean,
): boolean =>
  rule.status === 'active' &&
  (everyLens || lensMatches(rule.scope.lens, lens)) &&
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
 * The active rules whose scope matches the change and the lens, or with `everyLens` whatever lens
 * they name (#671), in order of priority, within the budget: a rule that would pass what is left
 * is cut, and the next one is tried.
 */
export const selectRules = (
  rules: readonly Rule[],
  change: { files: readonly string[]; lens?: string; everyLens?: boolean },
  budget: number = defaultBudget,
): Selection => {
  const selection: Selection = { selected: [], cut: [] };
  let left = budget;
  const matching = rules.filter((r) =>
    matches(r, change.files, change.lens, change.everyLens === true),
  );
  for (const rule of matching.sort(byPriority)) {
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

/** A rule file as it was read, or why it could not be. */
export type RuleSource = RuleFile | UnreadRuleFile;

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
 * The text of each of `blobs`, from what `git cat-file --batch` printed for their ids, in order,
 * or why it is not a rule's (ADR 0169); throws when the output does not hold them.
 */
export const blobTexts = (
  blobs: readonly { path: string; blob: string }[],
  batch: string,
): RuleSource[] => {
  // Each blob is `<id> blob <size>`, a line feed, its bytes and a line feed: sizes count bytes.
  // The runner decoded them as UTF-8, and a byte that is not became U+FFFD, three bytes, so a
  // blob ends where the next one's header starts, and its size only checks it.
  let at = 0;
  return blobs.map(({ path, blob }, index) => {
    const lineEnd = batch.indexOf('\n', at);
    const header = lineEnd < 0 ? '' : batch.slice(at, lineEnd);
    const [, id, size = ''] = /^([0-9a-f]+) blob (\d+)$/.exec(header) ?? [];
    const next = blobs[index + 1];
    const end =
      next === undefined ? batch.length - 1 : batch.indexOf(`\n${next.blob} blob `, lineEnd);
    const text = batch.slice(lineEnd + 1, end);
    const unreadable = text.includes('�');
    if (
      id !== blob ||
      end <= lineEnd ||
      batch[end] !== '\n' ||
      (!unreadable && Buffer.byteLength(text) !== Number(size))
    ) {
      throw new Error(`git cat-file did not print the blob ${blob} of ${path}`);
    }
    at = end + 1;
    return unreadable ? { path, unreadable: 'it is not UTF-8 text' } : { path, text };
  });
};

/**
 * The Brewery's rule files by layer (ADR 0169): those directly in `house-yeast/` are the Brewery
 * layer, and for a repository whose rules are kept in the Brewery, those in
 * `house-yeast/<owner>/<name>/` are its repository layer.
 */
export const breweryRules = (
  files: readonly RuleSource[],
  repo: string,
  keptIn: 'repo' | 'brewery',
): { brewery: RuleSource[]; repository: RuleSource[] } => {
  // GitHub's names are not case-sensitive, so neither is the folder of one.
  const folder = `house-yeast/${repo.toLowerCase()}`;
  // A folder that could not be listed is named by its own path, in the layer it holds.
  const unlisted = (file: RuleSource, name: string): boolean =>
    'unreadable' in file && file.path.toLowerCase() === name;
  const inFolder = (file: RuleSource): boolean =>
    unlisted(file, folder) ||
    (file.path.toLowerCase().startsWith(`${folder}/`) &&
      !file.path.slice(folder.length + 1).includes('/'));
  return {
    brewery: files.filter(
      (file) => unlisted(file, 'house-yeast') || /^house-yeast\/[^/]+$/.test(file.path),
    ),
    repository: keptIn === 'brewery' ? files.filter(inFolder) : [],
  };
};

/** The rules one attempt gets: its inputs, and what it records (ADR 0169). */
export interface PickedRules {
  inputs: PromptInput[];
  record: HouseYeastSelection;
}

/** The rules of `files`, with those that could not be read among the invalid. */
const readLayer = (files: readonly RuleSource[]): Rules => {
  // A byte that is not UTF-8 was read as U+FFFD, from the file system as from git.
  const garbled = (file: RuleSource): RuleSource =>
    'text' in file && file.text.includes('�')
      ? { path: file.path, unreadable: 'it is not UTF-8 text' }
      : file;
  const checked = files.map(garbled);
  const read = readRules(checked.flatMap((file) => ('text' in file ? [file] : [])));
  const unread = checked.flatMap((file) =>
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
  layers: { repository: readonly RuleSource[]; brewery: readonly RuleSource[] },
  change: {
    files: readonly string[];
    lens?: string;
    lenses?: readonly string[];
    everyLens?: boolean;
  },
  budget: number = defaultBudget,
): PickedRules => {
  const repository = readLayer(layers.repository);
  const brewery = readLayer(layers.brewery);
  const own = new Set(repository.rules.map(({ rule }) => rule.id));
  const rules = [...repository.rules, ...brewery.rules.filter(({ rule }) => !own.has(rule.id))];
  // A step's lenses together get the rules each would get apart, each once, in their order, and
  // a rule one lens cut and another selected counts as selected (ADR 0220). Every lens's rules
  // share one budget (ADR 0268).
  const each = change.everyLens
    ? [selectRules(rules, change, budget)]
    : (change.lenses ?? [change.lens]).map((lens) =>
        selectRules(
          rules,
          { files: change.files, ...(lens === undefined ? {} : { lens }) },
          budget,
        ),
      );
  const once = (priced: readonly Priced[]): Priced[] => [
    ...new Map(priced.map((found) => [found.rule.rule.id, found])).values(),
  ];
  const selected = once(each.flatMap((selection) => selection.selected));
  const taken = new Set(selected.map(({ rule }) => rule.rule.id));
  const cut = once(each.flatMap((selection) => selection.cut)).filter(
    ({ rule }) => !taken.has(rule.rule.id),
  );
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
