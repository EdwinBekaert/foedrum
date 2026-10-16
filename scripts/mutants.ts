// `node scripts/mutants.ts <tree> <answer.json> [<n>]`: checks the mutants in Brett's answer
// against the brew-review scratch tree, or applies mutant <n> to it (issue #43).
// mutants/core.ts decides. Exits 1 when the answer cannot be read or mutant <n> is invalid.

import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathInside } from '../src/platform/paths.ts';
import { editFile, type Mutant, type MutantEdit, parseMutant } from './mutants/core.ts';

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

// The edited content of the mutant's file in the tree. The file must really lie inside the
// tree's src/, so a link in src/ cannot lead the edit outside it.
const edit = async (tree: string, mutant: Mutant): Promise<MutantEdit> => {
  let file: string;
  try {
    file = await realpath(join(tree, mutant.file));
  } catch {
    return editFile(mutant, undefined);
  }
  const src = await realpath(join(tree, 'src'));
  if (pathInside(src, file) === undefined) {
    return { ok: false, reason: `${mutant.file} is not inside the tree's src/` };
  }
  return editFile(mutant, await readFile(file, 'utf8'));
};

const check = async (tree: string, entry: unknown): Promise<MutantEdit & { path?: string }> => {
  const parsed = parseMutant(entry);
  if (!parsed.ok) return parsed;
  const { file, line } = parsed.mutant;
  const edited = await edit(tree, parsed.mutant);
  if (!edited.ok) return edited;
  const given = edited.line === line ? '' : ` (given as line ${line})`;
  return { ...edited, path: `${file}:${edited.line}${given}` };
};

export const checkMutants = async (tree: string, answer: string): Promise<Result> => {
  const mutants = await readAnswer(answer);
  if (typeof mutants === 'string') return { ok: false, lines: [mutants] };
  const lines: string[] = [];
  for (const [index, entry] of mutants.entries()) {
    const result = await check(tree, entry);
    lines.push(
      `mutant ${index + 1}: ${result.ok ? `valid ${result.path}` : `invalid: ${result.reason}`}`,
    );
  }
  return { ok: true, lines };
};

export const applyMutant = async (tree: string, answer: string, n: number): Promise<Result> => {
  const mutants = await readAnswer(answer);
  if (typeof mutants === 'string') return { ok: false, lines: [mutants] };
  const entry = mutants[n - 1];
  if (!Number.isInteger(n) || entry === undefined) {
    return { ok: false, lines: [`mutant ${n}: no such mutant (the answer has ${mutants.length})`] };
  }
  const result = await check(tree, entry);
  if (!result.ok) return { ok: false, lines: [`mutant ${n}: invalid: ${result.reason}`] };
  await writeFile(join(tree, (entry as Mutant).file), result.content);
  return { ok: true, lines: [`mutant ${n}: applied ${result.path}`] };
};

if (import.meta.main) {
  const [tree, answer, n] = process.argv.slice(2);
  if (tree === undefined || answer === undefined) {
    console.error('usage: node scripts/mutants.ts <scratch tree> <answer.json> [<mutant number>]');
    process.exitCode = 2;
  } else {
    const { ok, lines } =
      n === undefined
        ? await checkMutants(tree, answer)
        : await applyMutant(tree, answer, Number(n));
    for (const line of lines) console.log(`mutants: ${line}`);
    if (!ok) process.exitCode = 1;
  }
}
