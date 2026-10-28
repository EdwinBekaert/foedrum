// The comments Foedrum keeps on a Brewery issue as revisions in the ledger, `[batchId,
// "<prefix>.<n>"]`, each found by its marker on the Brewery's own comment before it is applied
// (ADR 0033, ADR 0072): the status comment's and the plan comment's (ADR 0233).

import { StatusRevision } from '../schemas/status-comment.ts';
import type { BatchEffectKey } from '../schemas/store.ts';
import { commentId, effectMarker } from './claim-effects.ts';
import { effectKey, numberedEffects } from './effect-key.ts';
import type { EffectTarget } from './effects.ts';
import type { State } from './fold.ts';
import { digestOf } from './pull-request.ts';
import type { StatusComments } from './status-comment.ts';

/**
 * How long the text of a comment may be: below GitHub's 65,536 characters for a comment, with room
 * for its marker, and for a merge brief's title. Escaping can make each text a brewer wrote five
 * times as long, so the caps on those texts alone do not keep it there.
 */
export const longestComment = 60_000;

/** `text` cut to whole lines below `longestComment`, so no escape or entity is cut in half. */
export const cutForComment = (text: string): string => {
  if (text.length <= longestComment) return text;
  const note = '\n\n… the rest is cut: GitHub keeps comments shorter.';
  const kept = text.slice(0, longestComment - note.length);
  return `${kept.slice(0, kept.lastIndexOf('\n'))}${note}`;
};

/** A revision of a comment that is due. */
export interface DueRevision {
  key: BatchEffectKey;
  issue: number;
  text: string;
  digest: string;
  /** The revision the comment shows now; absent before its first. */
  previous?: StatusRevision;
}

/** The revisions of the comment whose effects are `<prefix>.<n>`, the `what` errors name. */
export const commentRevisions = (prefix: string, what: string) => {
  const keyOf = (batchId: string, revision: number): BatchEffectKey => ({
    batchId,
    effect: `${prefix}.${revision}`,
  });
  /** The latest revision of `batchId` recorded, if any, and the number of the next. */
  const latest = (
    state: State,
    batchId: string,
  ): { next: number; latest: StatusRevision | undefined } => {
    const revisions = numberedEffects(
      state,
      (n) => keyOf(batchId, n),
      StatusRevision,
      `a ${what}'s revision`,
    );
    return { next: revisions.length + 1, latest: revisions.at(-1) };
  };
  /**
   * The target that applies the revisions `due` registers, on `brewery`'s issues: an edit of the
   * comment the previous revision made, or a new comment before the first or once that one is
   * gone; `done` hears of each revision it applied or found.
   */
  const effects = (
    brewery: string,
    comments: StatusComments,
    done: (due: DueRevision) => void = () => undefined,
  ): { due: (due: DueRevision) => BatchEffectKey; target: EffectTarget } => {
    // The revision behind each key `due` gave; the driver asks `due` before it applies a key.
    const revisions = new Map<string, DueRevision>();
    const revisionFor = (key: string): DueRevision => {
      const due = revisions.get(key);
      if (due === undefined) throw new Error(`No ${what} revision ${key} is due`);
      return due;
    };
    const applied = (due: DueRevision, comment: number, digest: string): StatusRevision => {
      // Checked: the id comes from the code host, and the ledger keeps it.
      const result = StatusRevision.parse({ comment: commentId(comment), digest });
      done(due);
      return result;
    };
    // The comment that already shows the revision of `key`, by the text before its marker.
    const shown = (due: DueRevision, comment: number, body: string, marker: string) => ({
      result: applied(due, comment, digestOf(body.slice(0, -marker.length).trimEnd())),
    });
    const target: EffectTarget = {
      find: async (key, signal) => {
        const due = revisionFor(key);
        const marker = effectMarker(key);
        if (due.previous !== undefined) {
          const body = await comments.read(brewery, due.previous.comment, signal);
          // Still there: a run before would have edited it, not made another.
          if (body !== undefined) {
            return body.endsWith(marker)
              ? shown(due, due.previous.comment, body, marker)
              : undefined;
          }
        }
        const found = await comments.find(brewery, due.issue, marker, signal);
        return found === undefined ? undefined : shown(due, found.id, found.body, marker);
      },
      apply: async (key, signal) => {
        const due = revisionFor(key);
        const body = `${due.text}\n\n${effectMarker(key)}`;
        if (due.previous !== undefined) {
          const edited = await comments.edit(brewery, due.previous.comment, body, signal);
          if (edited === 'edited') return applied(due, due.previous.comment, due.digest);
        }
        // The first revision, or the comment was deleted by hand: it is made again.
        return applied(due, await comments.create(brewery, due.issue, body, signal), due.digest);
      },
    };
    return {
      due: (due) => {
        revisions.set(effectKey.encode(due.key), due);
        return due.key;
      },
      target,
    };
  };
  return { keyOf, latest, effects };
};
