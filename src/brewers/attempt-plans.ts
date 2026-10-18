// The attempt plans' shell (#148, ADR 0059): for an attempt the driver started, it finds the brewer
// of its step in the batch's recipe, reads the brewer's inputs and makes the settings file's
// folder, then plans the attempt through attempt-plan.ts, which decides.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AttemptRef } from '../engine/attempt-key.ts';
import type { Env } from '../engine/brewer-env.ts';
import type { AttemptLimits, AttemptStart } from '../engine/brewer-runner.ts';
import type { Batch, State } from '../engine/fold.ts';
import type { StepBrewers } from '../engine/recipe-files.ts';
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
  /** Default `randomUUID`. */
  sessionId?: () => string;
  random?: RandomBytes;
}

export interface AttemptPlans {
  /** The plan of an attempt the driver started; rejects when it cannot be made. */
  plan(attempt: AttemptStart): Promise<ClaudeAttemptPlan>;
  /** The limits of an attempt, from the brewer of its step in its batch's recipe. */
  limits(ref: AttemptRef): AttemptLimits;
}

/** An input's text reaches the prompt on stdin, and the event log through the out doc. */
const MAX_INPUT_BYTES = 1024 * 1024;

const realFiles = {
  read: readOutDocFile,
  makeFolder: (path: string) => {
    mkdirSync(path, { recursive: true });
  },
};

/** The worktree the driver recorded when it started the attempt; none before. */
const worktreeOf = (batch: Batch | undefined, ref: AttemptRef): WorktreeRef | undefined => {
  const started = batch?.steps.get(ref.stepId)?.attempts.get(ref.attempt);
  return started?.phase === 'started' ? started.worktree : undefined;
};

/** What an attempt without a brewer is limited to: the plan then fails it, before it runs. */
const noBrewer: AttemptLimits = { outDoc: { file: 'out.md', schema: OutDocFrontmatter } };

export function createAttemptPlans(options: AttemptPlansOptions): AttemptPlans {
  const {
    state,
    brewers,
    workRoot,
    platform = process.platform,
    files = realFiles,
    sessionId = randomUUID,
  } = options;

  /** The text of one input, untrusted. */
  const textOf = async ({ name, read }: PlannedInput): Promise<string> => {
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

  return {
    plan: async ({ ref }) => {
      const { batchId, stepId, attempt } = ref;
      const batch = state().batches.get(batchId);
      const worktree = worktreeOf(batch, ref);
      if (batch === undefined || worktree === undefined) {
        throw new Error(`attempt ${stepId}#${attempt} of batch ${batchId} has no worktree`);
      }
      const recipe = batch.recipe?.name ?? '';
      const found = brewers.find(recipe, stepId);
      if (found === undefined) throw new Error(`recipe ${recipe} has no step ${stepId}`);
      const planned = inputsOf(
        found.brewer.inputs,
        batch,
        (id) => brewers.find(recipe, id),
        worktree.path,
      );
      const inputs: PromptInput[] = [];
      for (const input of planned) {
        inputs.push({ name: input.name, source: input.source, text: await textOf(input) });
      }
      const answers = answersOf(batch, stepId);
      if (answers !== undefined) inputs.push(answers);
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
        sessionId: sessionId(),
        env: { ...options.env, platform },
        ...(options.random === undefined ? {} : { random: options.random }),
      });
      if (found.brewer.produces !== 'commits') return plan;
      // Its commits are counted on its branch in the clone, built from the attempt as the
      // worktree's is, never from the recorded branch or the worktree's own git files (ADR 0037).
      const commits = { clone: options.clone(worktree.repo), branch: attemptBranch(ref) };
      return { ...plan, commits };
    },
    limits: (ref) => {
      const batch = state().batches.get(ref.batchId);
      const recipe = batch?.recipe?.name;
      const found = recipe === undefined ? undefined : brewers.find(recipe, ref.stepId);
      if (found === undefined) return noBrewer;
      // The commit its worktree started at, which a done of a brewer that commits needs one after.
      return attemptLimits(found.brewer, worktreeOf(batch, ref)?.commit);
    },
  };
}
