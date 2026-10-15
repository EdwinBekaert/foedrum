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
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  os?: string[];
  cpu?: string[];
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
const BOOLEAN_FIELDS = ['hasInstallScript', 'link', 'dev', 'optional', 'devOptional'] as const;
const LIST_FIELDS = ['os', 'cpu'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

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
      ...LIST_FIELDS.filter((f) => entry[f] !== undefined && !isStringList(entry[f])),
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

// Strict, so a name or version can hold no '/', '..', '%', '?' or '#': with those, the expected
// URL could equal a resolved one that URL normalisation points at another package.
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// The tarball npm ci downloads must be the version the publish dates are checked for.
const tarballUrl = (name: string, version: string): string =>
  `${REGISTRY}/${name}/-/${name.slice(name.indexOf('/') + 1)}-${version}.tgz`;

const entryProblems = (key: string, entry: LockEntry): string[] => {
  if (entry.link === true) return [`${key}: is a link, not a registry package`];
  const problems: string[] = [];
  const name = packageName(key, entry);
  if (!PACKAGE_NAME.test(name)) {
    problems.push(`${key}: not a valid package name (${name})`);
  } else if (entry.version === undefined || !VERSION.test(entry.version)) {
    problems.push(`${key}: no valid version (${entry.version ?? 'none'})`);
  } else if (entry.resolved !== tarballUrl(name, entry.version)) {
    problems.push(
      `${key}: resolved ${entry.resolved ?? 'nowhere'}, not the npm registry tarball of ` +
        `${name}@${entry.version}`,
    );
  }
  if (entry.integrity?.startsWith('sha512-') !== true) {
    problems.push(`${key}: no sha512 integrity`);
  }
  if (entry.hasInstallScript === true) {
    problems.push(`${key}: has an install script`);
  }
  return problems;
};

// A prebuilt binary for one platform: npm installs only the one matching the machine.
const isPlatformBinary = (entry: LockEntry): boolean =>
  entry.optional === true && (entry.os !== undefined || entry.cpu !== undefined);

const isDev = (entry: LockEntry): boolean => entry.dev === true || entry.devOptional === true;

// The budget and the admission list cover the installed tree (ADR 0004: "about 7 packages in
// node_modules"), counting each package name once and leaving out platform binaries.
export const checkLockfile = (lock: Lockfile, policy: Policy): string[] => {
  const problems = installed(lock).flatMap(([key, entry]) => entryProblems(key, entry));
  const counted = installed(lock).filter(([, entry]) => !isPlatformBinary(entry));
  const all = new Set(counted.map(([key, entry]) => packageName(key, entry)));
  const runtime = new Set(
    counted.filter(([, entry]) => !isDev(entry)).map(([key, entry]) => packageName(key, entry)),
  );
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
    const name = packageName(key, entry);
    // checkLockfile reports these; never build a registry URL from them.
    if (entry.link === true || entry.version === undefined || !PACKAGE_NAME.test(name)) continue;
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

export interface RunDeps {
  cwd: string;
  fetch: typeof fetch;
  now: Date;
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE = 'usage: node scripts/check-deps.ts [--offline]\n';

export const run = async (args: string[], deps: RunDeps): Promise<number> => {
  let offline: boolean;
  try {
    ({
      values: { offline },
    } = parseArgs({ args, options: { offline: { type: 'boolean', default: false } } }));
  } catch {
    deps.err(USAGE);
    return 2;
  }
  let lock: Lockfile;
  let policy: Policy;
  try {
    const read = (file: string): string => readFileSync(join(deps.cwd, file), 'utf8');
    lock = parseLockfile(read('package-lock.json'));
    policy = readPolicy(read('DEPENDENCIES.md'), read('.npmrc'));
  } catch (error) {
    deps.err(`check-deps: ${(error as Error).message}\n`);
    return 2;
  }
  const problems = checkLockfile(lock, policy);
  if (!offline) {
    problems.push(
      ...(await checkPublishDates(lock, {
        fetch: deps.fetch,
        now: deps.now,
        minReleaseAgeDays: policy.minReleaseAgeDays,
      })),
    );
  }
  for (const problem of problems) deps.out(`${problem}\n`);
  return problems.length > 0 ? 1 : 0;
};

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), {
    cwd: process.cwd(),
    fetch,
    now: new Date(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
