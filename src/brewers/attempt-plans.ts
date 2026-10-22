// The attempt plans' shell (#148, ADR 0059): for an attempt the driver started, it finds the brewer
// of its step in the batch's recipe, reads the brewer's inputs and makes the settings file's
// folder, then plans the attempt through attempt-plan.ts, which decides, in the session the driver
// recorded (ADR 0116).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AttemptRef } from '../engine/attempt-key.ts';
import type { Env } from '../engine/brewer-env.ts';
import type { AttemptLimits, AttemptStart } from '../engine/brewer-runner.ts';
import type { Batch, State } from '../engine/fold.ts';
import { MAX_INPUT_BYTES, type StepBrewer, type StepBrewers } from '../engine/recipe-files.ts';
import { worktreeOf as sessionWorktree } from '../engine/session-resume.ts';
import type { WorktreeRef } from '../schemas/events.ts';
import type { ModelsConfig } from '../schemas/models.ts';
import { OutDocFrontmatter } from '../schemas/out-doc.ts';
import { attemptBranch } from '../workspace/attempt-worktrees.ts';
import {
  answersOf,
  attemptLimits,
  type InputRead,
  inputsOf,
  type PlannedInput,
  planAttempt,
  routeInput,
  routeOf,
  settingsFileOf,
} from './attempt-plan.ts';
import { type ClaudeAttemptPlan, type OutDocRead, readOutDocFile } from './claude-runner.ts';
import type { PromptInput, RandomBytes } from './prompt.ts';

export interface AttemptPlansOptions {
  /** The folded state: the driver's, which has recorded the attempt's start and worktree. */
  state: () => State;
  /** The brewers of the recipes' steps (`loadRecipes`). */
  brewers: StepBrewers;
  models: ModelsConfig;
  /** The toolchain rules of a repository (`foedrum.jsonc`, ADR 0023). */
  repoTools: (repo: string) => readonly string[];
  /** Whether the isolation level relies on Claude Code's sandbox (ADR 0010). */
  sandbox: boolean;
  /** The clone a repository's attempt worktrees are added to: the user's, or the managed one. */
  clone: (repo: string) => string;
  /** The Brewery's work root (ADR 0037). */
  workRoot: string;
  /** The brewer's minimal base environment and the runner's forced variables (ADR 0028). */
  env: { base: Env; forced: Env };
  /** Default this process's. */
  platform?: NodeJS.Platform;
  /** The text of an order's issue, untrusted. */
  orderText: (order: Extract<InputRead, { kind: 'order' }>) => Promise<string>;
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
  if (started?.worktree !== undefined) return { worktree: started.worktree, madeBy: ref };
  const session = started?.session;
  const step = batch?.steps.get(ref.stepId);
  if (session?.resumes === undefined || step === undefined) return undefined;
  const made = sessionWorktree(step, session.id);
  if (made === undefined) return undefined;
  const worktree = { ...made.worktree, path: session.worktree };
  return { worktree, madeBy: { ...ref, attempt: made.attempt } };
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
   * The inputs of a fresh attempt `ref` of `found`, in `worktree`: its brewer's, then the answers to
   * its step's questions, then what sent it back when a route scheduled it (ADR 0128).
   */
  const inputsFor = async (
    batch: Batch,
    ref: AttemptRef,
    found: StepBrewer,
    worktree: string,
  ): Promise<PromptInput[]> => {
    const recipe = batch.recipe?.name ?? '';
    const stepBrewer = (id: string) => brewers.find(recipe, id);
    const planned = inputsOf(found.brewer.inputs, batch, stepBrewer, worktree, found.lenses);
    const inputs: PromptInput[] = [];
    for (const input of planned) {
      inputs.push({ name: input.name, source: input.source, text: await textOf(input) });
    }
    const answers = answersOf(batch, ref.stepId);
    if (answers !== undefined) inputs.push(answers);
    const route = routeOf(batch, ref, (id) => stepBrewer(id)?.brewer.output.doc);
    if (route !== undefined) {
      const { outDoc } = route;
      const read =
        outDoc === undefined ? undefined : files.read(outDoc.path, MAX_INPUT_BYTES, outDoc.root);
      inputs.push(routeInput(route, read));
    }
    return inputs;
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
      const session = startedOf(batch, ref)?.session;
      if (session === undefined) {
        throw new Error(`attempt ${stepId}#${attempt} of batch ${batchId} has no session`);
      }
      const recipe = batch.recipe?.name ?? '';
      const found = brewers.find(recipe, stepId);
      if (found === undefined) throw new Error(`recipe ${recipe} has no step ${stepId}`);
      // A resumed session holds the inputs its first attempt read, and only a retry resumes one,
      // which no route scheduled (ADR 0117).
      const resumes = session.resumes !== undefined;
      const inputs = resumes ? [] : await inputsFor(batch, ref, found, worktree.path);
      const settingsFile = settingsFileOf(workRoot, ref);
      files.makeFolder(dirname(settingsFile));
      const plan = planAttempt({
        brewer: found.brewer,
        instructions: found.instructions,
        worktree: worktree.path,
        inputs,
        models: options.models,
        repoTools: options.repoTools(worktree.repo),
        sandbox: options.sandbox,
        settingsFile,
        sessionId: session.id,
        resumes,
        env: { ...options.env, platform },
        ...(options.random === undefined ? {} : { random: options.random }),
      });
      if (found.brewer.produces !== 'commits') return plan;
      // Its commits are counted on its branch in the clone, built from the attempt that made the
      // worktree as the worktree's is, never from the recorded branch or the worktree's own git
      // files (ADR 0037, ADR 0117).
      const commits = { clone: options.clone(worktree.repo), branch: attemptBranch(madeBy) };
      return { ...plan, commits };
    },
    limits: (ref) => {
      const found = brewerOf(ref);
      if (found === undefined) return noBrewer;
      // The commit its worktree started at, which a done of a brewer that commits needs one after.
      const batch = state().batches.get(ref.batchId);
      return attemptLimits(found.brewer, worktreeOf(batch, ref)?.worktree.commit);
    },
    outDoc: (step) => brewerOf(step)?.brewer.output.doc,
  };
}
