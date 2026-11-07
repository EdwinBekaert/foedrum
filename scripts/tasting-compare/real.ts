// The decisions of node scripts/tasting-compare.ts --real (#879, ADR 0332): the brewed heads and the
// setups, the recipe and the Brewery's files of a run, a head's changed files, what a Taster's
// transcript says it read, a run's record, and the blinded lists. It scores nothing: a person does,
// against a key that stays out of the repository. Nothing here starts a process.

import { createHmac } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathInside } from '../../src/platform/paths.ts';
import { ClaudeToolResult, ClaudeToolUse } from '../../src/schemas/claude-stream.ts';
import type { Event } from '../../src/schemas/events.ts';
import { z } from '../../src/schemas/zod.ts';
import type { FakeApiComment } from '../../test/helpers/fake-github-api.ts';
import type { Scripted } from '../../test/helpers/nip-fixture.ts';
import {
  escapeCell,
  IMPLEMENT,
  nextRunOf,
  placeShown,
  type RunRecord,
  recordIn,
  runFailure,
  runsOfSetup,
  TASTE,
  type TasterAttempt,
  tokensOf,
} from './core.ts';

/** The three self-brew orders of #374, each as brewed, not as merged. */
export const REAL_ORDERS = [
  { order: 855, base: '58db3d5e', head: '62d71154' },
  { order: 864, base: 'b6db0ca8', head: '5590e9c5' },
  { order: 867, base: '02eba0cd', head: 'f4fb4585' },
] as const;

/** The commit whose `taster.md` the `today` setup tastes with. */
export const TODAY_COMMIT = '765cc856';

type OrderNumber = (typeof REAL_ORDERS)[number]['order'];
type Profile = 'today' | 'reads' | 'lens';
const PROFILES: readonly Profile[] = ['today', 'reads', 'lens'];
/**
 * One order tasted one way: the order first, so the record reads on its own. `867-comments` is
 * `867-reads` with the one maintainer's comment an order had before it brewed (ADR 0333).
 */
export type RealSetup = `${OrderNumber}-${Profile}` | '867-comments';
export type RealRecord = RunRecord<RealSetup>;

/** Order by order, and setup by setup within one. */
export const REAL_SETUPS: readonly RealSetup[] = [
  ...REAL_ORDERS.flatMap(({ order }) => PROFILES.map((profile) => `${order}-${profile}` as const)),
  '867-comments',
];

/** The order `setup` tastes. */
export const orderOf = (setup: RealSetup): (typeof REAL_ORDERS)[number] => {
  const number = Number(setup.slice(0, setup.indexOf('-')));
  const found = REAL_ORDERS.find(({ order }) => order === number);
  if (found === undefined) throw new Error(`no order for the setup ${setup}`);
  return found;
};

/** The recipe of the `today` and `reads` setups. */
export const REAL_RECIPE = 'real-nip';
/** The recipe of the `lens` setup (ADR 0337). */
const REAL_LENS_RECIPE = 'real-nip-lens';

/** The three Tasters `nip` had when #879 measured it, kept so `real-nip` means what it meant (ADR 0343). */
const TASTERS = [
  { id: 'correctness', brewer: 'taster', lens: 'diff/correctness' },
  { id: 'acceptance', brewer: 'taster', lens: 'diff/acceptance' },
  { id: 'security', brewer: 'taster', lens: 'diff/security' },
] as const;
/** The `lens` setup's Tasters (ADR 0337), `nip`'s since ADR 0343; a test holds them to `defaults/recipes/nip.jsonc`. */
const LENS_TASTERS = [
  ...TASTERS,
  { id: 'design-conformance', brewer: 'taster', lens: 'diff/design-conformance' },
] as const;
const STEPS: ReadonlyMap<string, readonly string[]> = new Map(
  LENS_TASTERS.map(({ id, lens }) => [id, [lens]]),
);

/** The recipe a run of `setup` brews. */
export const realRecipeOf = (setup: RealSetup): string =>
  setup.endsWith('-lens') ? REAL_LENS_RECIPE : REAL_RECIPE;

/**
 * The scripted implementer, `setup`'s Tasters with nothing blocking, so every run ends, and the pull
 * request a recipe that commits must open (ADR 0084). No check runs, and the Gauger is skipped as
 * testFirst off skips it (ADR 0224).
 */
export const realRecipeText = (setup: RealSetup): string => {
  const recipe = {
    name: realRecipeOf(setup),
    description: setup.endsWith('-lens')
      ? 'A head as it was brewed, tasted by correctness, acceptance, security and design conformance, nothing blocking'
      : 'A head as it was brewed, tasted by correctness, acceptance and security, nothing blocking',
    testFirst: false,
    steps: [
      { id: 'gauge', brewer: 'gauger', when: 'recipe.testFirst' },
      { id: IMPLEMENT, brewer: 'cellarman' },
      { id: TASTE, parallel: setup.endsWith('-lens') ? LENS_TASTERS : TASTERS },
      { action: 'openPullRequest' },
    ],
  };
  return `// node scripts/tasting-compare.ts --real's recipe (ADR 0332).\n${JSON.stringify(recipe, null, 2)}\n`;
};

/** The Brewery's files of a run of `setup` beyond Nip's: the recipe, and `today`'s Taster. */
export const realBreweryFiles = (
  setup: RealSetup,
  todayTaster: string,
): Record<string, string> => ({
  [`recipes/${realRecipeOf(setup)}.jsonc`]: realRecipeText(setup),
  ...(setup.endsWith('-today') ? { 'brewers/taster.md': todayTaster } : {}),
});

/**
 * The comments on the fake host's issue in a run of `setup`, `author` a maintainer's login, the
 * text from `read` of a file of `test/fixtures/tasting-compare/real/`.
 */
export const realCommentsOf = (
  setup: RealSetup,
  author: string,
  read: (file: string) => string,
): FakeApiComment[] =>
  setup === '867-comments'
    ? [
        {
          id: 900_001,
          author,
          association: 'OWNER',
          created: '2026-11-05T19:44:00Z',
          body: read('867-comment.md').trimEnd(),
        },
      ]
    : [];

/** Throws when `today`'s pinned Taster is the default's text: the comparison would be of nothing. */
export const refuseSameTaster = (today: string, current: string): void => {
  const lines = (text: string): string => text.replaceAll('\r\n', '\n');
  if (lines(today) === lines(current)) {
    throw new Error(
      `the Taster at ${TODAY_COMMIT} and the default are the same Taster: the setups would compare nothing`,
    );
  }
};

/**
 * The files the scripted Cellarman commits, from `git diff --name-status -z --no-renames`; throws on
 * a head it could not commit as it is, which would taste something else: one that deletes a file, or
 * renames one, which reads as a delete here, or changes a file's kind.
 */
export const changedFiles = (nameStatus: string): string[] => {
  const fields = nameStatus.split('\0');
  const files: string[] = [];
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [status, path] = [fields[at], fields[at + 1] ?? ''];
    if (status === 'D') throw new Error(`the head deletes ${path}, which no commit here would do`);
    if (status !== 'A' && status !== 'M') {
      throw new Error(`the head changes ${path} as ${status}, which no commit here would do`);
    }
    files.push(path);
  }
  if (files.length === 0) throw new Error('the head changes no file');
  return files;
};

/** What a transcript says a Taster read. */
interface TranscriptReads {
  /** The files the Taster read, by path in its worktree, once each. */
  opened: readonly string[];
  /** What it reached outside its worktree. */
  outside: readonly string[];
  /** What it asked for outside and got an error for, a refusal of its permissions among them. */
  refused: readonly string[];
  /** Why the transcript cannot say what the Taster read. */
  problem?: string;
  /** Its out doc's text past the frontmatter. */
  body?: string;
}

/** The Taster's out doc (`defaults/brewers/taster.md`'s `output.doc`). */
const OUT_DOC = 'taste.md';

/** The out doc as the call leaves it: a Write's text, or an Edit's; an empty text to replace is the whole. */
const docAfter = (doc: string, name: string, input: Record<string, unknown>): string => {
  if (name === 'Write') return text(input.content) ?? doc;
  const [from, to] = [text(input.old_string) ?? '', text(input.new_string) ?? ''];
  if (from === '') return to;
  return input.replace_all === true ? doc.replaceAll(from, () => to) : doc.replace(from, () => to);
};

/** A doc's text past its frontmatter. */
const bodyOf = (doc: string): string => {
  const closing = doc.startsWith('---') ? doc.indexOf('\n---', 3) : -1;
  if (closing === -1) return doc.trim();
  const after = doc.indexOf('\n', closing + 1);
  return after === -1 ? '' : doc.slice(after + 1).trim();
};

const TranscriptLine = z.looseObject({
  type: z.string().optional(),
  message: z.looseObject({ content: z.unknown() }).optional(),
});

const blocksOf = (content: unknown): readonly unknown[] => (Array.isArray(content) ? content : []);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Where a call reached, and whether that is the worktree or lies inside it. */
interface Reach {
  place: string;
  inside: boolean;
}

const reachOf = (worktree: string, place: string): Reach => ({
  place,
  // Any file under a place inside is inside too, and the worktree itself is no path inside it.
  inside: pathInside(worktree, join(place, 'any')) !== undefined,
});

/**
 * Where `path` reaches, read against the worktree. A `~` first names a home folder, which a tool may
 * expand: `resolve` would read it as a folder in the worktree, so it counts as outside.
 */
const reachOfPath = (worktree: string, path: string): Reach =>
  path.startsWith('~')
    ? { place: path, inside: false }
    : reachOf(worktree, resolve(worktree, path));

/** A segment of a Glob pattern that goes up: `..`, or `..` as one choice of a brace group. */
const GOES_UP = /(?:^|[{,])\.\.(?:$|[},])/;

/**
 * What a Glob lists: its `path`, then the pattern up to its first wildcard, where the pattern may
 * hold `..` or be absolute. A `..` past a wildcard can land anywhere, so it counts as outside.
 */
const globReach = (worktree: string, input: Record<string, unknown>): Reach | undefined => {
  const pattern = text(input.pattern);
  if (pattern === undefined) return undefined;
  const segments = pattern.replaceAll('\\', '/').split('/');
  const wildcard = segments.findIndex((segment) => /[*?[{]/.test(segment));
  const literal = wildcard === -1 ? segments : segments.slice(0, wildcard);
  if (
    pattern.startsWith('~') ||
    segments
      .slice(wildcard === -1 ? segments.length : wildcard)
      .some((segment) => GOES_UP.test(segment))
  ) {
    return { place: pattern, inside: false };
  }
  const path = text(input.path) ?? '.';
  if (path.startsWith('~')) return { place: path, inside: false };
  const from = resolve(worktree, path);
  // The `/` keeps a drive's root (`D:/*`) and the root (`/*`) from reading as the folder it is in.
  return reachOf(worktree, literal.length === 0 ? from : resolve(from, `${literal.join('/')}/`));
};

/** Where a call of a tool that reads paths reached; undefined when it is no such tool. */
const reachOfCall = (
  worktree: string,
  name: string,
  input: Record<string, unknown>,
): Reach | undefined => {
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write': {
      const path = text(input.file_path);
      return path === undefined ? undefined : reachOfPath(worktree, path);
    }
    case 'Grep':
      return reachOfPath(worktree, text(input.path) ?? '.');
    case 'Glob':
      return globReach(worktree, input);
    default:
      return undefined;
  }
};

const readLine = (line: string) => {
  try {
    return TranscriptLine.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
};

/**
 * What the calls in a session's transcript reached, against `worktree`, which relative paths are
 * read against. Only the model's and the tools' own lines count: a transcript also logs requests. A
 * call that came back as an error read nothing. A transcript that shows no call, or a call with no
 * result, says nothing, since a Taster writes its out doc with one, so a transcript of another format
 * cannot read as staying inside.
 */
export const transcriptReads = (transcript: string, worktree: string): TranscriptReads => {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const answered = new Set<string>();
  let doc = '';
  const opened = new Set<string>();
  const outside: string[] = [];
  const refused: string[] = [];
  let problem: string | undefined;
  for (const [at, line] of transcript.split(/\r?\n/).entries()) {
    if (line === '') continue;
    const read = readLine(line);
    if (read === undefined) {
      problem ??= `its transcript's line ${at + 1} cannot be read`;
      continue;
    }
    const { type, message } = read;
    if (type !== 'assistant' && type !== 'user') continue;
    for (const block of blocksOf(message?.content)) {
      const use = ClaudeToolUse.safeParse(block);
      if (type === 'assistant' && use.success) {
        calls.set(use.data.id, { name: use.data.name, input: use.data.input });
        continue;
      }
      const result = ClaudeToolResult.safeParse(block);
      if (type !== 'user' || !result.success) continue;
      const call = calls.get(result.data.tool_use_id);
      if (call === undefined) continue;
      answered.add(result.data.tool_use_id);
      const reach = reachOfCall(worktree, call.name, call.input);
      if (result.data.is_error === true) {
        if (reach !== undefined && !reach.inside) refused.push(reach.place);
      } else if (reach === undefined) {
        problem ??= `it ran ${call.name}, and what that read cannot be told`;
      } else if (!reach.inside) {
        outside.push(reach.place);
      } else {
        const inWorktree = pathInside(worktree, reach.place);
        if (call.name === 'Read' && inWorktree !== undefined) opened.add(inWorktree);
        if (call.name !== 'Read' && inWorktree === OUT_DOC) {
          doc = docAfter(doc, call.name, call.input);
        }
      }
    }
  }
  if (calls.size === 0) problem ??= 'its transcript shows no tool call';
  const unanswered = [...calls.keys()].find((id) => !answered.has(id));
  if (unanswered !== undefined) {
    problem ??= `its transcript shows no result of the ${calls.get(unanswered)?.name} call`;
  }
  const body = bodyOf(doc);
  return {
    opened: [...opened],
    outside,
    refused,
    ...(problem === undefined ? {} : { problem }),
    ...(body === '' ? {} : { body }),
  };
};

/**
 * A run's record from its store's events: how its batch ended, and its Tasters' attempts, each with
 * what its session's transcript says it read. A read outside its worktree fails the attempt, and so
 * does a transcript that cannot say, since the run would then be no measurement (ADR 0332). The
 * attempt's own failure stays its reason.
 */
export const realRecordOf = (
  events: readonly { event: Event }[],
  transcriptOf: (sessionId: string, worktree: string) => string | undefined,
): Pick<RealRecord, 'ended' | 'attempts'> => {
  const { ended, attempts } = recordIn(events, STEPS);
  const sessions = new Map<string, { id: string; worktree: string }>();
  const finished: { stepId: string; attempt: number }[] = [];
  for (const { event } of events) {
    if (event.type === 'step.started' && event.session !== undefined) {
      sessions.set(`${event.stepId}#${event.attempt}`, event.session);
    } else if (event.type === 'step.finished' && STEPS.has(event.stepId)) {
      finished.push(event);
    }
  }
  return {
    ended,
    attempts: attempts.map((attempt, at): TasterAttempt => {
      const ran = finished[at];
      const session = ran && sessions.get(`${ran.stepId}#${ran.attempt}`);
      const transcript = session && transcriptOf(session.id, session.worktree);
      const reads: TranscriptReads =
        session === undefined || transcript === undefined
          ? {
              opened: [],
              outside: [],
              refused: [],
              problem: 'its transcript could not be found, so what it read cannot be told',
            }
          : transcriptReads(transcript, session.worktree);
      const { opened, outside, refused, problem, body } = reads;
      const reached =
        outside.length === 0 ? undefined : `it read outside its worktree: ${outside.join(', ')}`;
      return {
        ...attempt,
        failure: attempt.failure ?? reached ?? problem,
        opened,
        outside,
        refused,
        ...(attempt.failure === undefined && problem !== undefined ? { unreadable: problem } : {}),
        ...(body === undefined ? {} : { body }),
      };
    }),
  };
};

/**
 * Why the comparison must stop, or undefined: a transcript that cannot say is the harness's, not the
 * Taster's, so running on would spend sessions on nothing (ADR 0332). A read outside fails only its run.
 */
export const comparisonStop = ({ attempts }: Pick<RealRecord, 'attempts'>): string | undefined => {
  const lost = attempts.find(({ unreadable }) => unreadable !== undefined);
  return lost === undefined ? undefined : escapeCell(`${lost.stepId}: ${lost.unreadable}`);
};

/** The next run to brew (`nextRunOf`). */
export const nextRealRun = (records: readonly RealRecord[], runs: number) =>
  nextRunOf(REAL_SETUPS, records, runs, runFailure);

/** A run's code under `seed`: it says nothing of the run without the seed. */
export const codeOf = (seed: string, setup: RealSetup, run: number): string =>
  createHmac('sha256', seed).update(`${setup}/${run}`).digest('hex').slice(0, 8);

/** Each Taster of a run in the recipe's order, so the order they finished in says nothing. */
const inRecipeOrder = (attempts: readonly TasterAttempt[]): TasterAttempt[] => {
  const place = (stepId: string): number => LENS_TASTERS.findIndex(({ id }) => id === stepId);
  return [...attempts].sort((a, b) => place(a.stepId) - place(b.stepId));
};

const tasterLines = ({ stepId, lenses, findings, riskLeft = [] }: TasterAttempt): string[] => [
  `### ${stepId} (${lenses.join(', ')})`,
  '',
  ...(findings.length === 0
    ? ['No findings.']
    : findings.map((finding) => {
        const before = finding.introduced ? '' : ', there before the change';
        return `- ${escapeCell(`${finding.severity} in ${placeShown(finding)}${before}: ${finding.why}`)}`;
      })),
  '',
  ...(riskLeft.length === 0
    ? []
    : [
        'Risks left, which do not count as findings:',
        '',
        ...riskLeft.map((risk) => `- ${escapeCell(risk)}`),
        '',
      ]),
];

/** A Taster's body as quoted lines, so no line of it reads as a line of the file. */
const bodyLines = ({ stepId, lenses, body }: TasterAttempt): string[] => [
  `### ${stepId} (${lenses.join(', ')})`,
  '',
  ...(body === undefined
    ? ['No body.']
    : body.split(/\r\n|[\r\n\p{Zl}\p{Zp}]/u).map((line) => `> ${line}`.trimEnd())),
  '',
];

const codeRows = (code: string, { setup, run, attempts }: RealRecord): string[] =>
  inRecipeOrder(attempts).map((attempt) => {
    const { stepId, models = [], usage } = attempt;
    const { total } = tokensOf([attempt]);
    const tokens =
      usage === undefined
        ? '- | - | - | - | -'
        : `${usage.inputTokens} | ${usage.outputTokens} | ${usage.cacheReadTokens} | ${usage.cacheWriteTokens} | ${total}`;
    const model = models.length === 0 ? '-' : models.map(escapeCell).join(', ');
    return `| ${code} | ${setup} | ${run} | ${stepId} | ${model} | ${tokens} |`;
  });

/**
 * One list per order of the findings of its runs that did not fail, each under its code and sorted
 * by it, one file per order of their out doc bodies, which can say what a Taster read, so they are
 * for after the findings are scored, and the one file that names the setups: each code's setup and
 * run, each Taster's model and tokens, and the failed runs. Nothing here says which finding is right.
 */
export const blinded = (
  records: readonly RealRecord[],
  seed: string,
): { lists: Record<string, string>; bodies: Record<string, string>; codes: string } => {
  const lists: Record<string, string> = {};
  const bodies: Record<string, string> = {};
  const rows: string[] = [];
  const failures: string[] = [];
  for (const { order } of REAL_ORDERS) {
    const scored: { code: string; record: RealRecord }[] = [];
    for (const setup of REAL_SETUPS.filter((each) => orderOf(each).order === order)) {
      const runs = runsOfSetup(records, setup, runFailure);
      for (const record of runs.scored) {
        const code = codeOf(seed, setup, record.run);
        scored.push({ code, record });
        rows.push(...codeRows(code, record));
      }
      for (const { run, why } of runs.failed) {
        failures.push(`Failed: ${setup} run ${run}: ${escapeCell(why)}`);
      }
    }
    if (scored.length === 0) continue;
    scored.sort((a, b) => (a.code < b.code ? -1 : 1));
    const runsWith = (lines: (attempt: TasterAttempt) => string[]): string[] =>
      scored.flatMap(({ code, record }) => [
        `## Run ${code}`,
        '',
        ...inRecipeOrder(record.attempts).flatMap(lines),
      ]);
    lists[String(order)] = `${[
      `# Order #${order}: ${scored.length} runs to score`,
      '',
      'Each run has a code of its own. Open codes.md only once they are scored.',
      '',
      ...runsWith(tasterLines),
    ]
      .join('\n')
      .trimEnd()}\n`;
    bodies[String(order)] = `${[
      `# Order #${order}: the out doc bodies, to read once the findings are scored`,
      '',
      ...runsWith(bodyLines),
    ]
      .join('\n')
      .trimEnd()}\n`;
  }
  const codes = [
    '# The codes of the lists',
    '',
    '| Code | Setup | Run | Taster | Model | Input | Output | Cache read | Cache write | Tokens |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    ...(failures.length === 0 ? [] : ['', ...failures]),
    '',
  ].join('\n');
  return { lists, bodies, codes };
};

/**
 * What the comparison prints: each setup's runs to score, failed and retried, since a setup that
 * retries more is a finding in itself. It holds no code, so it unblinds no list.
 */
export const realTable = (records: readonly RealRecord[]): string => {
  const rows = REAL_SETUPS.map((setup) => {
    const { scored, failed } = runsOfSetup(records, setup, runFailure);
    const retried = records.filter((each) => each.setup === setup && each.retry === true).length;
    return `| ${setup} | ${scored.length} | ${failed.length} | ${retried} |`;
  });
  return `${[
    '| Setup | Runs to score | Failed goes | Retried |',
    '|---|---|---|---|',
    ...rows,
    '',
    'Score lists/<order>.md by hand, then read bodies/<order>.md, then open codes.md, which says which setup each code is.',
  ].join('\n')}\n`;
};

/** The dry run's Tasters: a scripted finding on `file` and a risk left, and nothing of any key. */
export const scriptedRealTastings = (file: string): Record<string, readonly Scripted[]> =>
  Object.fromEntries(
    LENS_TASTERS.map(({ id, lens }) => [
      id,
      [
        {
          files: {},
          message: '',
          summary: `The dry run's scripted Taster through ${lens}.`,
          tasting: {
            verdict: 'approve' as const,
            findings: [
              {
                file,
                line: 1,
                severity: 'minor',
                why: `scripted by the dry run, through ${lens}`,
                introduced: true,
              },
            ],
          },
          doc: { riskLeft: [`scripted by the dry run: a risk left through ${lens}`] },
        },
      ],
    ]),
  );

/** The transcript of a dry run's Taster: it reads a file of its worktree and writes its out doc. */
export const scriptedTranscript = (worktree: string): string =>
  [
    ['Read', { file_path: join(worktree, 'CLAUDE.md') }],
    ['Edit', { file_path: join(worktree, 'taste.md'), old_string: '', new_string: 'scripted' }],
  ]
    .flatMap(([name, input], at) => [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: `scripted-${at}`, name, input }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: `scripted-${at}` }] },
      }),
    ])
    .join('\n');
