// Dependency guard: checks package-lock.json against the policy in DEPENDENCIES.md and .npmrc.
// Usage: node scripts/check-deps.ts [--offline], run from the repository root.
// Exit 0: the lockfile passes. Exit 1: problems found, one line each on stdout. Exit 2: usage or read error.

export interface LockEntry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  hasInstallScript?: boolean;
  link?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface Lockfile {
  packages: Record<string, LockEntry>;
}

export interface Policy {
  runtimeBudget: number;
  totalBudget: number;
  admitted: ReadonlySet<string>;
  minReleaseAgeDays: number;
}

export interface PublishDateOptions {
  fetch: typeof fetch;
  now: Date;
  minReleaseAgeDays: number;
}

export const parseLockfile = (_text: string): Lockfile => {
  throw new Error('not implemented');
};

export const readPolicy = (_dependenciesMd: string, _npmrc: string): Policy => {
  throw new Error('not implemented');
};

export const checkLockfile = (_lock: Lockfile, _policy: Policy): string[] => {
  throw new Error('not implemented');
};

export const checkPublishDates = async (
  _lock: Lockfile,
  _options: PublishDateOptions,
): Promise<string[]> => {
  throw new Error('not implemented');
};
