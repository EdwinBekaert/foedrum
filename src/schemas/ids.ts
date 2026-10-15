// Ids that become path segments on the state branch: batch and step ids (ADR 0024).

import { z } from './zod.ts';

// Lower case, so two ids never share a folder on a case-insensitive file system; a letter or
// digit at both ends, so no `.`, `..`, hidden or trailing-dot names (Windows drops a trailing
// dot); and no name Windows reserves for a device, with or without an extension. One regex, so
// the generated JSON Schema checks exactly what zod checks.
const segment =
  /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;

/** A batch or step id: one path segment on every operating system, at most 100 characters. */
export const PathSafeId = z
  .string()
  .regex(
    segment,
    'Must be 1 to 100 lower-case letters, digits, ".", "_" or "-", start and end with a letter or digit, and not be a Windows device name',
  );
