// Claude Code PreToolUse hook for Read, Grep and Glob: lets a call through only when every path
// it reads resolves inside the checkout, `CLAUDE_PROJECT_DIR` (ADR 0048).
// Exit 0 lets the tool call through; exit 2 blocks it and shows stderr to Claude.

export interface HookResult {
  exitCode: 0 | 2;
  stderr: string;
}

export interface GuardDeps {
  /** The checkout: `CLAUDE_PROJECT_DIR`, undefined when it is not set. */
  root: string | undefined;
  platform: NodeJS.Platform;
  homedir: string;
  /** The real path of an absolute path; throws when it cannot be resolved. */
  realPath: (path: string) => string;
}

export const readGuard = async (
  _input: string,
  _loadDeps: () => Promise<GuardDeps>,
): Promise<HookResult> => {
  throw new Error('not implemented');
};
