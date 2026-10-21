// `node scripts/issue-draft.ts <draft.json>`: checks a pre-existing issue draft before
// /brew-review files it (issue #267). issue-draft/core.ts decides. Exit 0 prints the title the
// draft would file; exit 1 prints one line per problem; exit 2 is a usage error.

export interface RunDeps {
  readFile: (file: string) => string;
  out: (text: string) => void;
  err: (text: string) => void;
}

// The command without the process: the exit code for these arguments.
export const run = (_args: string[], _deps: RunDeps): number => {
  throw new Error('not implemented');
};
