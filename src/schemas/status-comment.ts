// What a revision of a status comment records in the ledger (ADR 0072): the comment it made or
// edited, and the digest of the text it showed. Never the text: the ledger is kept for good. And
// what a merge brief records (ADR 0225): its comment and the record of the checks it was posted for.

import { PullRequestUrl } from './events.ts';
import { CommitSha } from './store.ts';
import { z } from './zod.ts';

/** The first 16 hex digits of a SHA-256. */
const Digest = z.string().regex(/^[0-9a-f]{16}$/);

export const StatusRevision = z.strictObject({
  comment: z.int().positive(),
  /** The first 16 hex digits of the SHA-256 of the text. */
  digest: Digest,
});
export type StatusRevision = z.infer<typeof StatusRevision>;

/**
 * A merge brief posted on a pull request (ADR 0225): its comment, and the record it was posted for,
 * the pull request, its head and the first 16 hex digits of the SHA-256 of the record's checks.
 */
export const MergeBrief = z.strictObject({
  comment: z.int().positive(),
  pullRequest: PullRequestUrl,
  head: CommitSha,
  digest: Digest,
});
export type MergeBrief = z.infer<typeof MergeBrief>;

/**
 * A merge brief hidden as outdated (ADR 0229): its comment, hidden as GitHub's `OUTDATED`, or gone
 * when it was not there to hide.
 */
export const MergeBriefHidden = z.union([
  z.strictObject({ comment: z.int().positive(), hidden: z.literal('outdated') }),
  z.strictObject({ comment: z.int().positive(), gone: z.literal(true) }),
]);
export type MergeBriefHidden = z.infer<typeof MergeBriefHidden>;
