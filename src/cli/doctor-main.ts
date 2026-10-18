// `foedrum doctor`'s facts on the real machine, from the checkout `cwd`: the wiring main.ts runs.

import type { DoctorFacts } from './doctor.ts';
import type { DoctorShell } from './doctor-facts.ts';

/**
 * The facts doctor reports for the checkout `cwd`; they come through `exec` and `resolve`,
 * default the real runner and PATH, so a test gives fakes or a canned answer for gh's login.
 */
export const doctorFromCheckout = async (
  _cwd: string,
  _options?: Partial<Pick<DoctorShell, 'exec' | 'resolve'>>,
): Promise<DoctorFacts> => {
  throw new Error('not implemented');
};
