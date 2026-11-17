// `foedrum doctor`'s facts on the real machine, from the checkout `cwd`: the wiring main.ts runs.

import { existsSync, readFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { readBreweryFiles } from '../engine/brewery-files.ts';
import { openSqliteEventStore } from '../engine/sqlite-event-store.ts';
import { modelsUsed } from '../engine/tasting-suggestions.ts';
import { readDenylist } from '../platform/denylist.ts';
import { resolveExecutable } from '../platform/executables.ts';
import { execProcess } from '../platform/processes.ts';
import { runGitWith } from '../workspace/git.ts';
import type { DoctorFacts, TastingFact } from './doctor.ts';
import { type DoctorShell, gatherDoctorFacts } from './doctor-facts.ts';
import { readDoctorMap } from './doctor-map.ts';
import { storePath } from './serve-config.ts';

/**
 * The models the Brewery's brewer attempts reported, read from its event log without creating or
 * changing one (ADR 0030, ADR 0419); none where it has no log yet.
 */
const readTasting = (cwd: string): TastingFact => {
  const at = new Date();
  const path = storePath(cwd);
  if (!existsSync(path)) return { used: [], at };
  const store = openSqliteEventStore(path, { readOnly: true });
  try {
    return { used: modelsUsed(store.eventsAfter(0).map(({ event }) => event)), at };
  } finally {
    store.close();
  }
};

/**
 * On Linux, whether AppArmor restricts unprivileged user namespaces, as
 * `sysctl kernel.apparmor_restrict_unprivileged_userns` reads it; undefined where the key is not
 * there or cannot be read (ADR 0076).
 */
const restrictsUserns = (platform: NodeJS.Platform): boolean | undefined => {
  if (platform !== 'linux') return undefined;
  try {
    const value = readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8');
    return value.trim() === '1';
  } catch {
    return undefined;
  }
};

/**
 * The facts doctor reports for the checkout `cwd`; they come through `exec` and `resolve`,
 * default the real runner and PATH, so a test gives fakes or a canned answer for gh's login, and
 * `denylist`, default the user's list (ADR 0114), which a test never reads.
 */
export const doctorFromCheckout = (
  cwd: string,
  options?: Partial<Pick<DoctorShell, 'exec' | 'resolve' | 'denylist' | 'restrictsUserns' | 'env'>>,
): Promise<DoctorFacts> =>
  gatherDoctorFacts({
    ...(options?.env === undefined ? {} : { env: options.env }),
    exec: options?.exec ?? execProcess,
    resolve: options?.resolve ?? resolveExecutable,
    platform: process.platform,
    kernelRelease: release(),
    node: process.versions.node,
    execPath: process.execPath,
    cwd,
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    readBrewery: () => readBreweryFiles(cwd),
    // The map's clones are read with git alone, at each repository's base (ADR 0317).
    systemMap: () =>
      readDoctorMap({
        git: runGitWith(options?.exec ?? execProcess),
        home: homedir(),
        cwd,
        readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
        exists: existsSync,
      }),
    tasting: () => readTasting(cwd),
    restrictsUserns: options?.restrictsUserns ?? (() => restrictsUserns(process.platform)),
    denylist:
      options?.denylist ??
      (() => readDenylist(process.env, homedir(), (path) => readFileSync(path, 'utf8'))),
  });
