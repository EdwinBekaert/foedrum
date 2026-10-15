// The canonical text of an attempt: the `attemptKey` of its lease (ADR 0027), so the supervisor can
// tell which attempt a lease holds.

import { PathSafeId } from '../schemas/ids.ts';
import { z } from '../schemas/zod.ts';

/** One attempt of a step of a batch. */
export interface AttemptRef {
  batchId: string;
  stepId: string;
  attempt: number;
}

const Parts = z.tuple([PathSafeId, PathSafeId, z.int().positive()]);

const encode = (ref: AttemptRef): string => {
  // Only the three parts: an attempt taken from a larger object may carry other fields.
  const parts = [ref.batchId, ref.stepId, ref.attempt];
  if (!Parts.safeParse(parts).success) {
    throw new Error(`Invalid attempt key: ${JSON.stringify(parts)}`);
  }
  return JSON.stringify(parts);
};

const decode = (text: string): AttemptRef | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parts = Parts.safeParse(json);
  // One attempt, one text: a lease under another spelling holds no attempt the engine knows.
  if (!parts.success || JSON.stringify(parts.data) !== text) return undefined;
  const [batchId, stepId, attempt] = parts.data;
  return { batchId, stepId, attempt };
};

export const attemptKey = {
  /** The JSON array `[batchId, stepId, attempt]`; throws when a part is invalid. */
  encode,
  /** The attempt of a canonical text, or `undefined` for any other text. */
  decode,
};
