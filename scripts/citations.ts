// `node scripts/citations.ts <checkout> <answer.json>`: checks that every finding in a reviewer's
// answer cites a file of the checkout and a line within it (issue #43). citations/core.ts
// decides. Prints one line per finding; exits 1 when the answer cannot be read.

import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathInside } from '../src/platform/paths.ts';
import { type CitationCheck, checkLine, entriesOf, parseCitation } from './citations/core.ts';

type Result = { ok: boolean; lines: string[] };

const readAnswer = async (answer: string): Promise<unknown[] | string> => {
  let parsed: unknown;
  try {
    // An answer saved on Windows may start with a byte order mark (CLAUDE.md, Cross-platform).
    parsed = JSON.parse((await readFile(answer, 'utf8')).replace(/^﻿/, ''));
  } catch (error) {
    return `cannot read the answer: ${(error as Error).message}`;
  }
  return entriesOf(parsed);
};

// The file must be a regular file really inside the checkout, so a link cannot make the check
// read a file outside it. Its real path must also be the cited one, letter case included, so a
// citation that only resolves on a case-insensitive file system does not exist on any.
const check = async (checkout: string, entry: unknown): Promise<CitationCheck> => {
  const parsed = parseCitation(entry);
  if (!parsed.ok || parsed.citation === undefined) return parsed;
  const { file } = parsed.citation;
  const root = await realpath(checkout);
  const target = await realpath(join(checkout, file)).catch(() => undefined);
  if (target === undefined) return checkLine(parsed.citation, undefined);
  const inside = pathInside(root, target);
  if (inside === undefined) return { ok: false, reason: `${file} is not inside the checkout` };
  if (inside !== file) return checkLine(parsed.citation, undefined);
  if (!(await stat(target)).isFile()) return { ok: false, reason: `${file} is not a file` };
  return checkLine(parsed.citation, await readFile(target, 'utf8'));
};

export const checkCitations = async (checkout: string, answer: string): Promise<Result> => {
  const entries = await readAnswer(answer);
  if (typeof entries === 'string') return { ok: false, lines: [entries] };
  const lines: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const result = await check(checkout, entry);
    const verdict = !result.ok
      ? `unverified: ${result.reason}`
      : result.citation === undefined
        ? 'no location'
        : `ok ${result.citation.file}:${result.citation.line}`;
    lines.push(`finding ${index + 1}: ${verdict}`);
  }
  return { ok: true, lines };
};

if (import.meta.main) {
  const [checkout, answer] = process.argv.slice(2);
  if (checkout === undefined || answer === undefined) {
    console.error('usage: node scripts/citations.ts <checkout> <answer.json>');
    process.exitCode = 2;
  } else {
    const { ok, lines } = await checkCitations(checkout, answer);
    for (const line of lines) console.log(`citations: ${line}`);
    if (!ok) process.exitCode = 1;
  }
}
