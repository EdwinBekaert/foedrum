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
  stepIdOf,
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
type Profile =
  | 'today'
  | 'reads'
  | 'lens'
  | 'opus'
  | 'high'
  | 'opus-bare'
  | 'high-bare'
  | 'opus-together';
const PROFILES: readonly Profile[] = [
  'today',
  'reads',
  'lens',
  'opus',
  'high',
  'opus-bare',
  'high-bare',
  'opus-together',
];
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

/** The setups `--setups` names, by the part of a setup's name after its order. */
export const selectRealSetups = (names: string): readonly RealSetup[] => {
  const known = [...PROFILES, 'comments'];
  const chosen = names.split(',');
  const unknown = chosen.find((name) => !known.includes(name));
  if (unknown !== undefined) {
    throw new Error(`--setups names no setup "${unknown}": it knows ${known.join(', ')}`);
  }
  return REAL_SETUPS.filter((setup) => chosen.includes(profileOf(setup)));
};

/** A setup's name after its order: its profile, or `comments`. */
const profileOf = (setup: RealSetup): Profile | 'comments' =>
  setup.slice(setup.indexOf('-') + 1) as Profile | 'comments';

/** The order `setup` tastes. */
export const orderOf = (setup: RealSetup): (typeof REAL_ORDERS)[number] => {
  const number = Number(setup.slice(0, setup.indexOf('-')));
  const found = REAL_ORDERS.find(({ order }) => order === number);
  if (found === undefined) throw new Error(`no order for the setup ${setup}`);
  return found;
};

/** The recipe of every setup but `lens` and `opus-together`. */
export const REAL_RECIPE = 'real-nip';
/** The recipe of the `lens` setup (ADR 0337). */
const REAL_LENS_RECIPE = 'real-nip-lens';
/** The recipe of the `opus-together` setup (ADR 0347). */
const REAL_TOGETHER_RECIPE = 'real-nip-together';

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
/** The `opus-together` setup's one Taster: `real-nip`'s three lenses in one step (ADR 0220, ADR 0347). */
const TOGETHER = {
  id: 'together',
  brewer: 'taster',
  lenses: TASTERS.map(({ lens }) => lens),
} as const;
const STEPS: ReadonlyMap<string, readonly string[]> = new Map([
  ...LENS_TASTERS.map(({ id, lens }): [string, readonly string[]] => [id, [lens]]),
  [TOGETHER.id, TOGETHER.lenses],
]);

/** The recipe a run of `setup` brews. */
export const realRecipeOf = (setup: RealSetup): string => {
  const profile = profileOf(setup);
  if (profile === 'lens') return REAL_LENS_RECIPE;
  return profile === 'opus-together' ? REAL_TOGETHER_RECIPE : REAL_RECIPE;
};

/** Each recipe's description and its Taster step. */
const RECIPES: Record<string, { description: string; taste: Record<string, unknown> }> = {
  [REAL_RECIPE]: {
    description:
      'A head as it was brewed, tasted by correctness, acceptance and security, nothing blocking',
    taste: { id: TASTE, parallel: TASTERS },
  },
  [REAL_LENS_RECIPE]: {
    description:
      'A head as it was brewed, tasted by correctness, acceptance, security and design conformance, nothing blocking',
    taste: { id: TASTE, parallel: LENS_TASTERS },
  },
  [REAL_TOGETHER_RECIPE]: {
    description:
      'A head as it was brewed, tasted by correctness, acceptance and security together in one Taster, nothing blocking',
    taste: TOGETHER,
  },
};

/**
 * The scripted implementer, `setup`'s Tasters with nothing blocking, so every run ends, and the pull
 * request a recipe that commits must open (ADR 0084). No check runs, and the Gauger is skipped as
 * testFirst off skips it (ADR 0224).
 */
export const realRecipeText = (setup: RealSetup): string => {
  const name = realRecipeOf(setup);
  const { description, taste } = RECIPES[name] ?? { description: '', taste: {} };
  const recipe = {
    name,
    description,
    testFirst: false,
    steps: [
      { id: 'gauge', brewer: 'gauger', when: 'recipe.testFirst' },
      { id: IMPLEMENT, brewer: 'cellarman' },
      taste,
      { action: 'openPullRequest' },
    ],
  };
  return `// node scripts/tasting-compare.ts --real's recipe (ADR 0332).\n${JSON.stringify(recipe, null, 2)}\n`;
};

/** The two Taster texts the setups start from. */
export interface Tasters {
  /** `today`'s pinned text, the one at `TODAY_COMMIT`. */
  today: string;
  /** The default's text, `defaults/brewers/taster.md`. */
  current: string;
}

const MEDIUM_EFFORT = '"effort": "medium"';

/** The `high` setup's Taster: the default's text at another effort, and no other change. */
export const highTaster = (current: string): string => {
  if (current.split(MEDIUM_EFFORT).length !== 2) {
    throw new Error(
      `the default Taster does not say ${MEDIUM_EFFORT} once: high would compare nothing`,
    );
  }
  return current.replace(MEDIUM_EFFORT, () => '"effort": "high"');
};

/**
 * What the `-bare` Taster leaves out of the default's text, each once (ADR 0347): the first bullet,
 * the sentence of "Read the change first" that points at the rules, the section's opening and its
 * "What to read" bullet, and the body's `Rules read:` line. The section's other bullets stay: they
 * say what the rules are to a Taster that reads them by itself.
 */
const BARE_CUTS = [
  "- **On a diff, your first tool call reads the repository's instruction file**: `CLAUDE.md` at the root of your working directory, or `AGENTS.md` where that is what it has. Do this before anything else, whatever your lens and however small the change; the section below says what else to read and what these files are.\n",
  " On a diff, read the repository's rules as the section below says; on a plan, read the repository's instructions and design documents when the lens asks you to check against them.",
  "A step that reviews a plan skips this section. On a diff, nothing has loaded the repository's rules for you, so read them yourself before you judge, whatever your lens names.\n\n",
  "- **What to read.** Once {change} shows what the change touches, read the instruction file at the root of your working directory: `CLAUDE.md`, or `AGENTS.md` where that is what it has. Then read what that file or the changed code names for the files the change touches: the decision records and design pages about them and, where the repository keeps scoped rules in a folder of their own (such as `.claude/rules/`, `.cursor/rules/` or `.github/instructions/`), the rule files for them. This is not a tour of its documents. A lens that asks for more reads what it asks for. A file too large to read whole: read what you need of it, and say so under `riskLeft`, not as a finding. A repository with none of these goes on without them: the failed read of its instruction file is no finding and no failure, and your body's line says `Rules read: none in this repository`.\n",
  "On a diff, your out doc's body starts with a line `Rules read:` that names each rule file, decision record and design page you read, or says `Rules read: none in this repository`. After it, and on a plan from its start, say what you read and what you checked through the lens.\n\n",
] as const;

/**
 * The `-bare` setups' Taster: the default's text without what tells it to read the rules, and no
 * other change (ADR 0347). A default that does not hold each cut once stops the comparison, as
 * `highTaster` does, since a later edit could otherwise compare nothing.
 */
export const bareTaster = (current: string): string =>
  BARE_CUTS.reduce((text, cut) => {
    if (text.split(cut).length !== 2) {
      throw new Error(
        `the default Taster does not hold this text once: bare would compare nothing: ${cut.slice(0, 80)}`,
      );
    }
    return text.replace(cut, () => '');
  }, current);

/** A comparison's name: letters, digits and `-`, starting with a letter or a digit, so it is one folder and no path. */
const COMPARISON = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * The folders of the real mode's records, below the comparisons' own: `real`, or `comparison`'s
 * folder in it, whose records, seed and lists are its own (ADR 0347).
 */
export const realFolders = (comparison: string | undefined): string[] => {
  if (comparison === undefined) return ['real'];
  if (!COMPARISON.test(comparison)) {
    throw new Error(
      `--comparison takes letters, digits and -, starting with a letter or a digit, as one folder's name, not "${comparison}"`,
    );
  }
  return ['real', comparison];
};

/** The `opus` setup's models.jsonc: over the default's aliases, it moves the Taster and no other brewer. */
const OPUS_MODELS = `${JSON.stringify({ models: { opus: 'opus' }, brewers: { taster: 'opus' } })}\n`;

/** The setups that put the Taster on Opus. */
const ON_OPUS: ReadonlySet<Profile | 'comments'> = new Set(['opus', 'opus-bare', 'opus-together']);

/** A setup's Taster text, when it replaces the default's. */
const tasterOf = (profile: Profile | 'comments', tasters: Tasters): string | undefined => {
  switch (profile) {
    case 'today':
      return tasters.today;
    case 'high':
      return highTaster(tasters.current);
    case 'opus-bare':
    case 'opus-together':
      return bareTaster(tasters.current);
    case 'high-bare':
      return highTaster(bareTaster(tasters.current));
    case 'reads':
    case 'lens':
    case 'opus':
    case 'comments':
      return undefined;
    default: {
      const never: never = profile;
      return never;
    }
  }
};

/**
 * The Brewery's files of a run of `setup` beyond Nip's: the recipe, and what its setup changes:
 * `today`'s Taster, the bare Taster, `high`'s effort or `opus`'s model.
 */
export const realBreweryFiles = (setup: RealSetup, tasters: Tasters): Record<string, string> => {
  const profile = profileOf(setup);
  const taster = tasterOf(profile, tasters);
  return {
    [`recipes/${realRecipeOf(setup)}.jsonc`]: realRecipeText(setup),
    ...(taster === undefined ? {} : { 'brewers/taster.md': taster }),
    ...(ON_OPUS.has(profile) ? { 'models.jsonc': OPUS_MODELS } : {}),
  };
};

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
  /** The models the session ran on, by what the model's own lines name. */
  models: readonly string[];
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
  message: z.looseObject({ content: z.unknown(), model: z.string().optional() }).optional(),
});

const blocksOf = (content: unknown): readonly unknown[] => (Array.isArray(content) ? content : []);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** What claude's own line for a failed call names as its model: it ran on none (ADR 0344). */
const NO_MODEL = '<synthetic>';

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
  const models = new Set<string>();
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
    if (type === 'assistant' && message?.model !== undefined && message.model !== NO_MODEL) {
      models.add(message.model);
    }
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
    models: [...models],
    ...(problem === undefined ? {} : { problem }),
    ...(body === '' ? {} : { body }),
  };
};

/**
 * A run's record from its store's events: how its batch ended, and its Tasters' attempts, each with
 * what its session's transcript says it read. A read outside its worktree fails the attempt, and so
 * does a transcript that cannot say, since the run would then be no measurement (ADR 0332). The
 * attempt's own failure stays its reason. Its models are the transcript's, which `modelStop` reads
 * and codes.md shows (ADR 0344).
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
              models: [],
              problem: 'its transcript could not be found, so what it read cannot be told',
            }
          : transcriptReads(transcript, session.worktree);
      const { opened, outside, refused, models, problem, body } = reads;
      const reached =
        outside.length === 0 ? undefined : `it read outside its worktree: ${outside.join(', ')}`;
      return {
        ...attempt,
        failure: attempt.failure ?? reached ?? problem,
        opened,
        outside,
        refused,
        models,
        ...(attempt.failure === undefined && problem !== undefined ? { unreadable: problem } : {}),
        ...(body === undefined ? {} : { body }),
      };
    }),
  };
};

/**
 * Why a run on a model its setup did not ask for must stop the comparison, or undefined: it is the
 * harness's fault, and every later run would be on it too (ADR 0344). An alias asks for a family, so
 * an id of that family is what was asked. A Taster that finished with no model named cannot say. An
 * attempt that failed by itself may have called no model, and is a failed run.
 */
export const modelStop = ({
  setup,
  attempts,
}: Pick<RealRecord, 'setup' | 'attempts'>): string | undefined => {
  const asked = ON_OPUS.has(profileOf(setup)) ? 'opus' : 'sonnet';
  for (const { stepId, failure, models = [] } of attempts) {
    const other = models.find((model) => !model.includes(asked));
    if (other !== undefined) {
      return escapeCell(`${stepId}: it ran on ${other}, and ${setup} asks for ${asked}`);
    }
    if (models.length === 0 && failure === undefined) {
      return escapeCell(`${stepId}: its transcript names no model, and ${setup} asks for ${asked}`);
    }
  }
  return undefined;
};

/**
 * Why the comparison must stop, or undefined: a transcript that cannot say, or another model, is the
 * harness's, not the Taster's, so running on would spend sessions on nothing (ADR 0332, ADR 0344). A
 * read outside fails only its run.
 */
export const comparisonStop = (
  record: Pick<RealRecord, 'setup' | 'attempts'>,
): string | undefined => {
  const lost = record.attempts.find(({ unreadable }) => unreadable !== undefined);
  return lost === undefined ? modelStop(record) : escapeCell(`${lost.stepId}: ${lost.unreadable}`);
};

/** The next run to brew (`nextRunOf`). */
export const nextRealRun = (
  records: readonly RealRecord[],
  runs: number,
  setups: readonly RealSetup[] = REAL_SETUPS,
) => nextRunOf(setups, records, runs, runFailure);

/** A run's code under `seed`: it says nothing of the run without the seed. */
export const codeOf = (seed: string, setup: RealSetup, run: number): string =>
  createHmac('sha256', seed).update(`${setup}/${run}`).digest('hex').slice(0, 8);

/** Each Taster of a run in the recipe's order, so the order they finished in says nothing. */
const inRecipeOrder = (attempts: readonly TasterAttempt[]): TasterAttempt[] => {
  const place = (stepId: string): number => LENS_TASTERS.findIndex(({ id }) => id === stepId);
  return [...attempts].sort((a, b) => place(a.stepId) - place(b.stepId));
};

/**
 * A Taster of several lenses as one Taster per lens, for the lists only, so a run tasted together
 * reads as one tasted apart (ADR 0347): each finding under the lens it names, each risk under the
 * lens it starts with, without it, and what names none of them under the step's first lens.
 */
const perLens = (attempt: TasterAttempt): TasterAttempt[] => {
  const { lenses, findings, riskLeft = [] } = attempt;
  const [first] = lenses;
  if (first === undefined || lenses.length === 1) return [attempt];
  const lensOf = (named: string | undefined): string =>
    named !== undefined && lenses.includes(named) ? named : first;
  const risks = riskLeft.map((risk) => {
    const lens = lenses.find((each) => risk.startsWith(`${each}:`));
    return lens === undefined
      ? { lens: first, risk }
      : { lens, risk: risk.slice(lens.length + 1).trim() };
  });
  return lenses.map((lens) => ({
    ...attempt,
    stepId: stepIdOf(lens),
    lenses: [lens],
    findings: findings.filter((finding) => lensOf(finding.lens) === lens),
    riskLeft: risks.filter((each) => each.lens === lens).map(({ risk }) => risk),
  }));
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
    const runsWith = (
      lines: (attempt: TasterAttempt) => string[],
      split: (attempt: TasterAttempt) => TasterAttempt[] = (attempt) => [attempt],
    ): string[] =>
      scored.flatMap(({ code, record }) => [
        `## Run ${code}`,
        '',
        ...inRecipeOrder(record.attempts.flatMap(split)).flatMap(lines),
      ]);
    lists[String(order)] = `${[
      `# Order #${order}: ${scored.length} runs to score`,
      '',
      'Each run has a code of its own. Open codes.md only once they are scored.',
      '',
      ...runsWith(tasterLines, perLens),
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

/** The instruction files a Taster may open at its worktree's root (`defaults/brewers/taster.md`). */
const INSTRUCTION_FILES: readonly string[] = ['CLAUDE.md', 'AGENTS.md'];

/**
 * What the comparison prints: each setup's runs to score, failed and retried, since a setup that
 * retries more is a finding in itself, and how many Tasters of its scored runs opened the
 * instruction file, which a bare Taster may do by itself (ADR 0347). It holds no code, so it
 * unblinds no list.
 */
export const realTable = (records: readonly RealRecord[]): string => {
  const rows = REAL_SETUPS.map((setup) => {
    const { scored, failed } = runsOfSetup(records, setup, runFailure);
    const retried = records.filter((each) => each.setup === setup && each.retry === true).length;
    const tasters = scored.flatMap(({ attempts }) => attempts);
    const read = tasters.filter(({ opened = [] }) =>
      opened.some((file) => INSTRUCTION_FILES.includes(file)),
    ).length;
    return `| ${setup} | ${scored.length} | ${failed.length} | ${retried} | ${read} of ${tasters.length} |`;
  });
  return `${[
    '| Setup | Runs to score | Failed goes | Retried | Opened the instruction file |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    'Score lists/<order>.md by hand, then read bodies/<order>.md, then open codes.md, which says which setup each code is.',
  ].join('\n')}\n`;
};

/**
 * The dry run's Tasters: a scripted finding on `file` and a risk left per lens, and nothing of any
 * key. The together Taster's findings each name their lens, as its out doc's schema asks (ADR 0220).
 */
export const scriptedRealTastings = (file: string): Record<string, readonly Scripted[]> =>
  Object.fromEntries(
    [...LENS_TASTERS.map(({ id, lens }) => ({ id, lenses: [lens] })), TOGETHER].map(
      ({ id, lenses }) => [
        id,
        [
          {
            files: {},
            message: '',
            summary: `The dry run's scripted Taster through ${lenses.join(', ')}.`,
            tasting: {
              verdict: 'approve' as const,
              findings: lenses.map((lens) => ({
                ...(lenses.length === 1 ? {} : { lens }),
                file,
                line: 1,
                severity: 'minor',
                why: `scripted by the dry run, through ${lens}`,
                introduced: true,
              })),
            },
            doc: {
              riskLeft: lenses.map(
                (lens) =>
                  `${lenses.length === 1 ? '' : `${lens}: `}scripted by the dry run: a risk left through ${lens}`,
              ),
            },
          },
        ],
      ],
    ),
  );

/**
 * The transcript of a dry run's Taster on `model`, the one its attempt was planned with: it reads a
 * file of its worktree and writes its out doc.
 */
export const scriptedTranscript = (worktree: string, model: string): string =>
  [
    ['Read', { file_path: join(worktree, 'CLAUDE.md') }],
    ['Edit', { file_path: join(worktree, 'taste.md'), old_string: '', new_string: 'scripted' }],
  ]
    .flatMap(([name, input], at) => [
      JSON.stringify({
        type: 'assistant',
        message: { model, content: [{ type: 'tool_use', id: `scripted-${at}`, name, input }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: `scripted-${at}` }] },
      }),
    ])
    .join('\n');
