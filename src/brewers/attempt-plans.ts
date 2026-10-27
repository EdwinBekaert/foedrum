// The attempt plans' shell (#148, ADR 0059): for an attempt the driver started, it finds the brewer
// of its step in the batch's recipe, reads the brewer's inputs and makes the settings file's
// folder, then plans the attempt through attempt-plan.ts, which decides, in the session the driver
// recorded (ADR 0116).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { checksEnv, setupRunOf } from '../checks/setup.ts';
import { stepTests } from '../checks/step-commits.ts';
import type { AttemptRef } from '../engine/attempt-key.ts';
import { mergedBase } from '../engine/base-merge.ts';
import type { Env } from '../engine/brewer-env.ts';
import type { AttemptLimits, AttemptStart } from '../engine/brewer-runner.ts';
import type { Batch, State } from '../engine/fold.ts';
import { MAX_INPUT_BYTES, type StepBrewer, type StepBrewers } from '../engine/recipe-files.ts';
import { afterOverrun, ranIn } from '../engine/session-resume.ts';
import { sameRepo } from '../engine/task-tree.ts';
import type { RepositorySetup } from '../schemas/brewery-config.ts';
import type { WorktreeRef } from '../schemas/events.ts';
import type { HouseYeastSelection } from '../schemas/house-yeast.ts';
import type { ModelsConfig } from '../schemas/models.ts';
import {
  FINING,
  OutDocFrontmatter,
  readOutDoc,
  TASTING,
  TastingOutDoc,
} from '../schemas/out-doc.ts';
import { PLAN } from '../schemas/plan.ts';
import { parseRule } from '../schemas/primitives.ts';
import { attemptBranch } from '../workspace/attempt-worktrees.ts';
import { inClone } from '../workspace/clone-git.ts';
import type { Git, GitOptions } from '../workspace/git.ts';
import {
  answersOf,
  attemptLimits,
  changeInput,
  changeStart,
  type EarlierRound,
  earlierFindingsInput,
  earlierRoundsOf,
  type InputRead,
  inputsOf,
  type LaterRound,
  MAX_CHANGE_INPUT_BYTES,
  outDocCopyOf,
  type PlannedInput,
  planAttempt,
  type RegressionTests,
  type Resumed,
  roundBefore,
  routeInput,
  routeOf,
  scanRetryOf,
  settingsFileOf,
} from './attempt-plan.ts';
import type { ConfigDirs } from './attempt-settings.ts';
import { type ClaudeAttemptPlan, type OutDocRead, readOutDocFile } from './claude-runner.ts';
import {
  blobTexts,
  breweryRules,
  changedFilesZ,
  type PickedRules,
  pickRules,
  type RuleSource,
  ruleBlobs,
} from './house-yeast.ts';
import type { PromptInput, RandomBytes } from './prompt.ts';

export interface AttemptPlansOptions {
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** The brewers of the recipes' steps (`loadRecipes`). */
  brewers: StepBrewers;
  models: ModelsConfig;
  /** The toolchain rules of a repository (`foedrum.jsonc`, ADR 0023). */
  repoTools: (repo: string) => readonly string[];
  /** A repository's setup (`foedrum.jsonc`), run before every attempt's brewer (ADR 0163). */
  repoSetup?: (repo: string) => RepositorySetup | undefined;
  /** Whether the isolation level relies on Claude Code's sandbox (ADR 0010). */
  sandbox: boolean;
  /** Where the driver's environment moves the logins the sandbox hides (ADR 0160). */
  configDirs?: ConfigDirs;
  /** The clone a repository's attempt worktrees are added to: the user's, or the managed one. */
  clone: (repo: string) => string;
  /**
   * The Brewery's repositories and the base each attempt starts from (`origin/<base>`): a plan's
   * paths are checked in each once it is done (ADR 0233).
   */
  repositories?: readonly { repo: string; base: string }[];
  /**
   * Fetches a repository's clone through its worktree manager, when a plan's check finds no ref of
   * its base there (ADR 0233).
   */
  fetchBase?: (repo: string) => Promise<void>;
  /** The Brewery's work root (ADR 0037). */
  workRoot: string;
  /** The brewer's minimal base environment and the runner's forced variables (ADR 0028). */
  env: { base: Env; forced: Env };
  /** Default this process's. */
  platform?: NodeJS.Platform;
  /** The text of an order's issue, untrusted. */
  orderText: (order: Extract<InputRead, { kind: 'order' }>) => Promise<string>;
  /**
   * Reads the change a Taster that reviews a diff is given, in its worktree (ADR 0161); a plan
   * that needs it fails without it.
   */
  git?: Git;
  /**
   * The Brewery's house-yeast rule files, read with its files, and where a repository's own rules
   * are kept (`foedrum.jsonc`, ADR 0018): a brewer that asks for house yeast gets those that match
   * its change (ADR 0169).
   */
  houseYeast?: {
    files: readonly RuleSource[];
    keptIn: (repo: string) => 'repo' | 'brewery';
  };
  /** Default the file system's: `readOutDocFile` and a recursive `mkdir`. */
  files?: {
    read: (file: string, maxBytes: number, root: string) => OutDocRead;
    makeFolder: (path: string) => void;
  };
  random?: RandomBytes;
}

export interface AttemptPlans {
  /** The plan of an attempt the driver started; rejects when it cannot be made. */
  plan(attempt: AttemptStart): Promise<ClaudeAttemptPlan>;
  /** The limits of an attempt, from the brewer of its step in its batch's recipe. */
  limits(ref: AttemptRef): AttemptLimits;
  /** The out doc of the brewer of a step in its batch's recipe; undefined without one (ADR 0081). */
  outDoc(step: { batchId: string; stepId: string }): string | undefined;
}

/** The tools that run a command: a brewer without one cannot use an install (ADR 0163). */
const shellTools = new Set(['Bash', 'PowerShell']);

const realFiles = {
  read: readOutDocFile,
  makeFolder: (path: string) => {
    mkdirSync(path, { recursive: true });
  },
};

/** The attempt `ref` as the driver recorded its start; undefined before. */
const startedOf = (batch: Batch | undefined, ref: AttemptRef) => {
  const started = batch?.steps.get(ref.stepId)?.attempts.get(ref.attempt);
  return started?.phase === 'started' ? started : undefined;
};

/**
 * The worktree the attempt runs in, and the attempt that made it: the one the driver recorded when
 * it started the attempt, or for a resumed attempt with none of its own, the worktree of the
 * session it continues (ADR 0117); none before it started.
 */
const worktreeOf = (
  batch: Batch | undefined,
  ref: AttemptRef,
): { worktree: WorktreeRef; madeBy: AttemptRef } | undefined => {
  const started = startedOf(batch, ref);
  const step = batch?.steps.get(ref.stepId);
  const ran = started === undefined || step === undefined ? undefined : ranIn(step, started);
  if (started === undefined || ran === undefined) return undefined;
  // A resumed attempt runs where the driver recreated that worktree (ADR 0117).
  const path = started.session?.worktree ?? ran.worktree.path;
  return { worktree: { ...ran.worktree, path }, madeBy: { ...ref, attempt: ran.attempt } };
};

/** What an attempt without a brewer is limited to: the plan then fails it, before it runs. */
const noBrewer: AttemptLimits = { outDoc: { file: 'out.md', schema: OutDocFrontmatter } };

export function createAttemptPlans(options: AttemptPlansOptions): AttemptPlans {
  const { state, brewers, workRoot, platform = process.platform, files = realFiles } = options;

  // The brewer of a step in the recipe its batch brews; undefined without one.
  const brewerOf = ({ batchId, stepId }: { batchId: string; stepId: string }) => {
    const recipe = state().batches.get(batchId)?.recipe?.name;
    return recipe === undefined ? undefined : brewers.find(recipe, stepId);
  };

  /** The text of one input, untrusted. */
  const textOf = async ({ name, read }: PlannedInput): Promise<string> => {
    // A lens's text was read, and held to the limit, when the brewer loaded (ADR 0098).
    if (read.kind === 'text') return read.text;
    if (read.kind === 'order') {
      const text = await options.orderText(read);
      // Anyone who can file an issue writes its body: it gets the limit of an input file.
      if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
        throw new Error(
          `the input "${name}" was not read: it is larger than ${MAX_INPUT_BYTES} bytes`,
        );
      }
      return text;
    }
    const found = files.read(read.path, MAX_INPUT_BYTES, read.root);
    switch (found.kind) {
      case 'text':
        return found.text;
      case 'missing':
        throw new Error(`the input "${name}" was not read: it is missing`);
      case 'unread':
        throw new Error(`the input "${name}" was not read: ${found.reason}`);
      default: {
        const unhandled: never = found;
        throw new Error(`Unhandled read ${JSON.stringify(unhandled)}`);
      }
    }
  };

  /**
   * git in the clone of `repo`, never by discovery in a worktree, with no hook, external diff or
   * textconv a brewer could have planted there (ADR 0029, ADR 0096, ADR 0137): its stdout, or an
   * error that starts with `why` and names the call. With `keepCut`, the start of an output git
   * was stopped for past its limit.
   */
  const gitIn = (repo: string, why: string) => {
    if (options.git === undefined) throw new Error(`${why}: no git was given`);
    const git = inClone(options.git);
    const clone = options.clone(repo);
    return async (
      args: readonly string[],
      { keepCut = false, ...more }: GitOptions & { keepCut?: boolean } = {},
    ): Promise<string> => {
      const result = await git(clone, args, more);
      if (result.code === 0 || (keepCut && result.killed === 'too-much-output')) {
        return result.stdout;
      }
      const [said = ''] = result.stderr.trim().split('\n');
      throw new Error(`${why}: git ${args.join(' ')} exited with code ${result.code}: ${said}`);
    };
  };

  /**
   * Each repository of the Brewery with the commit a plan's paths in it are checked at (ADR 0233):
   * the attempt's own at the commit its worktree started at, another at its base as its clone has
   * it, with no fetch.
   */
  const planRepositories = async (worktree: { repo: string; commit: string }) =>
    Promise.all(
      (options.repositories ?? []).map(async ({ repo, base }) => {
        const clone = options.clone(repo);
        if (sameRepo(repo, worktree.repo)) return { repo, clone, commit: worktree.commit };
        const read = gitIn(repo, `the base ${base} of ${repo} was not read`);
        const args = ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`];
        return { repo, clone, commit: (await read(args)).trim() };
      }),
    );

  /**
   * The change a Taster that reviews a diff is given (ADR 0161): the commits from `since` to `head`,
   * the commit its worktree started at, and their diff. Read in the repository's clone, never by
   * discovery in the worktree, with no hook, external diff or textconv a brewer could have planted
   * there (ADR 0029, ADR 0096, ADR 0137). A diff past git's output limit keeps its start, which the
   * input cuts anyway.
   */
  const changeFor = async (
    repo: string,
    since: string,
    head: string,
    regression: readonly RegressionTests[],
  ): Promise<PromptInput> => {
    const read = gitIn(repo, `the change since commit ${since} was not read`);
    const cut = { maxOutputBytes: 2 * MAX_CHANGE_INPUT_BYTES, keepCut: true };
    // The first parents only: never the commits a merge of the base brought in (ADR 0164).
    const log = await read(
      ['log', '--no-show-signature', '--first-parent', '--format=%h %s', `${since}..${head}`],
      cut,
    );
    const diff = await read(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        since,
        head,
      ],
      cut,
    );
    return changeInput(since, log, diff, regression);
  };

  /**
   * Why commit `ancestor` is not on the line to `head` in the clone of `repo`: `off` when git says
   * it is not, or that git failed; undefined when it is.
   */
  const offLine = async (
    repo: string,
    ancestor: string,
    head: string,
    off: string,
  ): Promise<string | undefined> => {
    if (options.git === undefined) throw new Error('the change since the round before: no git');
    const args = ['merge-base', '--is-ancestor', ancestor, head];
    const { code, killed } = await inClone(options.git)(options.clone(repo), args);
    // Exit 1 alone says it is not an ancestor; any other end is git's failure (#506).
    if (code === 0) return undefined;
    if (code === 1) return off;
    return killed === undefined
      ? `git merge-base exited with code ${code}`
      : `git merge-base was killed (${killed})`;
  };

  /**
   * For a later round of a lens step that reviews a diff (ADR 0190): the change from the commit
   * the round before reviewed to `worktree`'s, read as the change is, and what the round is told.
   * Never a range that is not the round's own: none when that commit is not on the line to HEAD,
   * as after a rewind, or when the base `merged` since would bring what it added (ADR 0164).
   */
  const roundFor = async (
    batch: Batch,
    ref: AttemptRef,
    worktree: WorktreeRef,
    merged: string | undefined,
  ): Promise<{ input?: PromptInput; laterRound?: LaterRound }> => {
    const before = roundBefore(batch, ref);
    if (before === undefined) return {};
    const step = `${ref.stepId}#${before.attempt}`;
    const unread = (why: string) => ({ laterRound: { kind: 'unread', step, why } as const });
    if (before.kind === 'unfound') return unread('no commit it reviewed is recorded');
    const { repo, commit } = before;
    if (repo.toLowerCase() !== worktree.repo.toLowerCase()) {
      return unread(`it reviewed ${repo}, not ${worktree.repo}`);
    }
    const rewound = await offLine(
      repo,
      commit,
      worktree.commit,
      `the commit it reviewed, ${commit}, is not on the line to HEAD`,
    );
    if (rewound !== undefined) return unread(rewound);
    const mergedSince =
      merged === undefined
        ? undefined
        : await offLine(repo, merged, commit, `the base was merged in since, at ${merged}`);
    if (mergedSince !== undefined) return unread(mergedSince);
    // The change input's text without regression tests, under a name of its own.
    const change = await changeFor(repo, commit, worktree.commit, []);
    return {
      input: { ...change, name: 'roundChange' },
      laterRound: { kind: 'since', step, commit },
    };
  };

  /**
   * For a later round of a lens step (ADR 0191): the earlier rounds' findings with their
   * dispositions, a blocked round's read from the out doc in its worktree as the route input reads
   * it (ADR 0128); none for a first round. An out doc that cannot be read is not an error: its round
   * says so.
   */
  const earlierFindingsFor = (batch: Batch, ref: AttemptRef, found: StepBrewer) => {
    const planned = earlierRoundsOf(batch, ref, found.brewer.output.doc);
    if (planned.length === 0) return undefined;
    const rounds = planned.map((round): EarlierRound => {
      if (!('outDoc' in round)) return round;
      const { step, dispositions, outDoc } = round;
      const read = files.read(outDoc.path, MAX_INPUT_BYTES, outDoc.root);
      switch (read.kind) {
        case 'text': {
          const doc = readOutDoc(read.text, TastingOutDoc);
          return doc.valid
            ? { step, dispositions, findings: doc.frontmatter.findings }
            : { step, dispositions, unread: `its out doc is invalid: ${doc.reason}` };
        }
        case 'missing':
          return { step, dispositions, unread: 'it is missing' };
        case 'unread':
          return { step, dispositions, unread: read.reason };
        default: {
          const unhandled: never = read;
          throw new Error(`Unhandled read ${JSON.stringify(unhandled)}`);
        }
      }
    });
    return earlierFindingsInput(ref.stepId, rounds);
  };

  /**
   * The house-yeast rules for an attempt with `stepLenses` in `repo`, whose change runs from
   * `since` to `head` (ADR 0169): the rules each lens would get apart, each once (ADR 0220): the Brewery's, and the repository's, from the Brewery or with git in the
   * clone at `since`, so the batch's own commits never add or remove one. The files the change
   * touched are read in the clone too; with no `since`, it touched none.
   */
  const houseYeastFor = async (
    repo: string,
    since: string | undefined,
    head: string,
    stepLenses: readonly string[],
    houseYeast: NonNullable<AttemptPlansOptions['houseYeast']>,
  ): Promise<PickedRules> => {
    const keptIn = houseYeast.keptIn(repo);
    const fromBrewery = breweryRules(houseYeast.files, repo, keptIn);
    const lens = stepLenses.length === 0 ? {} : { lenses: stepLenses };
    // Before an attempt recorded where the batch started, nothing changed, and no commit holds
    // the repository's own rules.
    if (since === undefined) return pickRules(fromBrewery, { files: [], ...lens });
    const why = `the house-yeast rules of ${repo} were not read`;
    const read = gitIn(repo, why);
    const changed = await read([
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-status',
      '-z',
      '--no-color',
      '--no-ext-diff',
      since,
      head,
    ]);
    const repository =
      keptIn === 'brewery' ? fromBrewery.repository : await rulesAt(read, why, since);
    const change = { files: changedFilesZ(changed), ...lens };
    return pickRules({ brewery: fromBrewery.brewery, repository }, change);
  };

  /** The rule files of `.foedrum/house-yeast/` at commit `at`, read with `read` (ADR 0169). */
  const rulesAt = async (
    read: ReturnType<typeof gitIn>,
    why: string,
    at: string,
  ): Promise<RuleSource[]> => {
    const blobs = ruleBlobs(await read(['ls-tree', '-z', at, '--', '.foedrum/house-yeast/']));
    if (blobs.length === 0) return [];
    const batch = await read(['cat-file', '--batch'], {
      stdin: `${blobs.map(({ blob }) => blob).join('\n')}\n`,
      // One byte past the limit, and kept when git is stopped there, so the check below says so.
      maxOutputBytes: MAX_INPUT_BYTES + 1,
      keepCut: true,
    });
    // The rules are one input's worth of text, as a file input is (ADR 0059).
    if (Buffer.byteLength(batch, 'utf8') > MAX_INPUT_BYTES) {
      throw new Error(`${why}: they are larger than ${MAX_INPUT_BYTES} bytes`);
    }
    try {
      return blobTexts(blobs, batch);
    } catch (error) {
      throw new Error(`${why}: ${(error as Error).message}`);
    }
  };

  /**
   * The inputs of a fresh attempt `ref` of `found`, in `worktree`: its brewer's, then for a Taster
   * that reviews a diff where the change starts (ADR 0161), then for a later round of a Taster's
   * step the earlier rounds' findings with their dispositions (ADR 0191), then for a brewer that
   * asks for house yeast the rules that match its change (ADR 0169), then the answers to its step's
   * questions,
   * then what sent it back when a route scheduled it (ADR 0128), and last, for a retry after the
   * secret scan failed the attempt before it, why (ADR 0187). With the rules it was given.
   */
  const inputsFor = async (
    batch: Batch,
    ref: AttemptRef,
    found: StepBrewer,
    worktree: WorktreeRef,
  ): Promise<{
    inputs: PromptInput[];
    houseYeast?: HouseYeastSelection;
    laterRound?: LaterRound;
    earlierFindings?: true;
  }> => {
    const recipe = batch.recipe?.name ?? '';
    const stepBrewer = (id: string) => brewers.find(recipe, id);
    const planned = inputsOf(found.brewer.inputs, batch, stepBrewer, worktree.path, found.lenses);
    const inputs: PromptInput[] = [];
    for (const input of planned) {
      inputs.push({ name: input.name, source: input.source, text: await textOf(input) });
    }
    // After a merge of the base, the batch's own change starts at the base it merged (ADR 0164).
    // A Finer simplifies the change, so it reads it as a Taster of a diff does (ADR 0166).
    const merged = mergedBase(state(), batch.id);
    const start = merged ?? changeStart(batch, worktree.repo);
    const stepLenses = found.together ?? (found.lens === undefined ? [] : [found.lens]);
    // A step's lenses together share one folder (ADR 0143, ADR 0220).
    const diffLens = stepLenses[0]?.startsWith('diff/') === true;
    const since = diffLens || found.brewer.output.schema === FINING ? start : undefined;
    let laterRound: LaterRound | undefined;
    if (since !== undefined) {
      // The regression tests the batch's steps named, for the test-design lens (ADR 0170).
      const regression = [...batch.steps.keys()].flatMap((step) => {
        const names = stepTests(batch, step)?.regressionTests ?? [];
        return names.length === 0 ? [] : [{ step, names }];
      });
      inputs.push(await changeFor(worktree.repo, since, worktree.commit, regression));
      // A later round of a lens step reviews the change since the round before (ADR 0190).
      if (diffLens) {
        const round = await roundFor(batch, ref, worktree, merged);
        if (round.input !== undefined) inputs.push(round.input);
        laterRound = round.laterRound;
      }
    }
    // A later round of a Taster's step gets what the earlier rounds found (ADR 0191).
    const earlier =
      found.brewer.output.schema === TASTING ? earlierFindingsFor(batch, ref, found) : undefined;
    if (earlier !== undefined) inputs.push(earlier);
    // Only where the driver gives the Brewery's rules: serve always does (ADR 0169).
    const { houseYeast } = options;
    const rules =
      found.brewer.houseYeast && houseYeast !== undefined
        ? await houseYeastFor(worktree.repo, start, worktree.commit, stepLenses, houseYeast)
        : undefined;
    if (rules !== undefined) inputs.push(...rules.inputs);
    const answers = answersOf(batch, ref.stepId);
    if (answers !== undefined) inputs.push(answers);
    const route = routeOf(batch, ref, (id) => stepBrewer(id)?.brewer.output.doc);
    if (route !== undefined) {
      const { outDoc } = route;
      const read =
        outDoc === undefined ? undefined : files.read(outDoc.path, MAX_INPUT_BYTES, outDoc.root);
      inputs.push(routeInput(route, read));
    }
    // Its commits are gone: it writes what the scan named another way (ADR 0187).
    const scanned = scanRetryOf(batch, ref);
    if (scanned !== undefined) inputs.push(scanned);
    return {
      inputs,
      ...(rules === undefined ? {} : { houseYeast: rules.record }),
      ...(laterRound === undefined ? {} : { laterRound }),
      ...(earlier === undefined ? {} : { earlierFindings: true as const }),
    };
  };

  return {
    plan: async ({ ref }) => {
      const { batchId, stepId, attempt } = ref;
      const batch = state().batches.get(batchId);
      const ranIn = worktreeOf(batch, ref);
      if (batch === undefined || ranIn === undefined) {
        throw new Error(`attempt ${stepId}#${attempt} of batch ${batchId} has no worktree`);
      }
      const { worktree, madeBy } = ranIn;
      const started = startedOf(batch, ref);
      const session = started?.session;
      if (session === undefined) {
        throw new Error(`attempt ${stepId}#${attempt} of batch ${batchId} has no session`);
      }
      const recipe = batch.recipe?.name ?? '';
      const found = brewers.find(recipe, stepId);
      if (found === undefined) throw new Error(`recipe ${recipe} has no step ${stepId}`);
      // A resumed session holds the inputs its first attempt read and the answers of the rounds
      // before, so an answered attempt gets this round's alone (ADR 0118). Only a retry or an
      // answered attempt resumes one, which no route scheduled (ADR 0117).
      const answered = started?.answered === true;
      // A retry after a turn overrun finishes the work with the out doc it left (ADR 0175).
      const overran = afterOverrun(batch, ref);
      const resumes: Resumed | undefined =
        session.resumes === undefined
          ? undefined
          : answered
            ? 'answered'
            : overran
              ? 'turns'
              : 'retry';
      const outDocFrom =
        resumes === 'turns'
          ? outDocCopyOf(settingsFileOf(workRoot, { ...ref, attempt: attempt - 1 }))
          : undefined;
      const latest = answered ? answersOf(batch, stepId, 'latest') : undefined;
      const { inputs, houseYeast, laterRound, earlierFindings } =
        resumes === undefined
          ? await inputsFor(batch, ref, found, worktree)
          : { inputs: latest === undefined ? [] : [latest] };
      const settingsFile = settingsFileOf(workRoot, ref);
      files.makeFolder(dirname(settingsFile));
      const planned = planAttempt({
        brewer: found.brewer,
        instructions: found.instructions,
        worktree: worktree.path,
        inputs,
        models: options.models,
        repoTools: options.repoTools(worktree.repo),
        sandbox: options.sandbox,
        ...(options.configDirs === undefined ? {} : { configDirs: options.configDirs }),
        settingsFile,
        sessionId: session.id,
        ...(resumes === undefined ? {} : { resumes }),
        ...(outDocFrom === undefined ? {} : { outDocFrom }),
        ...(laterRound === undefined ? {} : { laterRound }),
        ...(earlierFindings === undefined ? {} : { earlierFindings }),
        ...(found.interactive === undefined ? {} : { interactive: found.interactive }),
        ...(found.together === undefined ? {} : { together: found.together }),
        env: { ...options.env, platform },
        ...(options.random === undefined ? {} : { random: options.random }),
      });
      // The rules it was given go with its end onto its step.finished (ADR 0169).
      const plan = houseYeast === undefined ? planned : { ...planned, houseYeast };
      // Every attempt's worktree gets its repository's dependencies before the brewer starts: a
      // resumed one too, since the driver may have added its worktree again. Not for a brewer
      // that cannot run a command, such as a read-only Taster: it could not use them (ADR 0163).
      const shell = plan.permissions.allow.some((rule) => shellTools.has(parseRule(rule).tool));
      const setup = shell ? options.repoSetup?.(worktree.repo) : undefined;
      const prepared =
        setup === undefined || started === undefined
          ? plan
          : {
              ...plan,
              setup: {
                run: setupRunOf(setup, platform),
                deadlineAt: started.deadlineAt,
                env: checksEnv(options.env, platform),
              },
            };
      if (found.brewer.output.schema === PLAN) {
        return { ...prepared, touches: await planRepositories(worktree) };
      }
      if (found.brewer.produces !== 'commits') return prepared;
      // Its commits are counted on its branch in the clone, built from the attempt that made the
      // worktree as the worktree's is, never from the recorded branch or the worktree's own git
      // files (ADR 0037, ADR 0117).
      const commits = { clone: options.clone(worktree.repo), branch: attemptBranch(madeBy) };
      return { ...prepared, commits };
    },
    limits: (ref) => {
      const found = brewerOf(ref);
      if (found === undefined) return noBrewer;
      // The commit its worktree started at, which a done of a brewer that commits needs one after.
      const batch = state().batches.get(ref.batchId);
      const start = worktreeOf(batch, ref)?.worktree.commit;
      const lenses = found.together ?? (found.lens === undefined ? undefined : [found.lens]);
      return attemptLimits(found.brewer, start, found.blocking, lenses);
    },
    outDoc: (step) => brewerOf(step)?.brewer.output.doc,
  };
}
