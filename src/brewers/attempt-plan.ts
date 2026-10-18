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

/**
 * The limits the runner enforces for an attempt of `brewer` in a worktree that started at
 * `start`: a brewer that produces commits needs one after it for a `done` (ADR 0074).
 */
export function attemptLimits(brewer: BrewerFrontmatter, start?: string): AttemptLimits {
  const { maxTurns, maxDenials } = brewer;
  // Brewer-specific schemas are not built yet: every out doc is read against the contract's.
  return {
    outDoc: { file: brewer.output.doc, schema: OutDocFrontmatter },
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(maxDenials === undefined ? {} : { maxDenials }),
    ...(brewer.produces === 'commits' && start !== undefined ? { commitsSince: start } : {}),
  };
}

/** The model id behind the brewer's alias; throws when models.jsonc has none. */
export function modelOf(models: ModelsConfig, brewer: BrewerFrontmatter): string {
  // Blind tasting swaps the alias of a brewer in models.jsonc (brewers-and-recipes §5).
  // Own entries only: a name such as "constructor" is a property of every object.
  const own = (record: Readonly<Record<string, string>>, key: string): string | undefined =>
    Object.hasOwn(record, key) ? record[key] : undefined;
  const alias = own(models.brewers, brewer.name) ?? brewer.model;
  const model = own(models.models, alias);
  if (model === undefined) {
    throw new Error(
      `models.jsonc has no model for the alias "${alias}" of the brewer "${brewer.name}"`,
    );
  }
  return model;
}

/**
 * The git rules `git.commit: true` grants (ADR 0074): fixed subcommands that never push (ADR 0062),
 * in Bash; none for any other brewer.
 */
export function gitRulesOf(brewer: BrewerFrontmatter): string[] {
  // `git diff --no-index` and `git log --output` reach any file: a brewer names them itself.
  return commits(brewer) ? ['Bash(git status *)', 'Bash(git add *)', 'Bash(git commit *)'] : [];
}

const commits = (brewer: BrewerFrontmatter): boolean =>
  brewer.access === 'write' && brewer.git.commit;

/**
 * The shell commands `rules` allow, once each, in the order first named: each Bash or PowerShell
 * rule's command without its trailing star (#222); none when one of them allows any command.
 */
export function shellCommandsOf(rules: readonly string[]): string[] {
  const commands = rules.flatMap((rule) => {
    const { tool, specifier } = parseRule(rule);
    if (tool !== 'Bash' && tool !== 'PowerShell') return [];
    return [(specifier ?? '').replace(/:?\*$/, '').trim()];
  });
  return commands.includes('') ? [] : [...new Set(commands)];
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

/**
 * Where each of `inputs` is read from, leaving out those of a step the batch skipped (ADR 0064);
 * throws when a step it names has no out doc yet.
 */
export function inputsOf(
  inputs: BrewerFrontmatter['inputs'],
  batch: Batch,
  stepBrewer: (stepId: string) => StepBrewer | undefined,
  worktree: string,
): PlannedInput[] {
  const skipped = (from: string): boolean =>
    from.startsWith('step:') && (batch.skipped?.has(from.slice('step:'.length)) ?? false);
  return inputs
    .filter(({ from }) => !skipped(from))
    .map(({ name, from }): PlannedInput => {
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

/**
 * The answers a human gave to the questions of `stepId`, every round in order, as the in-doc of
 * its next attempt, which starts a new session (ADR 0006); none when nobody answered.
 */
export function answersOf(batch: Batch, stepId: string): PromptInput | undefined {
  const answers = (batch.steps.get(stepId)?.inputs ?? []).flatMap((input) => input.answers);
  if (answers.length === 0) return undefined;
  const text = answers.map(({ q, answer }) => `Q: ${q}\nA: ${answer}`).join('\n\n');
  return { name: 'answers', source: { kind: 'answers', step: stepId }, text };
}

/** One example out doc of the contract: the keys every status shares, then the status's own key. */
function example(status: string, ownKey?: string): string[] {
  const shared = `{ "status": "${status}", "summary": "<one line>", "assumptions": ["<decided without asking>"]`;
  return ['---', ownKey === undefined ? `${shared} }` : `${shared},\n  ${ownKey} }`, '---'];
}

/**
 * The out doc contract every prompt ends its instructions with (brewers-and-recipes §2): one
 * example per status, so a brewer that copies one as it is writes a valid out doc (#195). A brewer
 * that commits is told to commit before it writes the out doc, and never the out doc (ADR 0074).
 * A brewer with shell rules is told their commands, so it does not read one denied command as the
 * whole shell denied (#222).
 */
export function outDocContract(
  file: string,
  commits = false,
  commands: readonly string[] = [],
): string {
  const asking = 'guess would likely waste this run. Never ask questions any other way.';
  return [
    `When you finish, write ${file}. It must start with JSON frontmatter: copy the example`,
    'below for how the run ended and fill it in, with only its keys and any your instructions',
    'add. "questions" goes only with needs_input, "blockerKind" only with blocked.',
    '',
    'The work is done:',
    ...example('done'),
    '',
    "You need a human's answer to go on:",
    ...example(
      'needs_input',
      '"questions": [{ "q": "...", "options": ["a", "b"], "recommended": "a", "whyBlocking": "..." }]',
    ),
    '',
    'Something stops the work. "blockerKind" is "findings" (problems to fix),',
    '"environment" (a wall you cannot fix) or "divergence" (the plan does not match reality):',
    ...example('blocked', '"blockerKind": "findings"'),
    '',
    'You could not finish:',
    ...example('failed'),
    '',
    ...(commands.length === 0
      ? []
      : [`Your shell runs only: ${commands.join(', ')}. A denial stops that command only.`, '']),
    'Prefer deciding and recording an assumption over asking. Ask only when a wrong',
    ...(commits
      ? [
          asking,
          `Commit your changes with git add and git commit before you write ${file}, and leave`,
          `${file} out of every commit. Do not push.`,
        ]
      : [`${asking} Do not push.`]),
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
  // The brewer's own rules, then what git.commit grants (ADR 0074), then the repository's, once each.
  const allow = [...new Set([...brewer.tools.allow, ...gitRulesOf(brewer), ...facts.repoTools])];
  const contract = outDocContract(brewer.output.doc, commits(brewer), shellCommandsOf(allow));
  const instructions = `${facts.instructions.trimEnd()}\n\n${contract}`;
  const assembled = assembleBrewerPrompt(instructions, facts.inputs, facts.random);
  if (assembled.kind === 'refused') {
    const { name, source } = assembled.input;
    throw new Error(
      `the input "${name ?? ''}" (${source}) holds the prompt's nonce, a likely injection`,
    );
  }
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
