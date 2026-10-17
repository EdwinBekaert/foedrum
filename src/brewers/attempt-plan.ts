// The attempt plan's core (#148, ADR 0059): what the brewer of an attempt's step asks for, as the
// plan the claude runner takes (ADR 0047) and the limits the driver gives the attempt. Pure:
// attempt-plans.ts reads the state, the inputs and the files.

import { join } from 'node:path';
import type { AttemptRef } from '../engine/attempt-key.ts';
import { buildBrewerEnv, type Env } from '../engine/brewer-env.ts';
import type { AttemptLimits } from '../engine/brewer-runner.ts';
import type { Batch } from '../engine/fold.ts';
import type { StepBrewer } from '../engine/recipe-files.ts';
import type { BrewerFrontmatter } from '../schemas/brewer.ts';
import type { ModelsConfig } from '../schemas/models.ts';
import { OutDocFrontmatter } from '../schemas/out-doc.ts';
import { parseRule } from '../schemas/primitives.ts';
import { attemptFolder } from '../workspace/attempt-worktrees.ts';
import type { ClaudeAttemptPlan } from './claude-runner.ts';
import {
  assembleBrewerPrompt,
  type InputSource,
  type PromptInput,
  type RandomBytes,
} from './prompt.ts';

/** Where the text of an input is read from: the order's issue, or a file inside `root`. */
export type InputRead =
  | { kind: 'order'; issue: number; repo?: string }
  | { kind: 'file'; path: string; root: string };

/** An input of the brewer, where it comes from, and where its text is read. */
export interface PlannedInput {
  name: string;
  source: InputSource;
  read: InputRead;
}

/** What one attempt's plan is made from. */
export interface PlanFacts {
  brewer: BrewerFrontmatter;
  /** The brewer file's body. */
  instructions: string;
  /** The attempt's worktree. */
  worktree: string;
  /** The brewer's inputs with their text, in its order. */
  inputs: readonly PromptInput[];
  models: ModelsConfig;
  /** The repository's toolchain rules (`foedrum.jsonc`, ADR 0023). */
  repoTools: readonly string[];
  /** Whether the isolation level relies on Claude Code's sandbox (ADR 0010). */
  sandbox: boolean;
  settingsFile: string;
  /** The id of the new session (ADR 0047). */
  sessionId: string;
  env: { base: Env; forced: Env; platform: NodeJS.Platform };
  random?: RandomBytes;
}

/** The limits the runner enforces for an attempt of `brewer`. */
export function attemptLimits(brewer: BrewerFrontmatter): AttemptLimits {
  const { maxTurns, maxDenials } = brewer;
  // Brewer-specific schemas are not built yet: every out doc is read against the contract's.
  return {
    outDoc: { file: brewer.output.doc, schema: OutDocFrontmatter },
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(maxDenials === undefined ? {} : { maxDenials }),
  };
}

/** The model id behind the brewer's alias; throws when models.jsonc has none. */
export function modelOf(models: ModelsConfig, brewer: BrewerFrontmatter): string {
  // Blind tasting swaps the alias of a brewer in models.jsonc (brewers-and-recipes §5).
  const alias = models.brewers[brewer.name] ?? brewer.model;
  const model = Object.hasOwn(models.models, alias) ? models.models[alias] : undefined;
  if (model === undefined) {
    throw new Error(
      `models.jsonc has no model for the alias "${alias}" of the brewer "${brewer.name}"`,
    );
  }
  return model;
}

/** The tool of each rule, once each, in the order first named. */
export function toolsOf(rules: readonly string[]): string[] {
  return [...new Set(rules.map((rule) => parseRule(rule).tool))];
}

/** The latest attempt of `stepId` in `batch` that succeeded, with the worktree it ran in. */
const succeededIn = (batch: Batch, stepId: string): string | undefined => {
  const attempts = [...(batch.steps.get(stepId)?.attempts.values() ?? [])].reverse();
  const done = attempts.find(
    (attempt) => attempt.phase === 'finished' && attempt.outcome.kind === 'succeeded',
  );
  return done?.phase === 'finished' ? done.worktree?.path : undefined;
};

/** Where each of `inputs` is read from; throws when a step it names has no out doc yet. */
export function inputsOf(
  inputs: BrewerFrontmatter['inputs'],
  batch: Batch,
  stepBrewer: (stepId: string) => StepBrewer | undefined,
  worktree: string,
): PlannedInput[] {
  return inputs.map(({ name, from }): PlannedInput => {
    if (from === 'order') {
      const { issue, repo } = batch;
      const read: InputRead = { kind: 'order', issue, ...(repo === undefined ? {} : { repo }) };
      return { name, source: { kind: 'issue-body', issue }, read };
    }
    if (from.startsWith('step:')) {
      const step = from.slice('step:'.length);
      const root = succeededIn(batch, step);
      const doc = stepBrewer(step)?.brewer.output.doc;
      if (root === undefined || doc === undefined) {
        throw new Error(
          `the input "${name}" needs the out doc of step ${step}, which has none yet`,
        );
      }
      return {
        name,
        source: { kind: 'out-doc', step },
        read: { kind: 'file', path: join(root, doc), root },
      };
    }
    // `file:<path>`: a relative path with `/`, checked by the brewer's schema.
    const path = from.slice('file:'.length);
    const read: InputRead = {
      kind: 'file',
      path: join(worktree, ...path.split('/')),
      root: worktree,
    };
    return { name, source: { kind: 'file', path }, read };
  });
}

/** The out doc contract every prompt ends its instructions with (brewers-and-recipes §2). */
export function outDocContract(file: string): string {
  return [
    `When you finish, write ${file}. It must start with JSON frontmatter:`,
    '',
    '---',
    '{',
    '  "status": "done | needs_input | blocked | failed",',
    '  "summary": "<one line>",',
    '  "assumptions": ["<decisions you took without asking>"],',
    '  "questions": [{ "q": "...", "options": ["a", "b"], "recommended": "a", "whyBlocking": "..." }],',
    '  "blockerKind": "findings | environment | divergence"',
    '}',
    '---',
    '',
    'Prefer deciding and recording an assumption over asking. Ask only when a wrong',
    'guess would likely waste this run. Never ask questions any other way. Do not push.',
  ].join('\n');
}

/** The attempt's settings file: `<workRoot>/attempt-settings/<batch>/<step>/<attempt>.json`. */
export function settingsFileOf(workRoot: string, ref: AttemptRef): string {
  // The checked folder of the attempt's worktree, so its ids are path segments.
  const [batchId = '', stepId = '', attempt = ''] = attemptFolder(ref).split('/');
  return join(workRoot, 'attempt-settings', batchId, stepId, `${attempt}.json`);
}

/** The plan of one attempt; throws when its prompt cannot be assembled. */
export function planAttempt(facts: PlanFacts): ClaudeAttemptPlan {
  const { brewer, worktree, models, env, sessionId } = facts;
  const instructions = `${facts.instructions.trimEnd()}\n\n${outDocContract(brewer.output.doc)}`;
  const assembled = assembleBrewerPrompt(instructions, facts.inputs, facts.random);
  if (assembled.kind === 'refused') {
    const { name, source } = assembled.input;
    throw new Error(
      `the input "${name ?? ''}" (${source}) holds the prompt's nonce, a likely injection`,
    );
  }
  const allow = [...brewer.tools.allow, ...facts.repoTools];
  const { maxTurns } = brewer;
  return {
    cwd: worktree,
    env: buildBrewerEnv({ ...env, brewer: brewer.env }),
    prompt: assembled.prompt,
    call: {
      model: modelOf(models, brewer),
      effort: brewer.effort,
      ...(maxTurns === undefined ? {} : { maxTurns }),
      tools: toolsOf(allow),
      session: { kind: 'new', id: sessionId },
    },
    permissions: { allow, deny: brewer.tools.deny, sandbox: facts.sandbox },
    settingsFile: facts.settingsFile,
  };
}
