// Events (architecture §4.1, ADR 0019). Stub: not implemented yet.

import { z } from './zod.ts';

export const SessionRef = z.never();
export const Surface = z.never();
export const StuckReason = z.never();
export type StuckReason = z.infer<typeof StuckReason>;
export const WaitCondition = z.never();
export type WaitCondition = z.infer<typeof WaitCondition>;
export const Event = z.never();
export type Event = z.infer<typeof Event>;
