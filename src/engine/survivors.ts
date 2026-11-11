// Brett's confirmed survivors as the status comment, the pull request and the merge brief list
// them, and as a blocking Brett step's findings (ADR 0319): each on one line, with its edit as a
// one-line diff, and a count of the other verdicts.

import type { MutantRecord, MutantVerdict } from '../schemas/events.ts';
import type { TastingFinding } from '../schemas/out-doc.ts';

/** The mutants the tests let survive, in Brett's order. */
export const survivorsOf = (mutants: readonly MutantRecord[] = []): MutantRecord[] =>
  mutants.filter(({ verdict }) => verdict.kind === 'survived');

type Told = (text: string) => string;

/** A survivor's edit as a one-line diff, and the bug it plants; a record from before ADR 0319 has no edit. */
const plantedText = (
  { original, replacement, description }: MutantRecord,
  told: Told = (text) => text,
): string =>
  [
    ...(original === undefined ? [] : [`- ${told(original)} / + ${told(replacement ?? '')}`]),
    told(description),
  ].join(': ');

/** A survivor where it is, its edit and the bug it plants, each text told by `told`. */
export const survivorText = (survivor: MutantRecord, told: Told = (text) => text): string =>
  `${told(survivor.file)}:${survivor.line}: ${plantedText(survivor, told)}`;

const verdictWords: Readonly<Record<MutantVerdict['kind'], string>> = {
  survived: 'survived',
  killed: 'killed',
  timedOut: 'timed out',
  invalid: 'invalid',
  notJudged: 'not judged',
};

/** How many mutants there were, and had each verdict, those none had left out: `2 mutants: 1 survived, 1 killed`. */
const mutantCounts = (mutants: readonly MutantRecord[]): string => {
  const counts = Object.entries(verdictWords).flatMap(([kind, words]) => {
    const count = mutants.filter(({ verdict }) => verdict.kind === kind).length;
    return count === 0 ? [] : [`${count} ${words}`];
  });
  return `${mutants.length} mutant${mutants.length === 1 ? '' : 's'}: ${counts.join(', ')}`;
};

/**
 * A step's mutants as report lines: each survivor with its edit, then the count by verdict; none
 * for a step without mutants.
 */
export const mutantLines = (mutants: readonly MutantRecord[], told: Told): string[] =>
  mutants.length === 0
    ? []
    : [
        ...survivorsOf(mutants).map((survivor) => `survived: ${survivorText(survivor, told)}`),
        mutantCounts(mutants),
      ];

/**
 * A survivor as a blocking Brett step's finding (ADR 0319): on a line the change added, so
 * introduced, and major, as a gap in the change's tests holds a blocking step up.
 */
export const survivorFinding = (survivor: MutantRecord): TastingFinding => ({
  point: 'The tests miss a bug planted on this line: add a test that catches it.',
  file: survivor.file,
  line: survivor.line,
  severity: 'major',
  why: `the tests let a mutant survive: ${plantedText(survivor)}`,
  introduced: true,
});
