// The event store's own records: effect keys (invariant I4) and leases (ADR 0002).

import { z } from './zod.ts';

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export const EffectKey = z.custom<{
  batchId: string;
  stepId: string;
  attempt: number;
  effect: string;
}>(notImplemented);
export type EffectKey = z.infer<typeof EffectKey>;

export const EffectKeyText = z.custom<string>(notImplemented);

export const Lease = z.custom<{ attemptKey: string; owner: string; expiresAt: Date }>(
  notImplemented,
);
export type Lease = z.infer<typeof Lease>;
