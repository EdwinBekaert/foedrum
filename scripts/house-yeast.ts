// `node scripts/house-yeast.ts select|list|record …`: the house-yeast rules of /brew-review
// (issue #32, ADR 0122). house-yeast/core.ts decides; this file reads and writes the files.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, posix } from 'node:path';
import {
  changedFiles,
  defaultBudget,
  formatRule,
  proposeRule,
  readCandidates,
  readRules,
  renderRules,
  selectRules,
  unscoped,
} from './house-yeast/core.ts';

export interface RunDeps {
  readFile: (path: string) => string;
  readDir: (dir: string) => string[];
  exists: (path: string) => boolean;
  writeFile: (path: string, text: string) => void;
  appendFile: (path: string, text: string) => void;
  out: (text: string) => void;
  err: (text: string) => void;
}

const usage = `usage:
  node scripts/house-yeast.ts select <rules-dir> <files.txt> <lens> <out.md> [--budget <tokens>]
  node scripts/house-yeast.ts list <candidates.jsonl>
  node scripts/house-yeast.ts record <candidates.jsonl> <candidate.json> <rules-dir> [--asked]
`;

const firstLine = (error: unknown): string => (error as Error).message.split('\n')[0] ?? '';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

// The candidates, empty when the store does not exist yet; undefined, with the reason printed, when
// it exists but cannot be read, so a store that is there is never taken for an empty one.
const readStore = (deps: RunDeps, store: string): string | undefined => {
  try {
    return deps.readFile(store);
  } catch (error) {
    if (missing(error)) return '';
    deps.out(`cannot read the candidates: ${firstLine(error)}\n`);
    return undefined;
  }
};

const select = (
  [dir, filesTxt, lens, outFile]: string[],
  budget: number,
  deps: RunDeps,
): number => {
  if (dir === undefined || filesTxt === undefined || lens === undefined || outFile === undefined) {
    deps.err(usage);
    return 2;
  }
  let nameStatus: string;
  try {
    nameStatus = deps.readFile(filesTxt);
  } catch (error) {
    deps.out(`cannot read the changed files: ${firstLine(error)}\n`);
    return 1;
  }
  let names: string[] = [];
  try {
    names = deps
      .readDir(dir)
      .filter((name) => name.endsWith('.md'))
      .sort();
  } catch (error) {
    // No rules folder at the base: no rules yet. Any other error is not "no rules".
    if (!missing(error)) {
      deps.out(`cannot read the rules: ${firstLine(error)}\n`);
      return 1;
    }
  }
  const { rules, invalid } = readRules(
    names.map((name) => posix.join(dir, name)).map((path) => ({ path, text: deps.readFile(path) })),
  );
  for (const { path, reason } of invalid) deps.out(`invalid ${path}: ${reason}\n`);
  const selection = selectRules(rules, { files: changedFiles(nameStatus), lens }, budget);
  for (const { rule, tokens } of selection.selected) {
    const promotion = rule.rule.kind === 'structural' ? ', promotion candidate' : '';
    deps.out(`selected ${rule.rule.id} (${tokens} tokens)${promotion}\n`);
  }
  for (const { rule, tokens } of selection.cut) {
    deps.out(`cut ${rule.rule.id} (${tokens} tokens): over the budget of ${budget}\n`);
  }
  for (const { rule } of [...selection.selected, ...selection.cut]) {
    if (unscoped(rule.rule)) {
      deps.out(`no scope ${rule.rule.id}: selected for every change, due for curation\n`);
    }
  }
  deps.writeFile(outFile, renderRules(lens, selection));
  return 0;
};

const list = ([store]: string[], deps: RunDeps): number => {
  if (store === undefined) {
    deps.err(usage);
    return 2;
  }
  const text = readStore(deps, store);
  if (text === undefined) return 1;
  const { candidates, invalid } = readCandidates(text);
  for (const line of invalid) deps.out(`invalid ${line}\n`);
  if (candidates.length === 0) deps.out('no candidates\n');
  for (const lesson of new Set(candidates.map((candidate) => candidate.lesson))) {
    const seen = candidates.filter((candidate) => candidate.lesson === lesson);
    const newest = seen.at(-1);
    if (newest === undefined) continue;
    const reviews = plural(new Set(seen.map((candidate) => candidate.review)).size, 'review');
    deps.out(`${lesson} (${newest.kind}, ${reviews}): ${newest.rule.replace(/\s+/g, ' ')}\n`);
  }
  return 0;
};

const record = ([store, file, dir]: string[], asked: boolean, deps: RunDeps): number => {
  if (store === undefined || file === undefined || dir === undefined) {
    deps.err(usage);
    return 2;
  }
  let text: string;
  try {
    text = deps.readFile(file);
  } catch (error) {
    deps.out(`cannot read the candidate: ${firstLine(error)}\n`);
    return 1;
  }
  // A JSON string holds no raw line break, so a pretty-printed candidate is one line without them.
  const { candidates: [candidate] = [], invalid } = readCandidates(text.replace(/\r?\n/g, ' '));
  if (candidate === undefined) {
    deps.out(`invalid candidate: ${invalid[0]?.replace(/^line 1: /, '') ?? 'empty'}\n`);
    return 1;
  }
  const before = readStore(deps, store);
  if (before === undefined) return 1;
  const separator = before === '' || before.endsWith('\n') ? '' : '\n';
  deps.appendFile(store, `${separator}${JSON.stringify(candidate)}\n`);
  const proposal = proposeRule(
    [...readCandidates(before).candidates, candidate],
    candidate.lesson,
    asked,
  );
  if (proposal === undefined) {
    deps.out(`recorded ${candidate.lesson}: seen in 1 review\n`);
    return 0;
  }
  const path = posix.join(dir, `${candidate.lesson}.md`);
  if (deps.exists(path)) {
    deps.out(`exists ${path}: not overwritten\n`);
    return 0;
  }
  deps.writeFile(path, formatRule(proposal.rule, proposal.body));
  const why = proposal.reviews >= 2 ? `seen in ${plural(proposal.reviews, 'review')}` : 'asked for';
  deps.out(`proposed ${path}: ${why}\n`);
  return 0;
};

// The command without the process: the exit code for these arguments.
export const run = (args: string[], deps: RunDeps): number => {
  const positional: string[] = [];
  let budget = defaultBudget;
  let asked = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--asked') asked = true;
    else if (arg === '--budget') {
      const value = args[++i] ?? '';
      if (!/^[1-9][0-9]*$/.test(value)) {
        deps.err(usage);
        return 2;
      }
      budget = Number(value);
    } else positional.push(arg);
  }
  const [command, ...rest] = positional;
  switch (command) {
    case 'select':
      return select(rest, budget, deps);
    case 'list':
      return list(rest, deps);
    case 'record':
      return record(rest, asked, deps);
    default:
      deps.err(usage);
      return 2;
  }
};

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    readFile: (path) => readFileSync(path, 'utf8'),
    readDir: (dir) => readdirSync(dir),
    exists: (path) => existsSync(path),
    writeFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    appendFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, text);
    },
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
