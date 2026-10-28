// The event store's own records: effect keys (invariant I4), leases (ADR 0002), the state branch's
// pushed-through marker (ADR 0024), and the commit sha they and the events share.

import { PathSafeId } from './ids.ts';
import { z } from './zod.ts';

const Filled = z.string().min(1);
const Attempt = z.int().positive();

/** The key of an effect of an attempt. */
export const AttemptEffectKey = z.strictObject({
  batchId: PathSafeId,
  stepId: PathSafeId,
  attempt: Attempt,
  effect: Filled,
});
export type AttemptEffectKey = z.infer<typeof AttemptEffectKey>;

/** The key of an effect of a batch rather than one of its attempts (ADR 0043). */
export const BatchEffectKey = z.strictObject({ batchId: PathSafeId, effect: Filled });
export type BatchEffectKey = z.infer<typeof BatchEffectKey>;

/** The key of an external side effect: applied at most once (invariant I4). */
export const EffectKey = z.union([AttemptEffectKey, BatchEffectKey]);
export type EffectKey = z.infer<typeof EffectKey>;

/** The parts of an effect key in the order of its text: an attempt's four, or a batch's two. */
export const EffectKeyParts = z.union([
  z.tuple([PathSafeId, PathSafeId, Attempt, Filled]),
  z.tuple([PathSafeId, Filled]),
]);

/** The parts of an attempt key, the `attemptKey` of a lease, in the order of its text (ADR 0027). */
export const AttemptKeyParts = z.tuple([PathSafeId, PathSafeId, Attempt]);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// The shape of a canonical text, so the generated JSON Schema rejects most other texts too; the
// refinement is the exact check. Every canonical text matches its shape.
const jsonString = String.raw`"(?:[^"\\]|\\.)+"`;
const attemptNumber = '[1-9][0-9]*';

/** Text written exactly as `JSON.stringify` writes valid `parts`, so each key has one text only. */
const canonicalText = (parts: z.ZodType, shape: RegExp, message: string) =>
  z
    .string()
    .regex(shape, message)
    .refine((text) => {
      const parsed = parts.safeParse(parseJson(text));
      // One key, one text: otherwise two spellings of a key would both pass the UNIQUE index.
      return parsed.success && JSON.stringify(parsed.data) === text;
    }, message);

/**
 * The canonical text of an effect key: the JSON array `[batchId, stepId, attempt, effect]`, or
 * `[batchId, effect]` for an effect of a batch (ADR 0043), so no part can collide with a
 * separator, written exactly as `JSON.stringify` writes it.
 */
export const EffectKeyText = canonicalText(
  EffectKeyParts,
  new RegExp(String.raw`^\[${jsonString},(?:${jsonString},${attemptNumber},)?${jsonString}\]$`),
  'Must be a canonical effect key: ["batchId","stepId",attempt,"effect"] or ["batchId","effect"]',
);

/**
 * The canonical text of an attempt key, the `attemptKey` of a lease: the JSON array
 * `[batchId, stepId, attempt]`, the only text the supervisor can match to an attempt (ADR 0027).
 */
export const AttemptKeyText = canonicalText(
  AttemptKeyParts,
  new RegExp(String.raw`^\[${jsonString},${jsonString},${attemptNumber}\]$`),
  'Must be a canonical attempt key: ["batchId","stepId",attempt]',
);

// A full commit id: 40 lowercase hex characters, a SHA-1 id. Foedrum supports SHA-1 repositories
// (ADR 0254); a 64-character SHA-256 id is refused where it enters.
const COMMIT_ID = /^[0-9a-f]{40}$/;
const SHA256_ID = /^[0-9a-f]{64}$/;

/** Whether `text` is a full commit id, the one check `CommitSha` and every git reader use. */
export const isCommitSha = (text: string): boolean => COMMIT_ID.test(text);

/**
 * Why `text` is no full commit id: a SHA-256 one is named as not supported (ADR 0254), any other
 * gets `otherwise`.
 */
export const noCommitSha = (text: string, otherwise = `${text} is no full commit sha`): string =>
  SHA256_ID.test(text)
    ? `${text} is a SHA-256 commit id: Foedrum supports SHA-1 repositories only`
    : otherwise;

/** A full commit id (ADR 0254). */
export const CommitSha = z
  .string()
  .regex(
    COMMIT_ID,
    'Must be a full commit sha: 40 lowercase hex characters (SHA-1 repositories only)',
  );

/** The most findings the ledger keeps of one refused push (ADR 0079). */
export const MAX_REFUSED = 50;

/**
 * What the secret scan found in a batch's commits (ADR 0079): the commit, the place (the file's
 * path as git shows it, `message`, or why neither can be named) and the kind, never the text.
 */
export const ScanFinding = z.strictObject({ commit: CommitSha, place: Filled, kind: Filled });
export type ScanFinding = z.infer<typeof ScanFinding>;

/** The most sensitive files the ledger names of one push (ADR 0201). */
export const MAX_SENSITIVE = 50;

/**
 * The files of a batch's change that match its repository's sensitive paths (ADR 0201): how many,
 * and the first `MAX_SENSITIVE` of them as git named them.
 */
export const SensitiveFiles = z.strictObject({
  count: z.int().min(1),
  files: z.array(Filled).min(1).max(MAX_SENSITIVE),
});
export type SensitiveFiles = z.infer<typeof SensitiveFiles>;

/**
 * The result the ledger keeps for the push of the openPullRequest action (ADR 0071): the branch,
 * the commit pushed, the revision it was resolved from, and whether the base already holds every
 * commit of it, so nothing was pushed; or what the secret scan found, so nothing was pushed either
 * (ADR 0079): each commit, place and kind, never the text. A push that went keeps the sensitive
 * files its change touches, when there are any (ADR 0201). A later round's push that found the
 * branch at another commit than the round before pushed (`moved`), or gone (`gone`), pushed nothing
 * (ADR 0219).
 */
export const PushResult = z.strictObject({
  branch: Filled,
  commit: CommitSha,
  from: Filled,
  empty: z.literal(true).optional(),
  refused: z.array(ScanFinding).min(1).max(MAX_REFUSED).optional(),
  sensitive: SensitiveFiles.optional(),
  moved: CommitSha.optional(),
  gone: z.literal(true).optional(),
});
export type PushResult = z.infer<typeof PushResult>;

/**
 * The result the ledger keeps for a later round's body of the openPullRequest action (ADR 0227):
 * the digest of the body it wrote, the first 16 hex digits of its SHA-256, or why it left the
 * body as it was: a person or a bot edited it, or it carries no marker of the batch.
 */
export const BodyResult = z.union([
  z.strictObject({ digest: z.string().regex(/^[0-9a-f]{16}$/) }),
  z.strictObject({ left: z.enum(['edited', 'unmarked']) }),
]);
export type BodyResult = z.infer<typeof BodyResult>;

/** The most files the ledger names of one merge of the base that conflicts (ADR 0164). */
export const MAX_CONFLICTS = 50;

/**
 * A file a merge left unmerged, as `git status` names it (ADR 0244): its status, and whether it
 * holds no conflict marker, as a binary file or one a side deleted does not.
 */
export const KeptFile = z.strictObject({
  path: Filled,
  status: z.enum([
    'both modified',
    'both added',
    'both deleted',
    'added by us',
    'added by them',
    'deleted by us',
    'deleted by them',
  ]),
  unmarked: z.literal(true).optional(),
});
export type KeptFile = z.infer<typeof KeptFile>;

/**
 * The result the ledger keeps for the merge of the base into a batch's last check attempt before
 * its pull request (ADR 0164): the base's commit as fetched, and the merge commit made, or the
 * files the merge conflicts in, so it was aborted; neither when the base had nothing new. A merge
 * at the start of a routed fix keeps its conflicts in progress for the brewer (`kept`, ADR 0244):
 * the files still unmerged, at most `MAX_CONFLICTS`, and how many more.
 */
export const MergeResult = z
  .strictObject({
    base: CommitSha,
    merged: CommitSha.optional(),
    conflicts: z.array(Filled).min(1).max(MAX_CONFLICTS).optional(),
    kept: z
      .strictObject({
        files: z.array(KeptFile).max(MAX_CONFLICTS),
        more: z.int().nonnegative(),
      })
      .optional(),
  })
  .refine(
    (result) =>
      [result.merged, result.conflicts, result.kept].filter((one) => one !== undefined).length <= 1,
    { message: 'A merge made a commit, conflicts, or keeps its conflicts, never two of them' },
  );
export type MergeResult = z.infer<typeof MergeResult>;

/**
 * How far the state branch has the log (ADR 0024): every event up to `eventId` is on the remote
 * branch, in `commit`. Kept in the store, never in the log, so it has no JSON Schema file.
 */
export const PushedThrough = z.strictObject({ eventId: z.int().nonnegative(), commit: CommitSha });
export type PushedThrough = z.infer<typeof PushedThrough>;

/**
 * Which driver drives a batch until when (ADR 0019): alive while `expiresAt` is in the future. The
 * owner is the driver's lock owner (ADR 0037). Kept in the store's batch leases table, never in the
 * log, so it has no JSON Schema file.
 */
export const BatchLease = z.strictObject({
  batchId: PathSafeId,
  owner: PathSafeId,
  expiresAt: z.date(),
});
export type BatchLease = z.infer<typeof BatchLease>;

/**
 * Who holds an attempt (and its session) until when; alive while `expiresAt` is in the future.
 * Kept in the store's leases table, never in the log, so it has no JSON Schema file.
 */
export const Lease = z.strictObject({
  attemptKey: AttemptKeyText,
  owner: Filled,
  expiresAt: z.date(),
});
export type Lease = z.infer<typeof Lease>;

/**
 * The text of an attempt's out doc, kept in the store from the attempt's end until a flush puts it
 * on the state branch at `outDocPath` (ADR 0103). Model output: stored, never followed. Kept in the
 * store's out docs table, never in the log, so it has no JSON Schema file.
 */
export const KeptOutDoc = z.strictObject({
  batchId: PathSafeId,
  stepId: PathSafeId,
  attempt: Attempt,
  text: z.string(),
});
export type KeptOutDoc = z.infer<typeof KeptOutDoc>;
