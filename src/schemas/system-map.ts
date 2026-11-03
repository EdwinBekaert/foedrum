// A repository's entry in the system map (ADR 0317): what its manifests at one base commit say it
// publishes and depends on, its test map's modules, and each manifest that could not be read. Every
// value is repository text, cut to a line and a length before it is recorded.

import { z } from './zod.ts';

/** The longest name, version, URL or path an entry keeps. */
export const MAX_MAP_NAME_LENGTH = 120;
/** The most manifests, dependencies, packages, modules or unread manifests an entry keeps of each. */
export const MAX_MAP_ITEMS = 200;

const Name = z
  .string()
  .min(1)
  .max(MAX_MAP_NAME_LENGTH)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u, 'Must be one line');
// A reader's ecosystem (`npm`, `.NET`), never a list here: a new reader adds no value to it.
const Ecosystem = Name;

export const MapDependencyVia = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('package'), version: Name.optional() }),
  z.strictObject({ kind: z.literal('git'), url: Name, ref: Name.optional() }),
  z.strictObject({ kind: z.literal('project'), path: Name }),
]);

export const SystemMapEntry = z.strictObject({
  /** Each manifest a reader matched, with its reader's ecosystem: the repository's languages. */
  manifests: z
    .array(z.strictObject({ path: Name, ecosystem: Ecosystem }))
    .max(MAX_MAP_ITEMS)
    .optional(),
  publishes: z.array(z.strictObject({ name: Name, ecosystem: Ecosystem })).max(MAX_MAP_ITEMS),
  dependsOn: z
    .array(z.strictObject({ name: Name, ecosystem: Ecosystem, via: MapDependencyVia }))
    .max(MAX_MAP_ITEMS),
  modules: z.array(Name).max(MAX_MAP_ITEMS),
  unreadable: z.array(z.strictObject({ path: Name, reason: Name })).max(MAX_MAP_ITEMS),
  /** How many items the limits above left out, when they left any. */
  left: z.int().positive().optional(),
});
export type SystemMapEntry = z.infer<typeof SystemMapEntry>;
