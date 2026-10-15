// Runs git for Foedrum: non-interactive, with a timeout, through an argument array (architecture
// §13). Code that drives git takes a `Git` so unit tests can pass a fake one (ADR 0021).

export interface GitResult {
  /** The exit code; `null` when git was killed, for example by the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Kills git after this long; default 60 s. */
  timeoutMs?: number;
}

export type Git = (
  cwd: string,
  args: readonly string[],
  options?: GitOptions,
) => Promise<GitResult>;

/** The environment git runs in: it never prompts, in the terminal or in a credential window. */
export const gitEnv = (_env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  throw new Error('not implemented');
};

/** The real git. */
export const runGit: Git = () => {
  throw new Error('not implemented');
};
