// A brewer's handover (ADR 0340): what it learned, a proposal a person reads, which no later prompt
// holds. The out doc's field stays out of `output`, so no reader of `output` can pass it on, and out
// of the out doc as a later prompt reads it. Pure.

import { parseFrontmatter } from '../formats/frontmatter.ts';
import { MAX_HANDOVER_LINE, MOST_HANDOVER_LINES, withinLimit } from '../schemas/out-doc.ts';
import type { Batch } from './fold.ts';
import { withoutSecrets } from './out-doc-text.ts';

/** One handover line, by the attempt that wrote it. */
export interface Handover {
  stepId: string;
  attempt: number;
  text: string;
}

/** A count of handover lines, as a person reads it. */
export const handoverLines = (n: number): string => `${n} handover line${n === 1 ? '' : 's'}`;

const frontmatterOf = (text: string) => {
  try {
    return parseFrontmatter(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

/**
 * The lines of an out doc's handover, as `step.finished` records them: the first three that say
 * anything, each one line, cut past its limit (ADR 0337) and read for a secret. Anything else in the
 * field reads as none, and so does a frontmatter that does not parse.
 */
export const handoverOf = (outDoc: string, stepId: string): string[] => {
  const handover = frontmatterOf(outDoc)?.data.handover;
  if (!Array.isArray(handover)) return [];
  return handover
    .flatMap((line) => (typeof line === 'string' ? [line.replace(/\s+/g, ' ').trim()] : []))
    .filter((line) => line !== '')
    .slice(0, MOST_HANDOVER_LINES)
    .map((line) =>
      withoutSecrets(withinLimit(line, MAX_HANDOVER_LINE, 'handover'), stepId, () => false),
    );
};

/** Why an out doc that opens a frontmatter cannot be given to a later prompt. */
export const UNREADABLE_FRONTMATTER = 'its frontmatter does not read';

/**
 * An out doc's text as a later prompt reads it: without its handover, by the reader's own parse, so
 * no spelling of the key gets past. With no handover it is the same text, byte for byte. A text
 * with no frontmatter has no field. One that opens a frontmatter this cannot read is refused,
 * rather than passed on with the field in it: it passed the reader when its attempt ended, so only
 * a changed file comes here.
 */
export const withoutHandover = (text: string): string => {
  if (!/^﻿?---(?:\r?\n|$)/.test(text)) return text;
  const doc = frontmatterOf(text);
  if (doc === undefined) throw new Error(UNREADABLE_FRONTMATTER);
  if (!('handover' in doc.data)) return text;
  const { handover: _, ...rest } = doc.data;
  return `---\n${JSON.stringify(rest)}\n---\n${doc.body}`;
};

/**
 * Every handover line of `batch`, in the order its steps were first scheduled. A line a later
 * attempt of its step left as it was, as a session resumed after a turn overrun does, is listed
 * once, under the attempt that wrote it.
 */
export const handoversOf = (batch: Batch): Handover[] =>
  [...batch.steps.values()].flatMap(({ id: stepId, attempts }) => {
    const seen = new Set<string>();
    return [...attempts.values()].flatMap((attempt) =>
      attempt.phase !== 'finished'
        ? []
        : (attempt.handover ?? []).flatMap((text) => {
            if (seen.has(text)) return [];
            seen.add(text);
            return [{ stepId, attempt: attempt.attempt, text }];
          }),
    );
  });
