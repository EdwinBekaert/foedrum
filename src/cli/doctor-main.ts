// `foedrum doctor`'s facts on the real machine, from the checkout `cwd`: the wiring main.ts runs.

import { existsSync, readFileSync } from 'node:fs';
import { release } from 'node:os';
import { readBreweryFiles } from '../engine/brewery-files.ts';
import { resolveExecutable } from '../platform/executables.ts';
import { execProcess } from '../platform/processes.ts';
import type { DoctorFacts } from './doctor.ts';
import { type DoctorShell, gatherDoctorFacts } from './doctor-facts.ts';

/**
 * The facts doctor reports for the checkout `cwd`; they come through `exec` and `resolve`,
 * default the real runner and PATH, so a test gives fakes or a canned answer for gh's login.
 */
export const doctorFromCheckout = (
  cwd: string,
  options?: Partial<Pick<DoctorShell, 'exec' | 'resolve'>>,
): Promise<DoctorFacts> =>
  gatherDoctorFacts({
    exec: options?.exec ?? execProcess,
    resolve: options?.resolve ?? resolveExecutable,
    platform: process.platform,
    kernelRelease: release(),
    node: process.versions.node,
    execPath: process.execPath,
    cwd,
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
    readBrewery: () => readBreweryFiles(cwd),
  });
