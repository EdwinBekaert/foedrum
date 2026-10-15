// Dependency guard: checks package-lock.json against the policy in DEPENDENCIES.md and .npmrc.
// Usage: node scripts/check-deps.ts [--offline], run from the repository root.
// Exit 0: the lockfile passes. Exit 1: problems found, one line each on stdout. Exit 2: usage or read error.
// --offline skips the publish dates, which need the registry: npm only applies min-release-age
// when it resolves a version, so a version already in the lockfile is checked here (spike #16).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

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

const REGISTRY = 'https://registry.npmjs.org';
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;

const STRING_FIELDS = ['name', 'version', 'resolved', 'integrity'] as const;
const BOOLEAN_FIELDS = ['hasInstallScript', 'link'] as const;
const RECORD_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((v) => typeof v === 'string');

// The lockfile is untrusted input: check the shape of every field the guard reads.
export const parseLockfile = (text: string): Lockfile => {
  const data: unknown = JSON.parse(text.replace(/^﻿/, ''));
  if (!isObject(data) || data.lockfileVersion !== 3) {
    throw new Error('package-lock.json must have lockfileVersion 3');
  }
  if (!isObject(data.packages)) {
    throw new Error('package-lock.json has no packages');
  }
  for (const [key, entry] of Object.entries(data.packages)) {
    if (!isObject(entry)) throw new Error(`package-lock.json: ${key || '(root)'} is not an object`);
    const bad = [
      ...STRING_FIELDS.filter((f) => entry[f] !== undefined && typeof entry[f] !== 'string'),
      ...BOOLEAN_FIELDS.filter((f) => entry[f] !== undefined && typeof entry[f] !== 'boolean'),
      ...RECORD_FIELDS.filter((f) => entry[f] !== undefined && !isStringRecord(entry[f])),
    ];
    if (bad.length > 0) {
      throw new Error(`package-lock.json: ${key || '(root)'} has a malformed ${bad.join(', ')}`);
    }
  }
  return { packages: data.packages as Record<string, LockEntry> };
};

const section = (markdown: string, heading: string): string => {
  const start = markdown.indexOf(`## ${heading}`);
  if (start === -1) return '';
  const end = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, end === -1 ? undefined : end);
};

export const readPolicy = (dependenciesMd: string, npmrc: string): Policy => {
  const admitted = new Set(
    section(dependenciesMd, 'Admitted packages')
      .split(/\r?\n/)
      .flatMap((line) => /^\|\s*`([^`]+)`\s*\|/.exec(line)?.[1] ?? []),
  );
  const budget = /runtime\s*≤\s*(\d+),\s*total\s*≤\s*(\d+)/.exec(dependenciesMd);
  if (budget === null) {
    throw new Error('DEPENDENCIES.md states no package budget (runtime ≤ n, total ≤ m)');
  }
  const age = /^\s*min-release-age\s*=\s*(\d+)\s*$/m.exec(npmrc);
  if (age === null) throw new Error('.npmrc sets no min-release-age');
  return {
    runtimeBudget: Number(budget[1]),
    totalBudget: Number(budget[2]),
    admitted,
    minReleaseAgeDays: Number(age[1]),
  };
};

// The name of the package installed at a lockfile key; an alias records the real name.
const packageName = (key: string, entry: LockEntry): string =>
  entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);

const installed = (lock: Lockfile): Array<[string, LockEntry]> =>
  Object.entries(lock.packages).filter(([key]) => key !== '');

const entryProblems = (key: string, entry: LockEntry): string[] => {
  if (entry.link === true) return [`${key}: is a link, not a registry package`];
  const problems: string[] = [];
  if (entry.resolved?.startsWith(`${REGISTRY}/`) !== true) {
    problems.push(`${key}: resolved outside the npm registry (${entry.resolved ?? 'no URL'})`);
  }
  if (entry.integrity?.startsWith('sha512-') !== true) {
    problems.push(`${key}: no sha512 integrity`);
  }
  if (entry.hasInstallScript === true) {
    problems.push(`${key}: has an install script`);
  }
  return problems;
};

// The budget and the admission list count direct dependencies; DEPENDENCIES.md records each tree.
export const checkLockfile = (lock: Lockfile, policy: Policy): string[] => {
  const problems = installed(lock).flatMap(([key, entry]) => entryProblems(key, entry));
  const root = lock.packages[''] ?? {};
  const runtime = new Set(Object.keys({ ...root.dependencies, ...root.optionalDependencies }));
  const all = new Set([...runtime, ...Object.keys(root.devDependencies ?? {})]);
  for (const name of all) {
    if (!policy.admitted.has(name)) problems.push(`${name}: not listed in DEPENDENCIES.md`);
  }
  if (runtime.size > policy.runtimeBudget) {
    problems.push(`runtime packages: ${runtime.size}, budget ${policy.runtimeBudget}`);
  }
  if (all.size > policy.totalBudget) {
    problems.push(`total packages: ${all.size}, budget ${policy.totalBudget}`);
  }
  return problems;
};

const publishTimes = async (name: string, fetchFn: typeof fetch): Promise<unknown> => {
  const response = await fetchFn(`${REGISTRY}/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`registry answered ${response.status}`);
  const body: unknown = await response.json();
  return isObject(body) ? body.time : undefined;
};

const versionProblems = (
  name: string,
  versions: ReadonlySet<string>,
  time: unknown,
  { now, minReleaseAgeDays }: PublishDateOptions,
): string[] =>
  [...versions].flatMap((version) => {
    const stamp = isObject(time) ? time[version] : undefined;
    const published = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
    if (Number.isNaN(published)) return [`${name}@${version}: no publish date in the registry`];
    const eligible = published + minReleaseAgeDays * DAY_MS;
    if (eligible <= now.getTime()) return [];
    return [
      `${name}@${version}: published ${new Date(published).toISOString()}, less than ` +
        `${minReleaseAgeDays} days ago (allowed from ${new Date(eligible).toISOString()})`,
    ];
  });

export const checkPublishDates = async (
  lock: Lockfile,
  options: PublishDateOptions,
): Promise<string[]> => {
  const versionsByName = new Map<string, Set<string>>();
  for (const [key, entry] of installed(lock)) {
    if (entry.link === true || entry.version === undefined) continue;
    const name = packageName(key, entry);
    const versions = versionsByName.get(name) ?? new Set<string>();
    versions.add(entry.version);
    versionsByName.set(name, versions);
  }
  const results = await Promise.all(
    [...versionsByName].map(async ([name, versions]) => {
      try {
        return versionProblems(name, versions, await publishTimes(name, options.fetch), options);
      } catch (error) {
        return [`${name}: cannot read publish dates (${(error as Error).message})`];
      }
    }),
  );
  return results.flat();
};

const USAGE = 'usage: node scripts/check-deps.ts [--offline]\n';

const main = async (args: string[]): Promise<number> => {
  let offline: boolean;
  try {
    ({
      values: { offline },
    } = parseArgs({ args, options: { offline: { type: 'boolean', default: false } } }));
  } catch {
    process.stderr.write(USAGE);
    return 2;
  }
  let lock: Lockfile;
  let policy: Policy;
  try {
    const read = (file: string): string => readFileSync(join(process.cwd(), file), 'utf8');
    lock = parseLockfile(read('package-lock.json'));
    policy = readPolicy(read('DEPENDENCIES.md'), read('.npmrc'));
  } catch (error) {
    process.stderr.write(`check-deps: ${(error as Error).message}\n`);
    return 2;
  }
  const problems = checkLockfile(lock, policy);
  if (!offline) {
    problems.push(
      ...(await checkPublishDates(lock, {
        fetch,
        now: new Date(),
        minReleaseAgeDays: policy.minReleaseAgeDays,
      })),
    );
  }
  for (const problem of problems) process.stdout.write(`${problem}\n`);
  return problems.length > 0 ? 1 : 0;
};

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
