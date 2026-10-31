// `node scripts/mutants.ts <tree> <answer.json> [<n>] [--touched <files.txt>]`: checks the
// mutants in Brett's answer against the brew-review scratch tree, or applies mutant <n> to it
// (issue #43). A mutant edits one line of a file under src/ or scripts/ (ADR 0034, 0040); with
// --touched, one of the files the change touches, as the review's files.txt lists them (#140).
// mutants/core.ts decides. Exits 1 when the answer cannot be read or mutant <n> is invalid.

import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathInside, samePath } from '../src/platform/paths.ts';
import {
  type ChangedFile,
  editFile,
  type Mutant,
  type MutantEdit,
  parseMutant,
  sameAnswerLine,
  sameAnswerMutants,
  touchedFiles,
} from './mutants/core.ts';

type Result = { ok: boolean; lines: string[] };

const readAnswer = async (answer: string): Promise<unknown[] | string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(answer, 'utf8'));
  } catch (error) {
    return `cannot read the answer: ${(error as Error).message}`;
  }
  const { mutants } = (parsed ?? {}) as { mutants?: unknown };
  return Array.isArray(mutants) ? mutants : 'the answer has no "mutants" list';
};

const realOrUndefined = (path: string): Promise<string | undefined> =>
  realpath(path).catch(() => undefined);

// The edited content of the mutant's file in the tree, and the real path it goes to. The file's
// folder (src/ or scripts/, checked by parseMutant) must be a folder of its own in the tree and
// the file a regular file really inside it, so no link, in that folder or as the folder itself,
// can lead the edit out of the tree.
const edit = async (
  tree: string,
  mutant: Mutant,
): Promise<{ ok: false; reason: string } | (MutantEdit & { ok: true; target: string })> => {
  const [name = ''] = mutant.file.split('/');
  const root = await realpath(tree);
  const folder = await realOrUndefined(join(tree, name));
  if (folder !== undefined && !samePath(folder, join(root, name))) {
    return { ok: false, reason: `the tree’s ${name}/ is not a folder of its own` };
  }
  const target = await realOrUndefined(join(tree, mutant.file));
  if (folder === undefined || target === undefined) {
    return { ok: false, reason: `${mutant.file} does not exist` };
  }
  if (pathInside(folder, target) === undefined) {
    return { ok: false, reason: `${mutant.file} is not inside the tree's ${name}/` };
  }
  if (!(await stat(target)).isFile()) return { ok: false, reason: `${mutant.file} is not a file` };
  const edited = editFile(mutant, await readFile(target, 'utf8'));
  return edited.ok ? { ...edited, target } : edited;
};

// The files the change touches, from the review's files.txt; undefined when none is given.
const readTouched = async (
  files: string | undefined,
): Promise<{ ok: true; touched?: string[] } | { ok: false; lines: string[] }> => {
  if (files === undefined) return { ok: true };
  try {
    return { ok: true, touched: touchedFiles(await readFile(files, 'utf8')) };
  } catch (error) {
    return { ok: false, lines: [`cannot read the changed files: ${(error as Error).message}`] };
  }
};

const check = async (tree: string, entry: unknown, touched: string[] | undefined) => {
  const parsed = parseMutant(entry, touched);
  if (!parsed.ok) return parsed;
  const { file, line } = parsed.mutant;
  const edited = await edit(tree, parsed.mutant);
  if (!edited.ok) return edited;
  const given = edited.line === line ? '' : ` (given as line ${line})`;
  return { ...edited, path: `${file}:${edited.line}${given}` };
};

export const checkMutants = async (
  tree: string,
  answer: string,
  files?: string,
): Promise<Result> => {
  const mutants = await readAnswer(answer);
  if (typeof mutants === 'string') return { ok: false, lines: [mutants] };
  const read = await readTouched(files);
  if (!read.ok) return read;
  const lines: string[] = [];
  for (const [index, entry] of mutants.entries()) {
    const result = await check(tree, entry, read.touched);
    lines.push(
      `mutant ${index + 1}: ${result.ok ? `valid ${result.path}` : `invalid: ${result.reason}`}`,
    );
  }
  return { ok: true, lines };
};

export const applyMutant = async (
  tree: string,
  answer: string,
  n: number,
  files?: string,
): Promise<Result> => {
  const mutants = await readAnswer(answer);
  if (typeof mutants === 'string') return { ok: false, lines: [mutants] };
  const entry = mutants[n - 1];
  if (!Number.isInteger(n) || entry === undefined) {
    return { ok: false, lines: [`mutant ${n}: no such mutant (the answer has ${mutants.length})`] };
  }
  const read = await readTouched(files);
  if (!read.ok) return read;
  const result = await check(tree, entry, read.touched);
  if (!result.ok) return { ok: false, lines: [`mutant ${n}: invalid: ${result.reason}`] };
  await writeFile(result.target, result.content);
  return { ok: true, lines: [`mutant ${n}: applied ${result.path}`] };
};

// Appends the same-answer mutants of the change to the answer file, in place of the ones an
// earlier run appended (#223).
// The sources are the touched files under src/ and scripts/, the tests the touched test files,
// as the tree has them; a file it cannot read gives no mutant.
export const sameAnswer = async (tree: string, answer: string, files: string): Promise<Result> => {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(answer, 'utf8'));
  } catch (error) {
    return { ok: false, lines: [`cannot read the answer: ${(error as Error).message}`] };
  }
  if (!Array.isArray(parsed?.mutants)) {
    return { ok: false, lines: ['the answer has no "mutants" list'] };
  }
  const read = await readTouched(files);
  if (!read.ok) return read;
  const changed = async (pattern: RegExp): Promise<ChangedFile[]> => {
    const paths = (read.touched ?? []).filter((path) => pattern.test(path));
    const contents = await Promise.all(
      paths.map((path) => readFile(join(tree, path), 'utf8').catch(() => undefined)),
    );
    return paths.flatMap((path, index) => {
      const content = contents[index];
      return content === undefined ? [] : [{ path, content }];
    });
  };
  const sources = await changed(/^(?:src|scripts)\/(?!.*\.test\.ts$).*\.ts$/);
  const scripted = sameAnswerMutants(sources, await changed(/^test\/.*\.test\.ts$/));
  const brett = parsed.mutants.filter(
    (entry: unknown) => (entry as { source?: unknown } | null)?.source !== 'script',
  );
  await writeFile(
    answer,
    `${JSON.stringify({ ...parsed, mutants: [...brett, ...scripted] }, null, 2)}\n`,
  );
  const lines = scripted.map((mutant) => `same answer: ${sameAnswerLine(mutant)}`);
  return { ok: true, lines: lines.length > 0 ? lines : ['same answer: none'] };
};

export interface MainResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

// The command line: its arguments, and what it prints and exits with.
export const main = async (argv: readonly string[]): Promise<MainResult> => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { touched: { type: 'string' }, 'same-answer': { type: 'boolean' } },
    allowPositionals: true,
  });
  const [tree, answer, n] = positionals;
  const sameAnswerRun = values['same-answer'] === true;
  if (
    tree === undefined ||
    answer === undefined ||
    (sameAnswerRun && (n !== undefined || values.touched === undefined))
  ) {
    const usage =
      'usage: node scripts/mutants.ts <scratch tree> <answer.json> [<mutant number> | --same-answer] [--touched <files.txt>] (--same-answer needs --touched)';
    return { exitCode: 2, stdout: [], stderr: [usage] };
  }
  const { ok, lines } = sameAnswerRun
    ? await sameAnswer(tree, answer, values.touched ?? '')
    : n === undefined
      ? await checkMutants(tree, answer, values.touched)
      : await applyMutant(tree, answer, Number(n), values.touched);
  return { exitCode: ok ? 0 : 1, stdout: lines.map((line) => `mutants: ${line}`), stderr: [] };
};

if (import.meta.main) {
  const { exitCode, stdout, stderr } = await main(process.argv.slice(2));
  for (const line of stdout) console.log(line);
  for (const line of stderr) console.error(line);
  process.exitCode = exitCode;
}
