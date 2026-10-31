// git's unified diff, as the red proof and the testsUnchanged guard read it (ADR 0078): the lines
// each file gained and lost. Pure.

/** One file of a diff: its path before and after (absent when it was added or deleted). */
export interface DiffFile {
  oldPath?: string;
  newPath?: string;
  added: readonly string[];
  /** The line at the tip of each of `added`, in its order: parseDiff always gives them (ADR 0274). */
  addedAt?: readonly number[];
  removed: readonly string[];
}

const ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** A path as git writes it in a header: C-quoted when it has special characters. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const inner = path.slice(1, -1);
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index] ?? '';
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(inner.slice(index + 1))?.[0];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
    } else {
      const next = inner[index + 1] ?? '';
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      index++;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The path of a `---` or `+++` header without its prefix, or undefined for /dev/null. */
function headerPath(rest: string, prefix: 'a/' | 'b/'): string | undefined {
  // git ends a header path that has a space with a tab.
  const path = unquote(rest.replace(/\t$/, ''));
  if (path === '/dev/null') return undefined;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** The files of `git diff` output made with `--no-color`, `--no-renames` and the a/ b/ prefixes. */
export function parseDiff(text: string): DiffFile[] {
  const files: { oldPath?: string; newPath?: string; added: string[]; removed: string[] }[] = [];
  // Lines left in the current hunk, old and new: inside one, every line is content.
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of text.split('\n')) {
    const file = files.at(-1);
    if (file !== undefined && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith('+')) {
        file.added.push(line.slice(1));
        newLeft--;
      } else if (line.startsWith('-')) {
        file.removed.push(line.slice(1));
        oldLeft--;
      } else if (line.startsWith(' ')) {
        oldLeft--;
        newLeft--;
      }
      // `\ No newline at end of file` takes no line of either side.
      continue;
    }
    if (line.startsWith('diff --git ')) {
      files.push({ added: [], removed: [] });
    } else if (file !== undefined && line.startsWith('--- ')) {
      const path = headerPath(line.slice(4), 'a/');
      if (path !== undefined) file.oldPath = path;
    } else if (file !== undefined && line.startsWith('+++ ')) {
      const path = headerPath(line.slice(4), 'b/');
      if (path !== undefined) file.newPath = path;
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (hunk !== null) {
        oldLeft = Number(hunk[1] ?? 1);
        newLeft = Number(hunk[2] ?? 1);
      }
    }
  }
  return files;
}
