// The commands of the command layer (ADR 0019): one schema each, the input its handler takes,
// whichever surface it came from. doctor, status and replay are read-only (ADR 0030).

import { PathSafeId } from './ids.ts';
import { z } from './zod.ts';

export const DoctorCommand = z.strictObject({ command: z.literal('doctor') });
export type DoctorCommand = z.infer<typeof DoctorCommand>;

export const StatusCommand = z.strictObject({ command: z.literal('status') });
export type StatusCommand = z.infer<typeof StatusCommand>;

export const ReplayCommand = z.strictObject({ command: z.literal('replay'), batch: PathSafeId });
export type ReplayCommand = z.infer<typeof ReplayCommand>;
