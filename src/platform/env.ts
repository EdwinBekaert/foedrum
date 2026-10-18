// Environment variables that differ between operating systems (architecture §13).

/**
 * The key under which `platform` knows an environment variable: Windows does not tell names
 * apart by case, so `Path` and `PATH` are one variable there; other platforms keep them apart.
 */
export const envNameKey =
  (platform: NodeJS.Platform) =>
  (name: string): string =>
    platform === 'win32' ? name.toUpperCase() : name;

/**
 * The name of the user who runs the program: `lookup` (the operating system's account, which
 * throws on Linux and macOS for a uid without a passwd entry), else `USER`, else `USERNAME`,
 * else `unknown`. Never empty.
 */
export const userName = (lookup: () => string, env: NodeJS.ProcessEnv): string => {
  let account: string | undefined;
  try {
    account = lookup();
  } catch {
    // No account name: the environment's, if any.
  }
  const named = [account, env.USER, env.USERNAME].find(
    (name) => name !== undefined && /\S/.test(name),
  );
  return named ?? 'unknown';
};

/**
 * `env` without the variables gh reads a GitHub token from (ADR 0073): gh would prefer any of them
 * to its own login, also when git asks it for a credential. Names compare as `platform` does.
 */
export const withoutGitHubTokens = (
  _env: NodeJS.ProcessEnv,
  _platform: NodeJS.Platform,
): NodeJS.ProcessEnv => {
  throw new Error('not implemented');
};
