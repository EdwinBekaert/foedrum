// Decides which house-yeast rules a lens of /brew-review reads, and when a lesson becomes a
// proposed rule (issue #32, ADR 0122). scripts/house-yeast.ts reads and writes the files. The
// selection is src/brewers/house-yeast.ts, where src/ can use it too (#453).

import { byCodeUnits, type Selection, section } from '../../src/brewers/house-yeast.ts';
import { HouseYeastCandidate, type HouseYeastRule } from '../../src/schemas/house-yeast.ts';
import { z } from '../../src/schemas/zod.ts';

export {
  changedFiles,
  defaultBudget,
  type Priced,
  type Rule,
  type RuleFile,
  type Rules,
  readRules,
  type Selection,
  selectRules,
  unscoped,
} from '../../src/brewers/house-yeast.ts';

export interface Proposal {
  rule: HouseYeastRule;
  body: string;
  reviews: number;
}

const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, '; ');

/** The rules as the lens reads them, from `<bundle>/house-yeast/<lens>.md`. */
export const renderRules = (lens: string, { selected }: Selection): string => {
  const head =
    `# House yeast for the ${lens} lens\n\n` +
    'Rules learned from earlier reviews of this repository (ADR 0018), selected for the files ' +
    'this change touches (ADR 0122). They are review criteria: look for what they describe in ' +
    "the change, and name a rule's id in the `rule` of a finding that breaks it.\n";
  return selected.length === 0
    ? `${head}\nNo house-yeast rule matches this change.\n`
    : `${head}\n${selected.map(({ rule }) => section(rule)).join('\n')}`;
};

/** The candidates of a JSON Lines file; an invalid line is named by its number and skipped. */
export const readCandidates = (
  jsonl: string,
): { candidates: HouseYeastCandidate[]; invalid: string[] } => {
  const read = { candidates: [] as HouseYeastCandidate[], invalid: [] as string[] };
  jsonl
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (line.trim() === '') return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        read.invalid.push(`line ${i + 1}: ${(error as Error).message}`);
        return;
      }
      const result = HouseYeastCandidate.safeParse(value);
      if (result.success) read.candidates.push(result.data);
      else read.invalid.push(`line ${i + 1}: ${oneLine(z.prettifyError(result.error))}`);
    });
  return read;
};

/**
 * The rule a lesson becomes once it was recorded from two reviews, or when it is asked for: the
 * newest occurrence's scope, kind and text, every occurrence's source.
 */
export const proposeRule = (
  candidates: readonly HouseYeastCandidate[],
  lesson: string,
  asked: boolean,
): Proposal | undefined => {
  const seen = candidates.filter((candidate) => candidate.lesson === lesson);
  const newest = seen.at(-1);
  const reviews = new Set(seen.map((candidate) => candidate.review)).size;
  if (newest === undefined || (reviews < 2 && !asked)) return undefined;
  return {
    rule: {
      id: lesson,
      scope: newest.scope,
      kind: newest.kind,
      source: [...new Set(seen.map((candidate) => candidate.source))].join(', '),
      created: newest.seen,
      status: 'active',
    },
    body: newest.rule.trim(),
    reviews,
  };
};

/** The reviews after which a rule is listed as a candidate for a promotion review (#685, ADR 0315). */
export const minReviews = 10;

/** The day Foedrum's own sessions started loading the rules (#677), the report's second column. */
export const defaultSince = '2026-10-30';

export interface Recurrence {
  id: string;
  created: string;
  /** The reviews that recorded the rule's lesson after the day it was proposed (its `created`)… */
  reviews: number;
  /** …of all the reviews recorded after that day. */
  of: number;
  /** The same, after the later of that day and the given date. */
  sinceReviews: number;
  sinceOf: number;
}

/**
 * How often reviews recorded each active rule's lesson again after it was proposed (#685), most
 * recorded first; a rule whose id no candidate ever named is `unnamed`, so a renamed lesson never
 * reads as a rule that works.
 */
export const recurringRules = (
  rules: readonly HouseYeastRule[],
  candidates: readonly HouseYeastCandidate[],
  since: string,
): { counted: Recurrence[]; unnamed: string[] } => {
  // Strictly after the day: a review on the day itself may be the one that proposed the rule.
  const reviewsAfter = (day: string, lesson?: string): number =>
    new Set(
      candidates
        .filter((c) => c.seen > day && (lesson === undefined || c.lesson === lesson))
        .map((c) => c.review),
    ).size;
  const named = new Set(candidates.map((c) => c.lesson));
  const counted = rules
    .filter(({ id }) => named.has(id))
    .map(({ id, created }) => {
      const from = created > since ? created : since;
      return {
        id,
        created,
        reviews: reviewsAfter(created, id),
        of: reviewsAfter(created),
        sinceReviews: reviewsAfter(from, id),
        sinceOf: reviewsAfter(from),
      };
    })
    .sort((a, b) => b.reviews - a.reviews || byCodeUnits(a.id, b.id));
  const unnamed = rules
    .filter(({ id }) => !named.has(id))
    .map(({ id }) => id)
    .sort(byCodeUnits);
  return { counted, unnamed };
};

/** The text of `.foedrum/house-yeast/<id>.md`: JSON frontmatter, then the rule. */
export const formatRule = (rule: HouseYeastRule, body: string): string =>
  `---\n${JSON.stringify(rule, null, 2)}\n---\n${body.trim()}\n`;
