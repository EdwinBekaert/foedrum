// Claude Code PreToolUse hook: runs `npm run check` before `git push` and `gh pr create`.

export interface CheckResult {
  ok: boolean;
  output: string;
}

export type RunCheck = (cwd: string) => Promise<CheckResult>;

export interface HookResult {
  exitCode: 0 | 2;
  stderr: string;
}

export const isGatedCommand = (_command: string): boolean => {
  throw new Error('not implemented');
};

export const precheck = async (_input: string, _runCheck: RunCheck): Promise<HookResult> => {
  throw new Error('not implemented');
};
