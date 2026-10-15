// The event store's own records: effect keys (invariant I4), leases (ADR 0002), the state branch's
// pushed-through marker (ADR 0024), and the commit sha they and the events share.

import { PathSafeId } from './ids.ts';
import { z } from './zod.ts';

const Filled = z.string().min(1);
const Attempt = z.int().positive();

/** The key of an external side effect: applied at most once (invariant I4). */
export const EffectKey = z.strictObject({
  batchId: PathSafeId,
  stepId: PathSafeId,
  attempt: Attempt,
  effect: Filled,
});
export type EffectKey = z.infer<typeof EffectKey>;

/** The parts of an effect key in the order of its text. */
export const EffectKeyParts = z.tuple([PathSafeId, PathSafeId, Attempt, Filled]);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// The shape of the canonical text, so the generated JSON Schema rejects most other texts too; the
// refinement below is the exact check. Every canonical text matches it.
const jsonString = String.raw`"(?:[^"\\]|\\.)+"`;
const shape = new RegExp(String.raw`^\[${jsonString},${jsonString},[1-9][0-9]*,${jsonString}\]$`);
const message = 'Must be a canonical effect key: ["batchId","stepId",attempt,"effect"]';

/**
 * The canonical text of an effect key: the JSON array `[batchId, stepId, attempt, effect]`, so no
 * part can collide with a separator, written exactly as `JSON.stringify` writes it.
 */
export const EffectKeyText = z
  .string()
  .regex(shape, message)
  .refine((text) => {
    const parts = EffectKeyParts.safeParse(parseJson(text));
    // One key, one text: otherwise two spellings of a key would both pass the UNIQUE index.
    return parts.success && JSON.stringify(parts.data) === text;
  }, message);

/** A full commit hash (SHA-1 or SHA-256). */
export const CommitSha = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'Must be a full commit sha');

/**
 * How far the state branch has the log (ADR 0024): every event up to `eventId` is on the remote
 * branch, in `commit`. Kept in the store, never in the log, so it has no JSON Schema file.
 */
export const PushedThrough = z.strictObject({ eventId: z.int().nonnegative(), commit: CommitSha });
export type PushedThrough = z.infer<typeof PushedThrough>;

/**
 * Who holds an attempt (and its session) until when; alive while `expiresAt` is in the future.
 * Kept in the store's leases table, never in the log, so it has no JSON Schema file.
 */
export const Lease = z.strictObject({
  attemptKey: Filled,
  owner: Filled,
  expiresAt: z.date(),
});
export type Lease = z.infer<typeof Lease>;
