// The decisions of node scripts/tasting-compare.ts --real (#879, ADR 0332): the brewed heads and the
// setups, the recipe and the Brewery's files of a run, a head's changed files, what a Taster's
// transcript says it read, a run's record, and the blinded lists. It scores nothing: a person does,
// against a key that stays out of the repository. Nothing here starts a process.

import { createHmac } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fold } from '../../src/engine/fold.ts';
import { withoutSecrets } from '../../src/engine/out-doc-text.ts';
import { planEntryText } from '../../src/engine/plan-comment.ts';
import { pathInside } from '../../src/platform/paths.ts';
import { ClaudeToolResult, ClaudeToolUse } from '../../src/schemas/claude-stream.ts';
import type { Event, GravityReading, Usage } from '../../src/schemas/events.ts';
import { Effort, ModelId } from '../../src/schemas/models.ts';
import { planOf } from '../../src/schemas/plan.ts';
import { z } from '../../src/schemas/zod.ts';
import type { FakeApiComment } from '../../test/helpers/fake-github-api.ts';
import type { Scripted } from '../../test/helpers/nip-fixture.ts';
import { TARGET } from '../demo/core.ts';
import {
  backTo,
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
/**
 * The Taster every setup but `today`, `nip`, `deep` and `apart7` starts from, in the real fixture's folder: the default's text
 * before ADR 0352, the last that told a diff Taster to read the rules, so each setup means what it
 * meant when it was measured.
 */
export const READS_TASTER = 'taster-reads.md';

type OrderNumber = (typeof REAL_ORDERS)[number]['order'];
type Profile =
  | 'today'
  | 'reads'
  | 'lens'
  | 'opus'
  | 'high'
  | 'opus-bare'
  | 'high-bare'
  | 'opus-together'
  | 'high-together'
  | 'nip'
  | 'deep'
  | 'apart7';
const PROFILES: readonly Profile[] = [
  'today',
  'reads',
  'lens',
  'opus',
  'high',
  'opus-bare',
  'high-bare',
  'opus-together',
  'high-together',
  'nip',
  'deep',
  'apart7',
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

/**
 * The setups `--setups` names, by the part of a setup's name after its order, of the orders
 * `--orders` names, or of every order without it (ADR 0366).
 */
export const selectRealSetups = (names: string, orders?: string): readonly RealSetup[] => {
  const known = [...PROFILES, 'comments'];
  const chosen = names.split(',');
  const unknown = chosen.find((name) => !known.includes(name));
  if (unknown !== undefined) {
    throw new Error(`--setups names no setup "${unknown}": it knows ${known.join(', ')}`);
  }
  const only = chosenOrders(orders);
  return REAL_SETUPS.filter(
    (setup) =>
      chosen.includes(profileOf(setup)) &&
      (only === undefined || only.includes(String(orderOf(setup).order))),
  );
};

/** The orders `--orders` names, or undefined without it; throws on an order it does not know. */
const chosenOrders = (orders: string | undefined): string[] | undefined => {
  const numbers = REAL_ORDERS.map(({ order }) => String(order));
  const only = orders?.split(',');
  const stranger = only?.find((order) => !numbers.includes(order));
  if (stranger !== undefined) {
    throw new Error(`--orders names no order "${stranger}": it knows ${numbers.join(', ')}`);
  }
  return only;
};

/** The orders `--orders` names, or every order without it. */
const realOrdersOf = (orders?: string) => {
  const only = chosenOrders(orders);
  return REAL_ORDERS.filter(({ order }) => only === undefined || only.includes(String(order)));
};

/** A setup's name after its order: its profile, or `comments`. */
const profileOf = (setup: RealSetup): Profile | 'comments' =>
  setup.slice(setup.indexOf('-') + 1) as Profile | 'comments';

/** The order `setup` tastes. */
export const orderOf = (
  setup: RealSetup | BrewerSetup | PlannerSetup,
): (typeof REAL_ORDERS)[number] => {
  const number = Number(setup.slice(0, setup.indexOf('-')));
  const found = REAL_ORDERS.find(({ order }) => order === number);
  if (found === undefined) throw new Error(`no order for the setup ${setup}`);
  return found;
};

/** The recipe of every setup but `lens`, the together setups, `nip`, `deep` and `apart7`. */
export const REAL_RECIPE = 'real-nip';
/** The recipe of the `lens` setup (ADR 0337). */
const REAL_LENS_RECIPE = 'real-nip-lens';
/** The recipe of the `opus-together` and `high-together` setups (ADR 0347, ADR 0348). */
const REAL_TOGETHER_RECIPE = 'real-nip-together';
/** The recipe of the `nip` setup: `nip`'s tasting as it ships (ADR 0366). */
const REAL_SHIPPED_NIP_RECIPE = 'real-nip-shipped';
/** The recipe of the `deep` setup: `deep-brew`'s tasting as it ships (ADR 0366). */
const REAL_DEEP_RECIPE = 'real-deep-brew';
/** The recipe of the `apart7` setup: `nip`'s tasting as it ships and the other three diff lenses apart (ADR 0366). */
const REAL_APART7_RECIPE = 'real-nip-apart7';

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
/** The together setups' one Taster: `real-nip`'s three lenses in one step (ADR 0220, ADR 0347, ADR 0348). */
const TOGETHER = {
  id: 'together',
  brewer: 'taster',
  lenses: TASTERS.map(({ lens }) => lens),
} as const;
/**
 * The `nip` setup's Tasters: `defaults/recipes/nip.jsonc`'s taste group as it ships, efforts and
 * all; a test holds them to that file (ADR 0366).
 */
const SHIPPED_NIP_TASTERS = [
  { ...LENS_TASTERS[0], effort: 'careful', everyRound: true },
  { ...LENS_TASTERS[1], effort: 'careful' },
  { ...LENS_TASTERS[2], effort: 'careful' },
  LENS_TASTERS[3],
] as const;
/**
 * The `deep` setup's one Taster: `defaults/recipes/deep-brew.jsonc`'s taste step as it ships, every
 * diff lens on the strong level; a test holds it to that file (ADR 0366).
 */
const DEEP = {
  id: 'deep',
  brewer: 'taster',
  model: 'strong',
  lenses: [
    'diff/correctness',
    'diff/acceptance',
    'diff/security',
    'diff/design-conformance',
    'diff/test-design',
    'diff/necessity',
    'diff/cross-platform',
  ],
} as const;
/**
 * The `apart7` setup's Tasters: `nip`'s as it ships, then the three diff lenses `nip` has not, each a
 * Taster of its own at the Taster's own effort (ADR 0366).
 */
const APART7_TASTERS = [
  ...SHIPPED_NIP_TASTERS,
  { id: 'test-design', brewer: 'taster', lens: 'diff/test-design' },
  { id: 'cross-platform', brewer: 'taster', lens: 'diff/cross-platform' },
  { id: 'necessity', brewer: 'taster', lens: 'diff/necessity' },
] as const;
/** The Tasters of one lens each, in every setup's recipe. */
const ONE_LENS = [...LENS_TASTERS, ...APART7_TASTERS.slice(SHIPPED_NIP_TASTERS.length)];
const STEPS: ReadonlyMap<string, readonly string[]> = new Map([
  ...ONE_LENS.map(({ id, lens }): [string, readonly string[]] => [id, [lens]]),
  [TOGETHER.id, TOGETHER.lenses],
  [DEEP.id, DEEP.lenses],
]);

/** The recipe a run of `setup` brews. */
export const realRecipeOf = (setup: RealSetup): string => {
  const profile = profileOf(setup);
  if (profile === 'lens') return REAL_LENS_RECIPE;
  if (profile === 'nip') return REAL_SHIPPED_NIP_RECIPE;
  if (profile === 'deep') return REAL_DEEP_RECIPE;
  if (profile === 'apart7') return REAL_APART7_RECIPE;
  return profile.endsWith('-together') ? REAL_TOGETHER_RECIPE : REAL_RECIPE;
};

/** Each recipe's description and its Taster step. */
const RECIPES: Record<string, { description: string; taste: Record<string, unknown> }> = {
  [REAL_RECIPE]: {
    description:
      'A head as it was brewed, tasted by correctness, acceptance and security, one round tasted',
    taste: { id: TASTE, parallel: TASTERS, ...backTo(IMPLEMENT) },
  },
  [REAL_LENS_RECIPE]: {
    description:
      'A head as it was brewed, tasted by correctness, acceptance, security and design conformance, one round tasted',
    taste: { id: TASTE, parallel: LENS_TASTERS, ...backTo(IMPLEMENT) },
  },
  [REAL_TOGETHER_RECIPE]: {
    description:
      'A head as it was brewed, tasted by correctness, acceptance and security together in one Taster, one round tasted',
    taste: { ...TOGETHER, ...backTo(IMPLEMENT) },
  },
  [REAL_SHIPPED_NIP_RECIPE]: {
    description: 'A head as it was brewed, tasted as nip ships its four Tasters, one round tasted',
    taste: { id: TASTE, parallel: SHIPPED_NIP_TASTERS, ...backTo(IMPLEMENT) },
  },
  [REAL_DEEP_RECIPE]: {
    description:
      'A head as it was brewed, tasted as deep-brew ships its one Taster of every diff lens, one round tasted',
    taste: { ...DEEP, ...backTo(IMPLEMENT) },
  },
  [REAL_APART7_RECIPE]: {
    description:
      'A head as it was brewed, tasted as nip ships its four Tasters and by test design, cross-platform and necessity apart, one round tasted',
    taste: { id: TASTE, parallel: APART7_TASTERS, ...backTo(IMPLEMENT) },
  },
};

/**
 * The scripted implementer, `setup`'s Tasters, whose findings send the batch back to it, and its
 * next turn ends the run after that first round (ADR 0354), and the pull request a recipe that
 * commits must open (ADR 0084). No check runs, and the Gauger is skipped as
 * testFirst off skips it (ADR 0224).
 */
export const realRecipeText = (setup: RealSetup): string => {
  const name = realRecipeOf(setup);
  const { description, taste } = RECIPES[name] ?? { description: '', taste: {} };
  const recipe = {
    name,
    type: 'brew',
    description,
    guidance: {
      chooseWhen: 'A brewed head, tasted again to compare setups',
      notWhen: 'Any new order',
      bestUsed: 'Through node scripts/tasting-compare.ts --real',
    },
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
  /** The Taster that reads the rules, the fixture's `READS_TASTER` (ADR 0352). */
  reads: string;
}

const MEDIUM_EFFORT = '"effort": "steady"';

/** The `high` setup's Taster: the reading Taster's text at another effort, and no other change. */
export const highTaster = (reads: string): string => {
  if (reads.split(MEDIUM_EFFORT).length !== 2) {
    throw new Error(
      `the reading Taster does not say ${MEDIUM_EFFORT} once: high would compare nothing`,
    );
  }
  return reads.replace(MEDIUM_EFFORT, () => '"effort": "careful"');
};

/**
 * What the `-bare` Taster leaves out of the reading Taster's text, each once (ADR 0347): the first bullet,
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
 * The `-bare` setups' Taster: the reading Taster's text without what tells it to read the rules, and
 * no other change (ADR 0347). A text that does not hold each cut once stops the comparison, as
 * `highTaster` does, since a later edit could otherwise compare nothing.
 */
export const bareTaster = (reads: string): string =>
  BARE_CUTS.reduce((text, cut) => {
    if (text.split(cut).length !== 2) {
      throw new Error(
        `the reading Taster does not hold this text once: bare would compare nothing: ${cut.slice(0, 80)}`,
      );
    }
    return text.replace(cut, () => '');
  }, reads);

/**
 * A comparison's name: lower-case letters, digits and `-`, starting with a letter or a digit, so it
 * is one folder and no path, and two names are never one folder on a file system that ignores case.
 */
const COMPARISON = /^[a-z0-9][a-z0-9-]*$/;
/** The names Windows keeps for its devices, which no folder can have. */
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/**
 * The folders of the real mode's records, below the comparisons' own: `real`, or `comparison`'s
 * folder in `real/comparisons`, apart from every folder the plain run keeps, whose records, seed
 * and lists are its own (ADR 0347).
 */
export const realFolders = (comparison: string | undefined): string[] => {
  if (comparison === undefined) return ['real'];
  if (!COMPARISON.test(comparison) || DEVICE.test(comparison)) {
    throw new Error(
      `--comparison takes lower-case letters, digits and -, starting with a letter or a digit, as one folder's name and no Windows device's, not "${comparison}"`,
    );
  }
  return ['real', 'comparisons', comparison];
};

/** The `opus` setup's models.jsonc: it swaps the Taster to the default's strong level, Opus, and no other brewer. */
const OPUS_MODELS = `${JSON.stringify({ brewers: { taster: 'strong' } })}\n`;

/** The setups that put the Taster on Opus. */
const ON_OPUS: ReadonlySet<Profile | 'comments'> = new Set(['opus', 'opus-bare', 'opus-together']);
/** The setups whose Taster asks for Opus, by models.jsonc or by its step's own level (ADR 0366). */
const ASKS_OPUS: ReadonlySet<Profile | 'comments'> = new Set([...ON_OPUS, 'deep']);
/** The setups that taste with the default Taster as it ships, not a pinned text (ADR 0366). */
const SHIPPED: ReadonlySet<Profile | 'comments'> = new Set(['nip', 'deep', 'apart7']);

/**
 * A setup's Taster text, which replaces the default's: since ADR 0352 the default reads no rules, so
 * the setups that tasted with it then taste the reading Taster.
 */
const tasterOf = (profile: Profile | 'comments', tasters: Tasters): string => {
  switch (profile) {
    case 'nip':
    case 'deep':
    case 'apart7':
      throw new Error(`the ${profile} setup tastes with the default Taster, not a text of its own`);
    case 'today':
      return tasters.today;
    case 'high':
      return highTaster(tasters.reads);
    case 'opus-bare':
    case 'opus-together':
      return bareTaster(tasters.reads);
    case 'high-bare':
    case 'high-together':
      return highTaster(bareTaster(tasters.reads));
    case 'reads':
    case 'lens':
    case 'opus':
    case 'comments':
      return tasters.reads;
    default: {
      const never: never = profile;
      return never;
    }
  }
};

/**
 * The Brewery's files of a run of `setup` beyond Nip's: the recipe, its Taster, and what its setup
 * changes: `today`'s Taster, the bare Taster, `high`'s effort or `opus`'s model.
 */
export const realBreweryFiles = (setup: RealSetup, tasters: Tasters): Record<string, string> => {
  const profile = profileOf(setup);
  return {
    [`recipes/${realRecipeOf(setup)}.jsonc`]: realRecipeText(setup),
    ...(SHIPPED.has(profile) ? {} : { 'brewers/taster.md': tasterOf(profile, tasters) }),
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

/** Throws when `today`'s pinned Taster is the reading Taster's text: the comparison would be of nothing. */
export const refuseSameTaster = (today: string, reads: string): void => {
  const lines = (text: string): string => text.replaceAll('\r\n', '\n');
  if (lines(today) === lines(reads)) {
    throw new Error(
      `the Taster at ${TODAY_COMMIT} and the reading Taster are the same Taster: the setups would compare nothing`,
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
 * harness's fault, and every later run would be on it too (ADR 0344). A family such as opus asks for any id that holds it, so
 * an id of that family is what was asked. A Taster that finished with no model named cannot say. An
 * attempt that failed by itself may have called no model, and is a failed run.
 */
export const modelStop = ({
  setup,
  attempts,
}: Pick<RealRecord, 'setup' | 'attempts'>): string | undefined => {
  const asked = ASKS_OPUS.has(profileOf(setup)) ? 'opus' : 'sonnet';
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
export const codeOf = (seed: string, setup: string, run: number): string =>
  createHmac('sha256', seed).update(`${setup}/${run}`).digest('hex').slice(0, 8);

/**
 * Each Taster of a run in deep-brew's lens order, nip's four first, so neither the order they
 * finished in nor the setup's own recipe order says anything (ADR 0366).
 */
const inRecipeOrder = (attempts: readonly TasterAttempt[]): TasterAttempt[] => {
  const place = (stepId: string): number =>
    DEEP.lenses.findIndex((lens) => stepIdOf(lens) === stepId);
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

/**
 * The instruction files a Taster may open at its worktree's root (`defaults/brewers/taster.md`), in
 * lower case: Windows and macOS open them by a path in any case.
 */
const INSTRUCTION_FILES: readonly string[] = ['claude.md', 'agents.md'];

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
      opened.some((file) => INSTRUCTION_FILES.includes(file.toLowerCase())),
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
    [
      ...LENS_TASTERS.map(({ id, lens }) => ({ id, lenses: [lens] })),
      TOGETHER,
      DEEP,
      ...ONE_LENS.slice(LENS_TASTERS.length).map(({ id, lens }) => ({ id, lenses: [lens] })),
    ].map(({ id, lenses }) => [
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
    ]),
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

/** The brewers `--brewer` runs for real (ADR 0394). */
export const MEASURED_BREWERS = ['cellarman'] as const;
export type MeasuredBrewer = (typeof MEASURED_BREWERS)[number];

/**
 * A real brewer's run settings: which brewer, on which model, at which effort (ADR 0394), and
 * `plan` when it starts from the Brewmaster's kept sub-order, not the order's own text (ADR 0396).
 */
export interface BrewerSettings {
  brewer: MeasuredBrewer;
  model: string;
  effort: Effort;
  orderText?: 'plan';
}

/** One order brewed by a real brewer on a model and effort: the order first, as a setup's name. */
export type BrewerSetup = `${OrderNumber}-${MeasuredBrewer}-${string}`;

/** The recipe of a real Cellarman's run (ADR 0394). */
export const REAL_BREWER_RECIPE = 'real-brew-cellarman';

/**
 * The level the measured brewer's step names, which the run's models.jsonc maps to the given model:
 * no other step of its recipe runs on it (ADR 0397).
 */
const MEASURED = 'strong';

/** The settings `--brewer`, `--model` and `--effort` give, or undefined without them; throws on a wrong combination. */
export const brewerSettingsOf = (given: {
  real?: boolean;
  brewer?: string;
  model?: string;
  effort?: string;
  setups?: string;
  orderText?: string;
}): BrewerSettings | undefined => {
  const { real, brewer, model, effort, setups, orderText } = given;
  if (brewer === undefined) {
    if (model !== undefined || effort !== undefined) {
      throw new Error('--model and --effort set the brewer --brewer names: give --brewer too');
    }
    if (orderText !== undefined) {
      throw new Error(
        '--order-text chooses the text a --brewer run starts from: give --brewer too',
      );
    }
    return undefined;
  }
  if (real !== true) throw new Error('--brewer runs a brewer of --real for real: give --real too');
  if (setups !== undefined) {
    throw new Error('--setups chooses Taster setups and --brewer a brewer run: give one of them');
  }
  const measured = MEASURED_BREWERS.find((each) => each === brewer);
  if (measured === undefined) {
    throw new Error(`--brewer takes ${MEASURED_BREWERS.join(', ')}, not "${brewer}"`);
  }
  if (model === undefined) throw new Error(`--brewer ${brewer} needs --model <id>`);
  if (effort === undefined) throw new Error(`--brewer ${brewer} needs --effort <effort>`);
  if (!ModelId.safeParse(model).success) {
    throw new Error(
      `--model takes a model id models.jsonc accepts, such as claude-sonnet-5-5, not "${model}"`,
    );
  }
  const parsed = Effort.safeParse(effort);
  if (!parsed.success) {
    throw new Error(`--effort takes one of ${Effort.options.join(', ')}, not "${effort}"`);
  }
  if (orderText !== undefined && orderText !== 'issue' && orderText !== 'plan') {
    throw new Error(`--order-text takes issue, plan, not "${orderText}"`);
  }
  return {
    brewer: measured,
    model,
    effort: parsed.data,
    ...(orderText === 'plan' ? { orderText } : {}),
  };
};

/** The setups of a brewer's runs, one per order, of the orders `--orders` names or of every order. */
export const brewerSetups = (settings: BrewerSettings, orders?: string): BrewerSetup[] =>
  realOrdersOf(orders).map(
    ({ order }): BrewerSetup =>
      `${order}-${settings.brewer}-${settings.model}-${settings.effort}${settings.orderText === 'plan' ? PLAN_TEXT : ''}`,
  );

/** A run's scratch folder name: a setup's name with what Windows refuses in a folder's name replaced. */
export const scratchNameOf = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '_');

/** The folder of a head's test files, which the scripted Gauger commits (ADR 0394). */
const TESTS = 'test/';

/** The head's files: its test files, which the scripted Gauger commits, and the rest, Cellarman's. */
export const splitHead = (changed: readonly string[]): { tests: string[]; code: string[] } => {
  const tests = changed.filter((path) => path.startsWith(TESTS));
  const code = changed.filter((path) => !path.startsWith(TESTS));
  if (tests.length === 0) throw new Error(`the head changes no test file under ${TESTS}`);
  if (code.length === 0) throw new Error(`the head changes nothing but tests under ${TESTS}`);
  return { tests, code };
};

/** git's arguments for the code a run wrote: its diff from `base` to `commit`, past the head's test files. */
export const codeDiffArgs = (base: string, commit: string): string[] => [
  'diff',
  '--no-renames',
  base,
  commit,
  '--',
  '.',
  `:(exclude)${TESTS}`,
];

/** The checks of the green step, every check the repository names. */
const GREEN_CHECKS = ['build', 'typecheck', 'lint', 'format', 'test'] as const;

/**
 * The recipe of a real Cellarman's runs: the scripted Gauger's tests, Cellarman on the measured
 * level and the given effort, the repository's checks, sent back to Cellarman once, and the pull request a
 * recipe that commits must open (ADR 0084). Not test-first, so no red proof runs and the
 * repository needs no test map (ADR 0394).
 */
export const brewerRecipeText = (settings: BrewerSettings): string => {
  const recipe = {
    name: REAL_BREWER_RECIPE,
    type: 'brew',
    description: "A head's tests as brewed, then a real Cellarman on a model and effort given",
    guidance: {
      chooseWhen: 'A brewed head, built again by a real brewer to compare models',
      notWhen: 'Any new order',
      bestUsed: 'Through node scripts/tasting-compare.ts --real --brewer',
    },
    testFirst: false,
    steps: [
      { id: 'gauge', brewer: 'gauger' },
      { id: IMPLEMENT, brewer: settings.brewer, model: MEASURED, effort: settings.effort },
      {
        id: 'green',
        check: GREEN_CHECKS,
        deadline: '30m',
        onFail: { goto: IMPLEMENT, maxRounds: 1 },
      },
      { action: 'openPullRequest' },
    ],
  };
  return `// node scripts/tasting-compare.ts --real --brewer's recipe (ADR 0394).\n${JSON.stringify(recipe, null, 2)}\n`;
};

/**
 * Foedrum's own checks, after its setup installs the base's dependencies in the check step's
 * worktree; `npm run check` runs the test files the change reaches from the base (ADR 0394).
 */
const FOEDRUM_REPOSITORY = {
  setup: { command: 'npm ci', timeout: '10m' },
  checks: {
    build: null,
    typecheck: 'npm run typecheck',
    lint: 'npm run lint',
    format: null,
    test: 'npm run check',
  },
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The Brewery's files of a real Cellarman's run beyond Nip's: its recipe, models.jsonc and foedrum.jsonc. */
export const brewerBreweryFiles = (
  settings: BrewerSettings,
  names: { brewery: string; target: string; user: string },
): Record<string, string> => ({
  [`recipes/${REAL_BREWER_RECIPE}.jsonc`]: brewerRecipeText(settings),
  'models.jsonc': json({ claude: { models: { [MEASURED]: settings.model } } }),
  'foedrum.jsonc': json({
    brewery: names.brewery,
    users: [names.user],
    repositories: { [names.target]: FOEDRUM_REPOSITORY },
  }),
});

/** A head as the scripted brewers play it: its commit, subject and files, by path. */
export interface BrewedHead {
  head: string;
  subject: string;
  tests: Record<string, string>;
  code: Record<string, string>;
}

/** What the scripted brewers of a brewer's run play: the Gauger always, Cellarman on a dry run. */
export const brewerScript = (
  head: BrewedHead,
  dryRun: boolean,
): Record<string, readonly Scripted[]> => ({
  gauge: [
    {
      files: head.tests,
      message: `Test ${head.subject}`,
      summary: `The test files of ${head.head}, committed as they were brewed: ${Object.keys(head.tests).join(', ')}.`,
    },
  ],
  ...(dryRun
    ? {
        [IMPLEMENT]: [
          {
            files: head.code,
            message: head.subject,
            summary: `The dry run's scripted Cellarman: the code of ${head.head}, committed as it was brewed.`,
          },
        ],
      }
    : {}),
});

/** One step of a brewer's run: its attempts, and the tokens, turns and time of its sessions. */
export interface StepRun {
  stepId: string;
  attempts: number;
  usage?: Usage;
  turns: number;
  durationMs: number;
}

/** What a brewer's run measured (ADR 0394). */
export interface BrewerRun extends BrewerSettings {
  /** Whether the green step's last attempt passed. */
  checksPassed: boolean;
  /** Its last green attempt's readings, one line each. */
  checks: readonly string[];
  steps: readonly StepRun[];
  /** The models the brewer's transcripts name. */
  models: readonly string[];
  /** Why a transcript of the brewer cannot say its model. */
  unreadable?: string;
  /** The commit the checks read last: the brewer's code. */
  commit?: string;
  /** The code's diff from the base, without the head's test files. */
  diff?: string;
}

export type BrewerRecord = RunRecord<BrewerSetup> & { brewer: BrewerRun };

/** A reading as one line: its check, or the setup, and how it ended. */
const readingLine = (reading: GravityReading): string => {
  const name = reading.check ?? ('setup' in reading ? 'setup' : 'command');
  switch (reading.result) {
    case 'exited':
      return `${name}: exited ${reading.exitCode}`;
    case 'killed':
      return `${name}: killed, ${reading.killed}`;
    case 'signaled':
      return `${name}: ended on ${reading.signal}`;
    case 'skipped':
    case 'unstarted':
      return `${name}: ${reading.result}`;
    default: {
      const never: never = reading;
      return never;
    }
  }
};

const sumUsage = (a: Usage | undefined, b: Usage | undefined): Usage | undefined =>
  a === undefined || b === undefined
    ? (a ?? b)
    : {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
      };

/**
 * A brewer's run's record from its store's events: how its batch ended; each step's attempts,
 * tokens, turns and time; the green step's last readings and the commit it read, which is the
 * brewer's code; and the models the brewer's transcripts name (ADR 0344, ADR 0394).
 */
export const brewerRecordOf = (
  events: readonly { event: Event }[],
  settings: BrewerSettings,
  transcriptOf: (sessionId: string, worktree: string) => string | undefined,
): Pick<BrewerRecord, 'ended' | 'attempts' | 'brewer'> => {
  const { ended } = recordIn(events, new Map());
  const steps = new Map<string, StepRun>();
  let commit: string | undefined;
  let green: { passed: boolean; checks: string[] } = { passed: false, checks: [] };
  for (const { event } of events) {
    if (event.type === 'step.started') {
      if (event.stepId === 'green' && event.worktree !== undefined) commit = event.worktree.commit;
    } else if (event.type === 'step.finished') {
      const { stepId, usage, receipt } = event;
      const step = steps.get(stepId) ?? { stepId, attempts: 0, turns: 0, durationMs: 0 };
      const summed = sumUsage(step.usage, usage);
      steps.set(stepId, {
        stepId,
        attempts: step.attempts + 1,
        ...(summed === undefined ? {} : { usage: summed }),
        turns: step.turns + (receipt?.turns ?? 0),
        durationMs: step.durationMs + (receipt?.durationMs ?? 0),
      });
      if (stepId === 'green') {
        green = {
          passed: event.outcome.kind === 'succeeded',
          checks: (event.readings ?? []).map(readingLine),
        };
      }
    }
  }
  return {
    ended,
    attempts: [],
    brewer: {
      ...settings,
      checksPassed: green.passed,
      checks: green.checks,
      steps: [...steps.values()],
      ...stepModels(events, IMPLEMENT, transcriptOf),
      ...(commit === undefined ? {} : { commit }),
    },
  };
};

/**
 * Why a brewer's run measured nothing, or undefined: no code of its brewer reached the checks. A
 * run whose checks failed measured the code all the same (ADR 0394).
 */
export const brewerFailure = ({
  ended,
  brewer,
}: Pick<BrewerRecord, 'ended' | 'brewer'>): string | undefined =>
  brewer.commit === undefined
    ? `the batch ended ${ended} before the checks read any code of ${brewer.brewer}`
    : undefined;

/**
 * Why the comparison must stop after a brewer's run, or undefined: a transcript that cannot say,
 * or a model the run did not ask for, is the harness's, so every later run would be too (ADR 0344).
 * A family, a name with no `-` such as `opus`, asks for any id that holds it; an id asks for itself
 * or a dated snapshot of it, never for another id it starts; `[1m]` is no part of the name a
 * transcript gives.
 */
export const brewerStop = ({
  setup,
  brewer,
}: Pick<BrewerRecord, 'setup' | 'brewer'>): string | undefined => {
  if (brewer.unreadable !== undefined) return escapeCell(brewer.unreadable);
  const asked = brewer.model.replace(/\[1m\]$/, '');
  // A dry run's scripted transcript names the model as planned, `[1m]` and all.
  const nameOf = (model: string): string => model.replace(/\[1m\]$/, '');
  const isAsked = (model: string): boolean =>
    asked.includes('-')
      ? model === asked ||
        (model.startsWith(`${asked}-`) && /^\d{8}$/.test(model.slice(asked.length + 1)))
      : model.includes(asked);
  const other = brewer.models.find((model) => !isAsked(nameOf(model)));
  return other === undefined
    ? undefined
    : escapeCell(`${IMPLEMENT}: it ran on ${other}, and ${setup} asks for ${asked}`);
};

/** The next brewer's run to brew (`nextRunOf`). */
export const nextBrewerRun = (
  records: readonly BrewerRecord[],
  runs: number,
  setups: readonly BrewerSetup[],
) => nextRunOf(setups, records, runs, brewerFailure);

/** A fence longer than any run of backticks in `text`, so no line of it closes the block. */
const fenceOf = (text: string): string =>
  '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(([run]) => run.length + 1)));

/** The setups a brewer's records hold, in the order they first came. */
const setupsIn = (records: readonly BrewerRecord[]): BrewerSetup[] => [
  ...new Set(records.map(({ setup }) => setup)),
];

const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;

const brewerRow = (code: string, { setup, run, wallMs, brewer }: BrewerRecord): string => {
  const usage = brewer.steps.reduce<Usage | undefined>(
    (sum, { usage }) => sumUsage(sum, usage),
    undefined,
  );
  const tokens =
    usage === undefined
      ? '- | - | - | - | -'
      : `${usage.inputTokens} | ${usage.outputTokens} | ${usage.cacheReadTokens} | ${usage.cacheWriteTokens} | ${usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens}`;
  const rounds = brewer.steps.map(({ stepId, attempts }) => `${stepId} ${attempts}`).join(', ');
  const turns = brewer.steps.reduce((sum, { turns }) => sum + turns, 0);
  const time = brewer.steps.reduce((sum, { durationMs }) => sum + durationMs, 0);
  return `| ${code} | ${setup} | ${run} | ${escapeCell(brewer.model)} | ${brewer.effort} | ${brewer.orderText ?? 'issue'} | ${brewer.checksPassed ? 'passed' : 'failed'} | ${rounds} | ${tokens} | ${turns} | ${seconds(time)} | ${seconds(wallMs)} |`;
};

/**
 * One list per order of the code its runs wrote, each run's diff under its code and sorted by it,
 * and the one file that names the setups: each code's setup, model, effort, checks, rounds,
 * tokens and time, and the runs that measured nothing. Nothing here says which code is right.
 */
export const brewerBlinded = (
  records: readonly BrewerRecord[],
  seed: string,
): { lists: Record<string, string>; codes: string } => {
  const lists: Record<string, string> = {};
  const rows: string[] = [];
  const failures: string[] = [];
  for (const { order } of REAL_ORDERS) {
    const scored: { code: string; record: BrewerRecord }[] = [];
    for (const setup of setupsIn(records).filter((each) => orderOf(each).order === order)) {
      const runs = runsOfSetup(records, setup, brewerFailure);
      for (const record of runs.scored) {
        const code = codeOf(seed, setup, record.run);
        scored.push({ code, record });
        rows.push(brewerRow(code, record));
      }
      for (const { run, why } of runs.failed) {
        failures.push(`Failed: ${setup} run ${run}: ${escapeCell(why)}`);
      }
    }
    if (scored.length === 0) continue;
    scored.sort((a, b) => (a.code < b.code ? -1 : 1));
    lists[String(order)] = `${[
      `# Order #${order}: ${scored.length} runs to score`,
      '',
      'Each run has a code of its own. Open codes.md only once they are scored.',
      '',
      ...scored.flatMap(({ code, record }) => {
        const diff = (record.brewer.diff ?? '').trimEnd();
        const fence = fenceOf(diff);
        return [`## Run ${code}`, '', `${fence}diff`, diff, fence, ''];
      }),
    ]
      .join('\n')
      .trimEnd()}\n`;
  }
  const codes = [
    '# The codes of the lists',
    '',
    '| Code | Setup | Run | Model | Effort | Text | Checks | Rounds | Input | Output | Cache read | Cache write | Tokens | Turns | Brewers | Wall |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    ...(failures.length === 0 ? [] : ['', ...failures]),
    '',
  ].join('\n');
  return { lists, codes };
};

/** What a brewer's comparison prints: each setup's runs, failed, retried and passing the checks. */
export const brewerTable = (records: readonly BrewerRecord[]): string => {
  const rows = setupsIn(records).map((setup) => {
    const { scored, failed } = runsOfSetup(records, setup, brewerFailure);
    const retried = records.filter((each) => each.setup === setup && each.retry === true).length;
    const passed = scored.filter(({ brewer }) => brewer.checksPassed).length;
    return `| ${setup} | ${scored.length} | ${failed.length} | ${retried} | ${passed} of ${scored.length} |`;
  });
  return `${[
    '| Setup | Runs to score | Failed goes | Retried | Passed the checks |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    'Score lists/<order>.md by hand against the key, then open codes.md, which says which setup each code is.',
  ].join('\n')}\n`;
};

/** The Brewmaster's recipe of the planning runs, `--sub-orders` (ADR 0396). */
export const PLANNER_RECIPE = 'real-plan-brewmaster';

/** The end of a brewer's setup that starts from the kept sub-order (ADR 0396). */
const PLAN_TEXT = '-plan';

/** The family the Brewmaster's `strong` level names in `defaults/models.jsonc`. */
const STRONG_FAMILY = 'opus';

/** One order planned once by the real Brewmaster. */
export type PlannerSetup = `${OrderNumber}-brewmaster`;

/** What a planning run measured: the Brewmaster's models, and its one sub-order or why it has none. */
export interface PlannerRun {
  models: readonly string[];
  unreadable?: string;
  /** The Brewmaster's out doc, as its step's output gave it. */
  plan?: unknown;
  /** The sub-order a brewer's run starts from: its title and its plan entry's text (ADR 0290). */
  subOrder?: { title: string; text: string };
  /** Why the order keeps no sub-order text: a result to report, not a failed run. */
  why?: string;
}

export type PlannerRecord = RunRecord<PlannerSetup> & { planner: PlannerRun };

/** Whether `--sub-orders` plans the orders; throws on a wrong combination. */
export const subOrdersRunOf = (given: {
  real?: boolean;
  subOrders?: boolean;
  brewer?: string;
  setups?: string;
}): boolean => {
  if (given.subOrders !== true) return false;
  if (given.real !== true)
    throw new Error('--sub-orders plans the orders of --real: give --real too');
  if (given.brewer !== undefined) {
    throw new Error('--sub-orders plans the orders and --brewer builds them: give one of them');
  }
  if (given.setups !== undefined) {
    throw new Error('--sub-orders plans the orders and --setups tastes them: give one of them');
  }
  return true;
};

/** The planning runs' setups, one per order of `--orders`, or of every order. */
export const plannerSetups = (orders?: string): PlannerSetup[] =>
  realOrdersOf(orders).map(({ order }): PlannerSetup => `${order}-brewmaster`);

/**
 * The planning runs' Brewery files beyond Nip's: a mash of the Brewmaster alone, as it ships, so
 * the batch waits for its plan's review once the plan is written (ADR 0275, ADR 0396).
 */
export const plannerBreweryFiles = (): Record<string, string> => {
  const recipe = {
    name: PLANNER_RECIPE,
    type: 'mash',
    description: 'An order planned once by the Brewmaster as it ships, with no Taster',
    guidance: {
      chooseWhen: 'A brewed order, planned once to build again from its sub-order',
      notWhen: 'Any new order',
      bestUsed: 'Through node scripts/tasting-compare.ts --real --sub-orders',
    },
    testFirst: false,
    steps: [{ id: 'plan', brewer: 'brewmaster' }],
  };
  return {
    [`recipes/${PLANNER_RECIPE}.jsonc`]: `// node scripts/tasting-compare.ts --real --sub-orders' recipe (ADR 0396).\n${json(recipe)}`,
  };
};

/**
 * The models each attempt of `stepId` ran on, by its transcript; a transcript that cannot be found,
 * or one of an attempt that succeeded and names no model, cannot say; one that failed by itself may
 * have called none (ADR 0344).
 */
const stepModels = (
  events: readonly { event: Event }[],
  stepId: string,
  transcriptOf: (sessionId: string, worktree: string) => string | undefined,
): { models: string[]; unreadable?: string } => {
  const models = new Set<string>();
  const named = new Map<number, number>();
  let unreadable: string | undefined;
  for (const { event } of events) {
    if (event.type === 'step.started' && event.stepId === stepId && event.session !== undefined) {
      const { id, worktree } = event.session;
      const transcript = transcriptOf(id, worktree);
      if (transcript === undefined) {
        unreadable ??= `${stepId} ${event.attempt}: its transcript could not be found`;
        continue;
      }
      const read = transcriptReads(transcript, worktree).models;
      named.set(event.attempt, read.length);
      for (const model of read) models.add(model);
    } else if (
      event.type === 'step.finished' &&
      event.stepId === stepId &&
      event.outcome.kind === 'succeeded' &&
      named.get(event.attempt) === 0
    ) {
      unreadable ??= `${stepId} ${event.attempt}: its transcript names no model`;
    }
  }
  return { models: [...models], ...(unreadable === undefined ? {} : { unreadable }) };
};

const OutDocStatus = z.looseObject({ status: z.string() });

/**
 * A planning run's record from its store's events: the Brewmaster's models, its out doc, and its
 * one sub-order's title and plan entry, read as a sub-order's brewers read it (ADR 0290), or why
 * there is none: a plan of several sub-orders, or none (ADR 0396).
 */
export const plannerRecordOf = (
  events: readonly { event: Event }[],
  transcriptOf: (sessionId: string, worktree: string) => string | undefined,
): Pick<PlannerRecord, 'ended' | 'attempts' | 'planner'> => {
  const { ended } = recordIn(events, new Map());
  const read = stepModels(events, 'plan', transcriptOf);
  let wrote: { batchId: string; attempt: number; output: unknown } | undefined;
  for (const { event } of events) {
    if (event.type === 'step.finished' && event.stepId === 'plan') {
      const { outcome } = event;
      if (outcome.kind === 'succeeded') wrote = { ...event, output: outcome.output };
      // The runner records a question as an outcome of its own, the out doc's status and questions.
      if (outcome.kind === 'needs_input') {
        wrote = { ...event, output: { status: 'needs_input', questions: outcome.questions } };
      }
    }
  }
  const planner = (more: Partial<PlannerRun> = {}) => ({
    ended,
    attempts: [],
    planner: { ...read, ...more },
  });
  if (wrote === undefined) return planner();
  const { batchId, attempt, output } = wrote;
  const plan = planOf(output);
  if (plan === undefined) {
    const status = OutDocStatus.safeParse(output);
    return planner({
      plan: output,
      why: `the Brewmaster wrote no plan: its out doc ended ${status.success ? status.data.status : 'unread'}`,
    });
  }
  const [only, ...more] = plan.subOrders;
  if (only === undefined || more.length > 0) {
    return planner({
      plan: output,
      why: `the plan has ${plan.subOrders.length} sub-orders, and the head built the whole order`,
    });
  }
  const origin = { batchId, stepId: 'plan', attempt, entry: only.id };
  return planner({
    plan: output,
    subOrder: {
      title: withoutSecrets(only.title, 'plan', () => false),
      text: planEntryText(fold(events.map(({ event }) => event)), origin),
    },
  });
};

/** Why a planning run measured nothing, or undefined: the Brewmaster ended with no out doc. */
export const plannerFailure = ({
  ended,
  planner,
}: Pick<PlannerRecord, 'ended' | 'planner'>): string | undefined =>
  planner.plan === undefined
    ? `the batch ended ${ended} before the Brewmaster of its plan step wrote an out doc`
    : undefined;

/**
 * Why the comparison must stop after a planning run, or undefined: a transcript that cannot say, or
 * a model outside the Brewmaster's family, is the harness's (ADR 0344).
 */
export const plannerStop = ({
  setup,
  planner,
}: Pick<PlannerRecord, 'setup' | 'planner'>): string | undefined => {
  if (planner.unreadable !== undefined) return escapeCell(planner.unreadable);
  const other = planner.models.find((model) => !model.includes(STRONG_FAMILY));
  return other === undefined
    ? undefined
    : escapeCell(`plan: it ran on ${other}, and ${setup} asks for ${STRONG_FAMILY}`);
};

/**
 * The files the planning runs keep, by path in its folder: each order's plan, and its sub-order's
 * text, the title on its first line as an order's own file has it, only when the plan has one.
 */
export const keptFiles = (records: readonly PlannerRecord[]): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const { setup, planner } of records) {
    const order = orderOf(setup).order;
    if (planner.plan === undefined) continue;
    files[`${order}-plan.json`] = json(planner.plan);
    if (planner.subOrder !== undefined) {
      files[`${order}.md`] = `${planner.subOrder.title}\n${planner.subOrder.text}\n`;
    }
  }
  return files;
};

/** What the planning runs print: each order's sub-order kept, or why it has none. */
export const plannerTable = (records: readonly PlannerRecord[]): string =>
  `${[
    '| Order | Sub-order text |',
    '|---|---|',
    ...records.map(({ setup, planner }) => {
      const kept = planner.subOrder === undefined ? undefined : `kept: ${planner.subOrder.title}`;
      return `| ${orderOf(setup).order} | ${escapeCell(kept ?? planner.why ?? 'no out doc: planned again once')} |`;
    }),
  ].join('\n')}\n`;

/** The dry run's scripted Brewmaster: a plan of one sub-order of the order `title`, touching a path every base has. */
export const scriptedPlan = (title: string): Record<string, readonly Scripted[]> => ({
  plan: [
    {
      files: {},
      message: '',
      summary: "The dry run's scripted plan of one sub-order.",
      doc: {
        assumptions: [],
        subOrders: [
          {
            id: 'order',
            title,
            repo: TARGET,
            size: { lines: 100, mechanism: 'the order as written' },
            doneWhen: "the head's tests pass",
            touches: [{ path: 'package.json' }],
            dependencies: [],
            recipe: 'nip',
            why: 'scripted by the dry run',
            ready: true,
          },
        ],
      },
    },
  ],
});

/** The file of the text a brewer's run of `setup` starts from: the order's own, or the kept sub-order's. */
export const orderFileOf = (
  setup: BrewerSetup,
  folders: { fixture: string; kept: string },
): string =>
  join(setup.endsWith(PLAN_TEXT) ? folders.kept : folders.fixture, `${orderOf(setup).order}.md`);

/**
 * Throws, naming every missing file, when a run of `setups` would start from a kept text that is
 * not there: it never starts from the order's own text instead (ADR 0396).
 */
export const refuseMissingTexts = (
  setups: readonly BrewerSetup[],
  kept: string,
  exists: (path: string) => boolean,
): void => {
  const missing = setups
    .filter((setup) => setup.endsWith(PLAN_TEXT))
    .map((setup) => orderFileOf(setup, { fixture: kept, kept }))
    .filter((path) => !exists(path));
  if (missing.length > 0) {
    throw new Error(
      `--order-text plan starts from a kept sub-order, and there is none in ${missing.join(', ')}: run --real --sub-orders first`,
    );
  }
};
