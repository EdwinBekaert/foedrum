// The decisions of node scripts/tasting-compare.ts (#567, ADR 0224): the three setups and their
// recipes, the seeded change's key, how a run's Taster attempts are scored against it, the sums
// over runs, which run is next, the rule that picks a recipe's choice, and the one table.
// scripts/tasting-compare.ts brews the runs with the real claude; nothing here starts a process.

import type { Usage } from '../../src/schemas/events.ts';
import { lensOfFinding, TastingFinding } from '../../src/schemas/out-doc.ts';
import type { StepOutcome } from '../../src/schemas/step-outcome.ts';
import { z } from '../../src/schemas/zod.ts';
import type { Scripted } from '../../test/helpers/nip-fixture.ts';

/** The seven default diff lenses, in the order the apart setup's group runs them. */
const SEVEN = [
  'diff/acceptance',
  'diff/correctness',
  'diff/cross-platform',
  'diff/design-conformance',
  'diff/necessity',
  'diff/security',
  'diff/test-design',
] as const;

/** Nip's two lenses (ADR 0197). */
const NIP = ['diff/correctness', 'diff/acceptance'] as const;

/** A setup that runs, and its lenses. */
export const SETUPS = {
  'apart-7': { lenses: SEVEN as readonly string[] },
  'together-7': { lenses: SEVEN as readonly string[] },
  'together-nip': { lenses: NIP as readonly string[] },
} as const;
export type SetupName = keyof typeof SETUPS;
const SETUP_NAMES = Object.keys(SETUPS) as SetupName[];

/** The step that commits the seeded change: a scripted Cellarman, no model. */
export const IMPLEMENT = 'implement';
/** The step id of a together setup's one Taster, and of the apart setup's group. */
export const TASTE = 'taste';

/** A lens step's id in the apart group: the lens's name without its folder. */
const stepIdOf = (lens: string): string => lens.slice(lens.indexOf('/') + 1);

/** The lenses each Taster step of `setup` reviews through, by step id. */
const tasterSteps = (setup: SetupName): Map<string, readonly string[]> => {
  const { lenses } = SETUPS[setup];
  return setup === 'apart-7'
    ? new Map(lenses.map((lens) => [stepIdOf(lens), [lens]]))
    : new Map([[TASTE, lenses]]);
};

/**
 * The recipe of `setup`: the scripted implementer, then its Tasters, each the default `taster`
 * with its model; no check and no pull request, so the batch goes on tap once they have tasted.
 */
export const recipeText = (setup: SetupName): string => {
  const { lenses } = SETUPS[setup];
  const taste =
    setup === 'apart-7'
      ? {
          id: TASTE,
          parallel: lenses.map((lens) => ({ id: stepIdOf(lens), brewer: 'taster', lens })),
        }
      : { id: TASTE, brewer: 'taster', lenses };
  const recipe = {
    name: setup,
    description: `The seeded change of #567, tasted ${setup.startsWith('apart') ? 'apart' : 'together'}`,
    steps: [{ id: IMPLEMENT, brewer: 'cellarman' }, taste],
  };
  return `// node scripts/tasting-compare.ts's setup ${setup} (ADR 0224).\n${JSON.stringify(recipe, null, 2)}\n`;
};

/** One planted defect: its lens, its file, the line ranges it is in, and what it is. */
export interface Defect {
  id: string;
  lens: string;
  file: string;
  lines: readonly (readonly [number, number])[];
  what: string;
}
export interface Key {
  defects: readonly Defect[];
}

const Line = z.int().positive();
const KeyFile = z.strictObject({
  defects: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        lens: z.string().min(1),
        file: z.string().min(1),
        lines: z
          .array(
            z
              .tuple([Line, Line])
              .refine(([from, to]) => from <= to, 'A range must not end before it starts'),
          )
          .min(1),
        what: z.string().min(1),
      }),
    )
    .min(1),
});

/** The key of `key.json`'s text; throws when it is not one. */
export const readKey = (text: string): Key => KeyFile.parse(JSON.parse(text));

/** The lines a patch adds, by the new file's path and its line number there. */
export const addedLines = (patch: string): Map<string, Set<number>> => {
  const added = new Map<string, Set<number>>();
  let file: string | undefined;
  let line = 0;
  for (const text of patch.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (text.startsWith('diff --git ')) file = undefined;
    else if (text.startsWith('+++ ')) file = text.startsWith('+++ b/') ? text.slice(6) : undefined;
    else if (hunk !== null) line = Number(hunk[1]);
    else if (file === undefined) continue;
    else if (text.startsWith('+')) {
      added.set(file, (added.get(file) ?? new Set()).add(line));
      line += 1;
    } else if (text.startsWith(' ')) line += 1;
    // A removed line, `\ No newline at end of file`, or the signature after the last hunk.
    else if (!text.startsWith('-') && !text.startsWith('\\')) file = undefined;
  }
  return added;
};

/** What is wrong with `key` against the change's patch: a defect must sit on lines it adds. */
export const keyProblems = (key: Key, patch: string): string[] => {
  const added = addedLines(patch);
  const problems: string[] = [];
  for (const { id, file, lines } of key.defects) {
    const ours = added.get(file);
    if (ours === undefined) {
      problems.push(`${id}: the change adds no line to ${file}`);
      continue;
    }
    for (const [from, to] of lines) {
      let any = false;
      for (let line = from; line <= to; line += 1) any ||= ours.has(line);
      if (!any) problems.push(`${id}: ${file}:${from}-${to} has no line the change adds`);
    }
  }
  return problems;
};

/** A Taster's step's attempt as `step.finished` records it. */
export interface FinishedAttempt {
  stepId: string;
  attempt: number;
  outcome: StepOutcome;
  usage?: Usage | undefined;
  receipt?: { turns: number; durationMs?: number | undefined } | undefined;
}

/** One Taster attempt of a run. */
export interface TasterAttempt {
  stepId: string;
  lenses: readonly string[];
  /** Why the attempt did not succeed with a valid out doc; undefined when it did. */
  failure: string | undefined;
  findings: readonly TastingFinding[];
  usage: Usage | undefined;
  turns: number | undefined;
  durationMs: number | undefined;
}

/** One run of a setup, as the shell keeps it. */
export interface RunRecord {
  setup: SetupName;
  run: number;
  /** A failed run's second go. */
  retry?: true;
  /** `on_tap`, or how the batch ended instead. */
  ended: string;
  wallMs: number;
  attempts: readonly TasterAttempt[];
}

/** The findings of a succeeded Taster's output, and how many the schema refused. */
const findingsOf = (output: unknown): { findings: TastingFinding[]; refused: number } => {
  const listed =
    typeof output === 'object' && output !== null && 'findings' in output
      ? output.findings
      : undefined;
  const findings: TastingFinding[] = [];
  let refused = 0;
  for (const item of Array.isArray(listed) ? listed : []) {
    const read = TastingFinding.safeParse(item);
    if (read.success) findings.push(read.data);
    else refused += 1;
  }
  return { findings, refused };
};

/** The Taster attempts of a run of `setup`, in the order they finished; the implementer's left out. */
export const attemptsOf = (
  finished: readonly FinishedAttempt[],
  setup: SetupName,
): TasterAttempt[] => {
  const steps = tasterSteps(setup);
  const attempts: TasterAttempt[] = [];
  for (const { stepId, outcome, usage, receipt } of finished) {
    const lenses = steps.get(stepId);
    if (lenses === undefined) continue;
    let failure: string | undefined;
    let findings: TastingFinding[] = [];
    switch (outcome.kind) {
      case 'succeeded': {
        const read = findingsOf(outcome.output);
        findings = read.findings;
        if (read.refused > 0) {
          failure = `succeeded with ${read.refused} finding${read.refused === 1 ? '' : 's'} the schema refuses`;
        }
        break;
      }
      case 'failed':
        failure = `failed: ${outcome.reason}`;
        break;
      case 'needs_input':
      case 'cancelled':
        failure = outcome.kind;
        break;
      default:
        outcome satisfies never;
    }
    attempts.push({
      stepId,
      lenses,
      failure,
      findings,
      usage,
      turns: receipt?.turns,
      durationMs: receipt?.durationMs,
    });
  }
  return attempts;
};

/** Why a run failed, or undefined: its batch is not on tap, or one of its Taster attempts failed. */
export const runFailure = ({ ended, attempts }: RunRecord): string | undefined => {
  if (ended !== 'on_tap') return `the batch ended ${ended}`;
  const failed = attempts.find(({ failure }) => failure !== undefined);
  return failed === undefined ? undefined : `${failed.stepId}: ${failed.failure}`;
};

/** A finding outside the key, for a person to judge. */
export interface OtherFinding {
  stepId: string;
  finding: TastingFinding;
}
export interface RunScore {
  /** The defects of the setup's lenses a finding is on, in the key's order. */
  found: { defect: string; ownLens: boolean }[];
  others: OtherFinding[];
}

/** Whether a Taster's `file` names `file`: as it is, with `./` or backslashes, or as a longer path. */
const sameFile = (given: string, file: string): boolean => {
  const path = given.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
  return path === file || path.endsWith(`/${file}`);
};

const onDefect = ({ file, line }: TastingFinding, defect: Defect): boolean =>
  file !== undefined &&
  line !== undefined &&
  sameFile(file, defect.file) &&
  defect.lines.some(([from, to]) => from <= line && line <= to);

/** The defects of `lenses` in `key`. */
const defectsOf = (key: Key, lenses: readonly string[]): Defect[] =>
  key.defects.filter(({ lens }) => lenses.includes(lens));

/** Scores a run against the defects of its setup's lenses; every other finding is listed. */
export const scoreRun = (record: RunRecord, key: Key, lenses = SETUPS[record.setup].lenses) => {
  const defects = defectsOf(key, lenses);
  const hits = new Map<string, boolean>();
  const others: OtherFinding[] = [];
  for (const { stepId, lenses: stepLenses, findings } of record.attempts) {
    const stepLens = stepLenses.length === 1 ? stepLenses[0] : undefined;
    for (const finding of findings) {
      const on = defects.filter((defect) => onDefect(finding, defect));
      if (on.length === 0) others.push({ stepId, finding });
      for (const defect of on) {
        const own = lensOfFinding(finding, stepLens) === defect.lens;
        hits.set(defect.id, (hits.get(defect.id) ?? false) || own);
      }
    }
  }
  const found = defects
    .filter(({ id }) => hits.has(id))
    .map(({ id }) => ({ defect: id, ownLens: hits.get(id) === true }));
  return { found, others } satisfies RunScore;
};

/** A setup as the table shows it: the three that run, and Nip's two apart read from apart-7. */
export type Shown = SetupName | 'apart-nip';
const SHOWN: readonly Shown[] = ['apart-7', 'together-7', 'apart-nip', 'together-nip'];

export interface Tokens extends Usage {
  total: number;
}
export interface SetupSummary {
  setup: Shown;
  /** The planted defects of the setup's lenses. */
  defects: number;
  /** Per scored run, in run order: the defects found, those of them its own lens named, the others. */
  found: number[];
  ownLens: number[];
  meanFound: number;
  /** In how many scored runs each defect was found, by its id. */
  perDefect: Map<string, number>;
  others: OtherFinding[][];
  meanTokens: Tokens;
  meanTurns: number;
  meanAttemptMs: number;
  meanWallMs: number;
  failed: { run: number; why: string }[];
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;

const tokensOf = (attempts: readonly TasterAttempt[]): Tokens => {
  const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const { usage } of attempts) {
    if (usage === undefined) continue;
    sum.inputTokens += usage.inputTokens;
    sum.outputTokens += usage.outputTokens;
    sum.cacheReadTokens += usage.cacheReadTokens;
    sum.cacheWriteTokens += usage.cacheWriteTokens;
  }
  const total = sum.inputTokens + sum.outputTokens + sum.cacheReadTokens + sum.cacheWriteTokens;
  return { ...sum, total };
};

/** A scored run's view for one shown setup: its attempts and its wall time. */
interface Scored {
  record: RunRecord;
  attempts: readonly TasterAttempt[];
  wallMs: number;
}

const summaryOf = (
  setup: Shown,
  lenses: readonly string[],
  scored: readonly Scored[],
  failed: SetupSummary['failed'],
  key: Key,
): SetupSummary => {
  const defects = defectsOf(key, lenses);
  const scores = scored.map(({ record, attempts }) =>
    scoreRun({ ...record, attempts }, key, lenses),
  );
  const perDefect = new Map(defects.map(({ id }) => [id, 0]));
  for (const { found } of scores) {
    for (const { defect } of found) perDefect.set(defect, (perDefect.get(defect) ?? 0) + 1);
  }
  const tokens = scored.map(({ attempts }) => tokensOf(attempts));
  const meanOf = (pick: (tokens: Tokens) => number): number => mean(tokens.map(pick));
  const sumOf = (
    attempts: readonly TasterAttempt[],
    pick: (a: TasterAttempt) => number | undefined,
  ) => attempts.reduce((sum, attempt) => sum + (pick(attempt) ?? 0), 0);
  const found = scores.map(({ found }) => found.length);
  return {
    setup,
    defects: defects.length,
    found,
    ownLens: scores.map(({ found }) => found.filter(({ ownLens }) => ownLens).length),
    meanFound: mean(found),
    perDefect,
    others: scores.map(({ others }) => others),
    meanTokens: {
      inputTokens: meanOf((t) => t.inputTokens),
      outputTokens: meanOf((t) => t.outputTokens),
      cacheReadTokens: meanOf((t) => t.cacheReadTokens),
      cacheWriteTokens: meanOf((t) => t.cacheWriteTokens),
      total: meanOf((t) => t.total),
    },
    meanTurns: mean(scored.map(({ attempts }) => sumOf(attempts, (a) => a.turns))),
    meanAttemptMs: mean(scored.map(({ attempts }) => sumOf(attempts, (a) => a.durationMs))),
    meanWallMs: mean(scored.map(({ wallMs }) => wallMs)),
    failed,
  };
};

/**
 * Each shown setup over its runs: per run number the run that did not fail is scored, and every
 * failed one is listed. Nip's two apart are apart-7's correctness and acceptance attempts, side by
 * side, so their wall time is the longer of the two.
 */
export const summarize = (records: readonly RunRecord[], key: Key): SetupSummary[] => {
  const ofSetup = (setup: SetupName) => {
    const scored: RunRecord[] = [];
    const failed: SetupSummary['failed'] = [];
    for (const record of records.filter((each) => each.setup === setup)) {
      const why = runFailure(record);
      if (why !== undefined) failed.push({ run: record.run, why });
      else if (!scored.some(({ run }) => run === record.run)) scored.push(record);
    }
    scored.sort((a, b) => a.run - b.run);
    return { scored, failed };
  };
  return SHOWN.map((setup) => {
    if (setup !== 'apart-nip') {
      const { scored, failed } = ofSetup(setup);
      const runs = scored.map((record) => ({
        record,
        attempts: record.attempts,
        wallMs: record.wallMs,
      }));
      return summaryOf(setup, SETUPS[setup].lenses, runs, failed, key);
    }
    const { scored, failed } = ofSetup('apart-7');
    const nipSteps = new Set(NIP.map(stepIdOf));
    const runs = scored.map((record) => {
      const attempts = record.attempts.filter(({ stepId }) => nipSteps.has(stepId));
      const wallMs = Math.max(0, ...attempts.map(({ durationMs }) => durationMs ?? 0));
      return { record, attempts, wallMs };
    });
    return summaryOf(setup, NIP, runs, failed, key);
  });
};

/**
 * The next run to brew, setup by setup and run by run: a run with no record yet, or once again
 * a run whose only record failed; undefined once every setup has `runs` runs.
 */
export const nextRun = (
  records: readonly RunRecord[],
  runs: number,
): { setup: SetupName; run: number; retry: boolean } | undefined => {
  for (const setup of SETUP_NAMES) {
    for (let run = 1; run <= runs; run += 1) {
      const tried = records.filter((record) => record.setup === setup && record.run === run);
      if (tried.length === 0) return { setup, run, retry: false };
      if (tried.length === 1 && tried[0] !== undefined && runFailure(tried[0]) !== undefined) {
        return { setup, run, retry: true };
      }
    }
  }
  return undefined;
};

export type Choice = 'together' | 'apart';

/**
 * ADR 0224's rule, written before the runs: together when it finds on average at least as many
 * planted defects as apart, less half a defect, with at least 30 % fewer tokens (the four kinds
 * summed); otherwise apart. Undefined while either setup has no scored run.
 */
export const choiceOf = (
  summaries: readonly Pick<SetupSummary, 'setup' | 'meanFound' | 'meanTokens'>[],
): { seven: Choice | undefined; nip: Choice | undefined } => {
  const pick = (apart: Shown, together: Shown): Choice | undefined => {
    const a = summaries.find(({ setup }) => setup === apart);
    const t = summaries.find(({ setup }) => setup === together);
    if (a === undefined || t === undefined) return undefined;
    if (Number.isNaN(a.meanFound) || Number.isNaN(t.meanFound)) return undefined;
    const asGood = t.meanFound >= a.meanFound - 0.5;
    // In whole numbers: 10 t <= 7 a, so 0.7's binary fraction never decides.
    const cheaper = t.meanTokens.total * 10 <= a.meanTokens.total * 7;
    return asGood && cheaper ? 'together' : 'apart';
  };
  return { seven: pick('apart-7', 'together-7'), nip: pick('apart-nip', 'together-nip') };
};

/** Model text as one Markdown table cell or list line: nothing in it is read as Markdown or HTML. */
export const escapeCell = (text: string): string =>
  text
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/[\\`*_[\]|]/g, (character) => `\\${character}`)
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const round = (value: number, digits = 1): string =>
  Number.isNaN(value) ? '-' : String(Number(value.toFixed(digits)));
const thousands = (value: number): string =>
  Number.isNaN(value) ? '-' : Math.round(value).toLocaleString('en-US');
const seconds = (ms: number): string => (Number.isNaN(ms) ? '-' : `${round(ms / 1000, 0)} s`);

/** The one table of ADR 0224: per setup, per defect, the choice, and every other finding. */
export const tableMarkdown = (summaries: readonly SetupSummary[], key: Key): string => {
  const lines = [
    '| Setup | Found (mean) | Per run | Own lens (mean) | Other findings (mean) | Input | Output | Cache read | Cache write | Tokens | Turns | Attempts | Wall | Failed runs |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of summaries) {
    if (s.found.length === 0) {
      lines.push(`| ${s.setup} | no runs |  |  |  |  |  |  |  |  |  |  |  | ${s.failed.length} |`);
      continue;
    }
    const t = s.meanTokens;
    lines.push(
      `| ${s.setup} | ${round(s.meanFound)} / ${s.defects} | ${s.found.join(', ')} | ${round(mean(s.ownLens))} | ${round(mean(s.others.map((o) => o.length)))} | ${thousands(t.inputTokens)} | ${thousands(t.outputTokens)} | ${thousands(t.cacheReadTokens)} | ${thousands(t.cacheWriteTokens)} | ${thousands(t.total)} | ${round(s.meanTurns)} | ${seconds(s.meanAttemptMs)} | ${seconds(s.meanWallMs)} | ${s.failed.length} |`,
    );
  }
  lines.push('', `| Defect | Lens | ${summaries.map(({ setup }) => setup).join(' | ')} |`);
  lines.push(`|---|---|${summaries.map(() => '---|').join('')}`);
  for (const { id, lens } of key.defects) {
    const cells = summaries.map(({ perDefect, found }) => {
      const times = perDefect.get(id);
      return times === undefined || found.length === 0 ? '-' : `${times}/${found.length}`;
    });
    lines.push(`| ${id} | ${lens} | ${cells.join(' | ')} |`);
  }
  const choice = choiceOf(summaries);
  const said = (made: Choice | undefined): string => made ?? 'not measured';
  lines.push(
    '',
    `- Nip: ${said(choice.nip)} (apart-nip against together-nip)`,
    `- Seven lenses: ${said(choice.seven)} (apart-7 against together-7)`,
  );
  for (const s of summaries) {
    if (s.setup === 'apart-nip') continue;
    for (const [index, others] of s.others.entries()) {
      if (others.length === 0) continue;
      lines.push('', `Other findings of ${s.setup}, scored run ${index + 1}:`, '');
      for (const { stepId, finding } of others) {
        const place =
          finding.file === undefined
            ? 'no file'
            : `${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}`;
        const lens = finding.lens === undefined ? '' : `${finding.lens}, `;
        lines.push(
          `- ${stepId}: ${escapeCell(`${lens}${finding.severity} in ${place}: ${finding.why}`)}`,
        );
      }
    }
  }
  for (const s of summaries) {
    for (const { run, why } of s.failed) {
      if (s.setup !== 'apart-nip')
        lines.push('', `Failed: ${s.setup} run ${run}: ${escapeCell(why)}`);
    }
  }
  return `${lines.join('\n')}\n`;
};

/** The dry run's Tasters: each step reports the key's defects of its lenses (#567). */
export const scriptedTastings = (setup: SetupName, key: Key): Record<string, readonly Scripted[]> =>
  Object.fromEntries(
    [...tasterSteps(setup)].map(([stepId, lenses]) => {
      // A one-lens step's findings are its lens's; a lenses step's each name theirs (ADR 0220).
      const findings = defectsOf(key, lenses).map(({ lens, file, lines, what }) => ({
        file,
        line: lines[0]?.[0] ?? 1,
        severity: 'major' as const,
        why: what,
        introduced: true,
        ...(lenses.length > 1 ? { lens } : {}),
      }));
      const tasting = { verdict: findings.length === 0 ? 'approve' : 'changes', findings } as const;
      const summary = `The dry run's scripted Taster: ${findings.length} planted defects.`;
      return [stepId, [{ files: {}, message: '', summary, tasting }]];
    }),
  );
