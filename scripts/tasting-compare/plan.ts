// The decisions of node scripts/tasting-compare.ts --plan (#804, ADR 0323): the setups and their
// recipes, the seeded plan and its key, how a run's Taster attempts are scored against it, and the
// one table, on the diff mode's sums and rule (core.ts). Nothing here starts a process.

import type { Event } from '../../src/schemas/events.ts';
import type { TastingFinding } from '../../src/schemas/out-doc.ts';
import { PlanOutDoc } from '../../src/schemas/plan.ts';
import { z } from '../../src/schemas/zod.ts';
import type { Scripted } from '../../test/helpers/nip-fixture.ts';
import {
  attemptFailure,
  choiceBetween,
  nextRunOf,
  type RunRecord,
  type RunScore,
  recordIn,
  runsOfSetup,
  runsReadFrom,
  type Scored,
  type SetupSummary,
  saidChoice,
  scoreAttempts,
  stepIdOf,
  summaryOf,
  TASTE,
  tableOf,
} from './core.ts';

/** The seven default plan lenses, in the order the apart setup's group runs them. */
const SEVEN = [
  'plan/coverage',
  'plan/naive-reader',
  'plan/order-and-overlap',
  'plan/recipe-fit',
  'plan/security',
  'plan/sizing',
  'plan/testability',
] as const;

/** `mash`'s three lenses (ADR 0321). */
const MASH = ['plan/coverage', 'plan/sizing', 'plan/naive-reader'] as const;

/** The lenses `decoction` runs on `planner`; the others are on the Taster's own alias (ADR 0321). */
const ON_PLANNER: readonly string[] = ['plan/coverage', 'plan/security'];

/** The setups that run, and their lenses. */
export const PLAN_SETUPS = {
  'plan-apart-7': { lenses: SEVEN as readonly string[] },
  'plan-together-7': { lenses: SEVEN as readonly string[] },
  'plan-together-mash': { lenses: MASH as readonly string[] },
} as const;
export type PlanSetupName = keyof typeof PLAN_SETUPS;
const SETUP_NAMES = Object.keys(PLAN_SETUPS) as PlanSetupName[];
export type PlanRunRecord = RunRecord<PlanSetupName>;

/** A setup as the table shows it: the three that run, and `mash`'s three apart read from the seven. */
type PlanShown = PlanSetupName | 'plan-apart-mash';
const READ: PlanShown = 'plan-apart-mash';
const SHOWN: readonly PlanShown[] = ['plan-apart-7', 'plan-together-7', READ, 'plan-together-mash'];

/** The step the scripted plan is written by: the default Brewmaster's, with no model. */
export const PLAN_STEP = 'plan';

/** The lenses each Taster step of `setup` reviews through, by step id. */
const tasterSteps = (setup: PlanSetupName): Map<string, readonly string[]> => {
  const { lenses } = PLAN_SETUPS[setup];
  return setup === 'plan-apart-7'
    ? new Map(lenses.map((lens) => [stepIdOf(lens), [lens]]))
    : new Map([[TASTE, lenses]]);
};

/**
 * The recipe of `setup`: the scripted plan, then its Tasters, with no blocking step and no route, so
 * a run measures one round and ends at the plan's review (ADR 0275). Each step apart names the model
 * `decoction` gives its lens; a step together is on the Taster's own model (ADR 0220).
 */
export const planRecipeText = (setup: PlanSetupName): string => {
  const { lenses } = PLAN_SETUPS[setup];
  const apart = setup === 'plan-apart-7';
  const taste = apart
    ? {
        id: TASTE,
        parallel: lenses.map((lens) => ({
          id: stepIdOf(lens),
          brewer: 'taster',
          lens,
          ...(ON_PLANNER.includes(lens) ? { model: 'planner' } : {}),
        })),
      }
    : { id: TASTE, brewer: 'taster', lenses };
  const recipe = {
    name: setup,
    description: `The seeded plan of #804, tasted ${apart ? 'apart' : 'together'}; it builds nothing`,
    testFirst: false,
    steps: [{ id: PLAN_STEP, brewer: 'brewmaster' }, taste],
  };
  return `// node scripts/tasting-compare.ts --plan's setup ${setup} (ADR 0323).\n${JSON.stringify(recipe, null, 2)}\n`;
};

/** One planted mistake: its lens, the sub-orders at fault, the field it is in, and what it is. */
interface Mistake {
  id: string;
  lens: string;
  subOrders: readonly string[];
  field: string;
  what: string;
}
interface PlanKey {
  mistakes: readonly Mistake[];
}

const Text = z.string().min(1);
const KeyFile = z.strictObject({
  mistakes: z
    .array(
      z.strictObject({
        id: Text,
        lens: Text,
        subOrders: z.array(Text).min(1),
        field: Text,
        what: Text,
      }),
    )
    .min(1),
});

/** The key of `key.json`'s text; throws when it is not one. */
export const readPlanKey = (text: string): PlanKey => KeyFile.parse(JSON.parse(text));

/** The scripted Brewmaster's turn from `plan.json`'s text; throws when it is no done plan. */
export const readSeededPlan = (text: string): Scripted => {
  const { summary, ...doc } = PlanOutDoc.parse({ status: 'done', ...JSON.parse(text) });
  return { files: {}, message: '', summary, doc };
};

/** A sub-order's id as a finding writes it (ADR 0312), with or without backticks. */
const WRITTEN_ID = /^`([a-z0-9-]+)`$|^([a-z0-9-]+)$/;

/**
 * The sub-orders a finding's `why` starts with, up to its first colon: one id, or a list of them,
 * as a finding on two sub-orders may write it. None when anything else stands before that colon.
 */
export const subOrdersOfWhy = (why: string): string[] => {
  const head = why.slice(0, Math.max(why.indexOf(':'), 0));
  if (head.trimStart() !== head) return [];
  const ids: string[] = [];
  for (const part of head.split(/,| and |&|\//)) {
    const written = part.trim();
    if (written === '') continue;
    const match = WRITTEN_ID.exec(written);
    const id = match?.[1] ?? match?.[2];
    if (id === undefined) return [];
    ids.push(id);
  }
  return ids;
};

const onMistake = ({ why }: TastingFinding, { subOrders }: Mistake): boolean =>
  subOrdersOfWhy(why).some((id) => subOrders.includes(id));

const mistakesOf = (key: PlanKey, lenses: readonly string[]): Mistake[] =>
  key.mistakes.filter(({ lens }) => lenses.includes(lens));

/** A run's record from its store's events: how its batch ended, and its Taster attempts. */
export const planRecordOf = (
  events: readonly { event: Event }[],
  setup: PlanSetupName,
): Pick<PlanRunRecord, 'ended' | 'attempts'> => recordIn(events, tasterSteps(setup));

/** Why a run failed, or undefined: its batch does not wait for its plan's review, or a Taster failed. */
export const planRunFailure = ({ ended, attempts }: PlanRunRecord): string | undefined =>
  ended === 'stuck: plan_review' ? attemptFailure(attempts) : `the batch ended ${ended}`;

/** Scores a run against the mistakes of its setup's lenses; every other finding is listed. */
export const scorePlanRun = (record: PlanRunRecord, key: PlanKey): RunScore =>
  scoreAttempts(record.attempts, mistakesOf(key, PLAN_SETUPS[record.setup].lenses), onMistake);

/**
 * Each shown setup over its runs. `mash`'s three apart are the seven's coverage, sizing and naive
 * reader attempts, side by side, with no wall time of their own, as ADR 0224 reads Nip's.
 */
export const summarizePlan = (
  records: readonly PlanRunRecord[],
  key: PlanKey,
): SetupSummary<PlanShown>[] =>
  SHOWN.map((setup) => {
    const { scored, failed } = runsOfSetup(
      records,
      setup === READ ? 'plan-apart-7' : setup,
      planRunFailure,
    );
    const planted = mistakesOf(key, setup === READ ? MASH : PLAN_SETUPS[setup].lenses);
    const runs: readonly Scored[] = setup === READ ? runsReadFrom(scored, MASH) : scored;
    const scores = runs.map(({ attempts }) => scoreAttempts(attempts, planted, onMistake));
    return summaryOf(setup, planted, runs, scores, failed);
  });

/** The next run to brew (`nextRunOf`). */
export const nextPlanRun = (records: readonly PlanRunRecord[], runs: number) =>
  nextRunOf(SETUP_NAMES, records, runs, planRunFailure);

/** The one table of plan mode: per setup, per mistake, ADR 0224's choice, and every other finding. */
export const planTableMarkdown = (
  summaries: readonly SetupSummary<PlanShown>[],
  key: PlanKey,
  { dryRun }: { dryRun: boolean },
): string => {
  const said = (apart: PlanShown, together: PlanShown): string =>
    `${saidChoice(choiceBetween(summaries, apart, together))} (${apart} against ${together})`;
  return tableOf(summaries, {
    planted: 'Mistake',
    rows: key.mistakes,
    // A dry run spends no token, and no tokens would pass the rule.
    choices: dryRun
      ? ['- A dry run measures nothing: its Tasters are scripted, so it makes no choice.']
      : [
          `- Mash: ${said(READ, 'plan-together-mash')}`,
          `- Seven lenses: ${said('plan-apart-7', 'plan-together-7')}`,
        ],
    readFromAnother: READ,
  });
};

/** The dry run's Tasters: each step reports the key's mistakes of its lenses (#804). */
export const scriptedPlanTastings = (
  setup: PlanSetupName,
  key: PlanKey,
): Record<string, readonly Scripted[]> =>
  Object.fromEntries(
    [...tasterSteps(setup)].map(([stepId, lenses]) => {
      // A one-lens step's findings are its lens's; a lenses step's each name theirs (ADR 0220).
      const findings = mistakesOf(key, lenses).map(({ lens, subOrders, what }) => ({
        severity: 'major' as const,
        why: `${subOrders[0]}: ${what}`,
        introduced: true,
        ...(lenses.length > 1 ? { lens } : {}),
      }));
      const tasting = { verdict: findings.length === 0 ? 'approve' : 'changes', findings } as const;
      const summary = `The dry run's scripted Taster: ${findings.length} planted mistakes.`;
      return [stepId, [{ files: {}, message: '', summary, tasting }]];
    }),
  );
