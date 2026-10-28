// `foedrum lenses` (ADR 0221): per lens, the findings of its steps' rounds by severity and by how
// they ended, and the tokens of its steps' attempts, from the folded events. A step's lens comes
// from the recipe its batch chose, as the files are now; a step they no longer have, or no longer
// give a lens, is listed apart when a round of it shows a Taster (a verdict, or recorded findings).

import { attemptKey } from '../engine/attempt-key.ts';
import { cutFindingText } from '../engine/decide.ts';
import type { Attempt, Batch, State } from '../engine/fold.ts';
import { lensRounds } from '../engine/lens-rounds.ts';
import type { Usage } from '../schemas/events.ts';
import { type Disposition, type TastingFinding, tastingOf } from '../schemas/out-doc.ts';
import { addUsage, byName, type LoadedBrewers, number, tokensLine } from './brewer-report.ts';

/** The lenses in use and what each recipe's step reviews through now, from the loaded files. */
export interface LensSource {
  /** Every lens a recipe's lens step reviews through, with its file. */
  lenses: readonly { name: string; path: string }[];
  /**
   * Step `stepId` of recipe `recipe` as the files have it, with the lens it reviews through when it
   * is a lens step, or its lenses together (ADR 0220), or `undefined` when no recipe of that name
   * has that step.
   */
  step: (
    recipe: string,
    stepId: string,
  ) => { lens: string | undefined; together?: readonly string[] } | undefined;
}

/** A lens's findings by their latest severity. */
export interface Severities {
  blocker: number;
  major: number;
  minor: number;
}

/** How a lens's findings ended: each in exactly one. */
export interface Ends {
  fixed: number;
  dismissed: number;
  'pre-existing': number;
  open: number;
}

/** What the rounds of some lens steps found and cost. */
export interface LensTally {
  /** The attempts that reviewed: a Taster's verdict, or blocked by findings. */
  rounds: number;
  /** Each finding once, by its latest severity. */
  severity: Severities;
  ends: Ends;
  /** Rounds blocked by findings no event recorded, and findings past the ones a round kept. */
  notRecorded: { rounds: number; findings: number };
  /** The sum of the finished attempts' usage. */
  usage: Usage;
}

/** The rounds and tokens of steps that run the same lenses together: tokens no lens's own (ADR 0220). */
export interface SharedTally {
  lenses: readonly string[];
  rounds: number;
  usage: Usage;
}

export interface LensReport {
  /** Every lens in use, by name, also those with no rounds. */
  lenses: readonly (LensTally & { name: string; path: string })[];
  /** The lens steps the recipe files no longer have, or no longer give a lens, by recipe and step. */
  gone: readonly (LensTally & { recipe: string; stepId: string })[];
  /** The steps of lenses together, by their lenses, in the order of their names. */
  shared: readonly SharedTally[];
}

const counts = (): LensTally => ({
  rounds: 0,
  severity: { blocker: 0, major: 0, minor: 0 },
  ends: { fixed: 0, dismissed: 0, 'pre-existing': 0, open: 0 },
  notRecorded: { rounds: 0, findings: 0 },
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

type Place = { file?: string | undefined; line?: number | undefined };
// A file as step.finished keeps a finding's, so a recorded finding meets the disposition written
// against the Taster's own out doc (ADR 0221).
const fileOf = ({ file }: Place): string | undefined =>
  file === undefined ? undefined : cutFindingText(file);
const samePlace = (a: Place, b: Place): boolean => fileOf(a) === fileOf(b) && a.line === b.line;

/** One finding of a lens step across its rounds: its latest severity, and its disposition once it has one. */
type Tracked = Place &
  Pick<TastingFinding, 'severity' | 'introduced'> & {
    end?: Disposition['disposition'];
  };

/**
 * The findings of a round and how many more it did not keep: a success's from its out doc, one
 * blocked by findings from its event, or `undefined` for one recorded before ADR 0221.
 */
const findingsOf = (
  ran: Extract<Attempt, { phase: 'finished' }>,
): { findings: readonly TastingFinding[]; more: number } | undefined => {
  if (ran.outcome.kind === 'succeeded') {
    return { findings: tastingOf(ran.outcome.output)?.findings ?? [], more: 0 };
  }
  return ran.findings === undefined
    ? undefined
    : { findings: ran.findings.kept, more: ran.findings.more };
};

/**
 * Where an attempt of a lens step counts: the tallies of the lenses it reviewed through, which each
 * of its rounds counts in, the tally a finding goes to, and the usage its tokens add to. A step of
 * lenses together gives each finding to the lens it names and its tokens to a shared row, never to a
 * lens (ADR 0220).
 */
interface Target {
  tallies: readonly LensTally[];
  of: (finding: TastingFinding) => LensTally | undefined;
  usage: Usage;
  shared?: SharedTally;
}

/**
 * Adds the rounds of `stepId` in `batch` to the tallies `targetOf` gives each attempt. Each finding
 * counts once (ADR 0221): one at the place of a finding still open is the same finding raised
 * again, with its latest severity; one at the place of a disposed finding is a contest of it
 * (ADR 0191), a new finding. A finding ends with the disposition paired to it as the next round is
 * told (`roundLines`: one per finding, by place, the first not taken), or pre-existing when the
 * Taster said it was there before the change, or open.
 */
const addRounds = (
  batch: Batch,
  stepId: string,
  targetOf: (attempt: number) => Target | undefined,
): void => {
  const tracked = new Map<LensTally, Tracked[]>();
  for (const { attempt, ran, dispositions } of lensRounds(batch, stepId)) {
    const target = targetOf(attempt);
    if (target === undefined) continue;
    if (target.shared !== undefined) target.shared.rounds += 1;
    const found = findingsOf(ran);
    for (const tally of target.tallies) {
      tally.rounds += 1;
      if (found === undefined) tally.notRecorded.rounds += 1;
      // Findings past the kept ones name no lens an event kept: each lens of the step counts them.
      else tally.notRecorded.findings += found.more;
    }
    if (found === undefined) continue;
    const raised = new Set<Tracked>();
    const left = [...dispositions];
    for (const finding of found.findings) {
      const { file, line, severity, introduced } = finding;
      const at = { file, line };
      const tally = target.of(finding);
      // A lens the files no longer give its step: whose it is now is unknown, so each lens counts
      // it as not recorded, and it still takes the disposition the next round paired with it.
      if (tally === undefined) {
        for (const each of target.tallies) each.notRecorded.findings += 1;
        const paired = left.findIndex((disposition) => samePlace(disposition, at));
        if (paired >= 0) left.splice(paired, 1);
        continue;
      }
      const known = tracked.get(tally) ?? [];
      tracked.set(tally, known);
      let same = known.find(
        (each) => !raised.has(each) && each.end === undefined && samePlace(each, at),
      );
      if (same === undefined) {
        same = { ...at, severity, introduced };
        known.push(same);
      } else {
        same.severity = severity;
        same.introduced = introduced;
      }
      raised.add(same);
      const paired = left.findIndex((disposition) => samePlace(disposition, at));
      const [disposed] = paired < 0 ? [] : left.splice(paired, 1);
      if (disposed !== undefined) same.end = disposed.disposition;
    }
  }
  for (const [tally, known] of tracked) {
    for (const { severity, introduced, end } of known) {
      tally.severity[severity] += 1;
      tally.ends[end ?? (introduced ? 'open' : 'pre-existing')] += 1;
    }
  }
};

/**
 * The report over `state`, each attempt under its recipe in `ran` (`recipesRun` of the events
 * `state` folds) and each step's lens from `source`.
 */
export const lensReport = (
  state: State,
  source: LensSource,
  ran: ReadonlyMap<string, string>,
): LensReport => {
  const lenses = new Map(source.lenses.map(({ name, path }) => [name, { ...counts(), path }]));
  const gone = new Map<string, LensTally & { recipe: string; stepId: string }>();
  const shared = new Map<string, SharedTally>();
  const lensTally = (lens: string): LensTally => {
    const found = lenses.get(lens) ?? { ...counts(), path: '' };
    lenses.set(lens, found);
    return found;
  };
  for (const batch of state.batches.values()) {
    // A batch has steps only once a recipe was chosen.
    const recipe = batch.recipe?.name;
    if (recipe === undefined) continue;
    for (const step of batch.steps.values()) {
      // A Taster's step: a round with its verdict, or blocked with the findings only a Taster
      // records. Any brewer may block on findings, so that alone makes no lens step.
      const tasted = lensRounds(batch, step.id).some(
        ({ ran }) => ran.outcome.kind === 'succeeded' || ran.findings !== undefined,
      );
      // Where an attempt counts: its lens's tally, its lenses' together, or, for a Taster's step,
      // its step's apart when the files no longer give it a lens; nowhere for no lens step.
      const targetOf = (attempt: number): Target | undefined => {
        const key = attemptKey.encode({ batchId: batch.id, stepId: step.id, attempt });
        const ranIn = ran.get(key) ?? recipe;
        const inFiles = source.step(ranIn, step.id);
        if (inFiles?.together !== undefined) {
          const names = inFiles.together;
          const byLens = new Map(names.map((name) => [name, lensTally(name)]));
          const row = shared.get(names.join(',')) ?? {
            lenses: names,
            rounds: 0,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
          shared.set(names.join(','), row);
          return {
            tallies: [...byLens.values()],
            of: (finding) => byLens.get(finding.lens ?? ''),
            usage: row.usage,
            shared: row,
          };
        }
        const one = (tally: LensTally): Target => ({
          tallies: [tally],
          of: () => tally,
          usage: tally.usage,
        });
        if (inFiles?.lens !== undefined) return one(lensTally(inFiles.lens));
        if (!tasted) return undefined;
        const apart = JSON.stringify([ranIn, step.id]);
        const found = gone.get(apart) ?? { ...counts(), recipe: ranIn, stepId: step.id };
        gone.set(apart, found);
        return one(found);
      };
      for (const attempt of step.attempts.values()) {
        if (attempt.phase !== 'finished') continue;
        const target = targetOf(attempt.attempt);
        if (target !== undefined) addUsage(target.usage, attempt.usage);
      }
      addRounds(batch, step.id, targetOf);
    }
  }
  return {
    lenses: [...lenses]
      .sort(([a], [b]) => byName(a, b))
      .map(([name, tally]) => ({ name, ...tally })),
    gone: [...gone.values()].sort(
      (a, b) => byName(a.recipe, b.recipe) || byName(a.stepId, b.stepId),
    ),
    shared: [...shared].sort(([a], [b]) => byName(a, b)).map(([, row]) => row),
  };
};

const counted = (n: number, one: string, many: string): string =>
  `${number(n)} ${n === 1 ? one : many}`;

/** The non-zero counts of `of`, in its order, each with its name. */
const nonZero = <K extends string>(of: Record<K, number>, names: readonly K[]): string =>
  names
    .filter((name) => of[name] > 0)
    .map((name) => `${number(of[name])} ${name}`)
    .join(', ');

// The rounds and their findings by severity, how those ended, what was not recorded, and the tokens.
const tallyLines = ({ rounds, severity, ends, notRecorded, usage }: LensTally): string[] => {
  if (rounds === 0) {
    const spent = Object.values(usage).some((count) => count > 0);
    return ['  no rounds', ...(spent ? [tokensLine(usage)] : [])];
  }
  const found = severity.blocker + severity.major + severity.minor;
  const unknown = [
    ...(notRecorded.rounds === 0 ? [] : [counted(notRecorded.rounds, 'round', 'rounds')]),
    ...(notRecorded.findings === 0 ? [] : [counted(notRecorded.findings, 'finding', 'findings')]),
  ];
  return [
    `  ${counted(rounds, 'round', 'rounds')}, ${
      found === 0
        ? 'no findings'
        : `${counted(found, 'finding', 'findings')}: ${nonZero(severity, ['blocker', 'major', 'minor'])}`
    }`,
    ...(found === 0
      ? []
      : [`  ended: ${nonZero(ends, ['fixed', 'dismissed', 'pre-existing', 'open'])}`]),
    ...(unknown.length === 0 ? [] : [`  not recorded: ${unknown.join(', ')}`]),
    tokensLine(usage),
  ];
};

/** What `foedrum lenses` prints. */
export const formatLensReport = ({ lenses, gone, shared }: LensReport): string => {
  if (lenses.length === 0 && gone.length === 0) return 'No lenses.\n';
  const lines = [
    ...lenses.flatMap((lens) => [`${lens.name}  ${lens.path}`, ...tallyLines(lens)]),
    ...(shared.length === 0
      ? []
      : [
          '',
          'Lenses together, their tokens not split (ADR 0220):',
          ...shared.flatMap(({ lenses: names, rounds, usage }) => [
            names.join(' + '),
            `  ${counted(rounds, 'round', 'rounds')}`,
            tokensLine(usage),
          ]),
        ]),
    ...(gone.length === 0
      ? []
      : [
          '',
          'Lens steps the recipe files no longer have (ADR 0059):',
          ...gone.flatMap((step) => [`${step.recipe}/${step.stepId}`, ...tallyLines(step)]),
        ]),
  ];
  return `${lines.join('\n')}\n`;
};

/** A step's lens, or its lenses together (ADR 0220). */
const together = (
  found: { lens?: string; together?: readonly string[] } | undefined,
): { lens: string | undefined; together?: readonly string[] } =>
  found?.together === undefined
    ? { lens: found?.lens }
    : { lens: undefined, together: found.together };

/** The lenses in use and each recipe's lens steps, from the loaded files. */
export const lensSource = ({ recipes, brewers, catalog }: LoadedBrewers): LensSource => ({
  lenses: catalog.lenses
    .filter(({ name }) => catalog.named.reviewLenses.has(name))
    .map(({ name, path }) => ({ name, path })),
  step: (recipe, stepId) =>
    recipes.find(recipe)?.has(stepId) === true ? together(brewers.find(recipe, stepId)) : undefined,
});
