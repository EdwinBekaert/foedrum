// Brewer frontmatter: a reusable agent role (brewers-and-recipes §1).

import { PathSafeId } from './ids.ts';
import { ModelAlias } from './models.ts';
import { AllowedTool, Duration, RelativePath, ToolRule } from './primitives.ts';
import { NonEmpty } from './step-outcome.ts';
import { z } from './zod.ts';

const Count = z.int().positive();

/** A camelCase name: a `{variable}` in the prompt, or a named out-doc schema. */
const Identifier = z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'Must be a camelCase name');

const source = /^(?:order|step:(.+)|file:(.+))$/;

const Input = z
  .strictObject({
    name: Identifier,
    from: z
      .string()
      .regex(source, 'Must be "order", "step:<step id>" or "file:<path in the repository>"')
      .refine((from) => {
        const [, step, file] = source.exec(from) ?? [];
        if (step !== undefined) return PathSafeId.safeParse(step).success;
        return file === undefined || RelativePath.safeParse(file).success;
      }, 'Must name a path-safe step id or a relative path'),
    // Untrusted input is wrapped in delimiters and marked as data, never instructions.
    trusted: z.boolean().default(false),
  })
  .refine((input) => !(input.from === 'order' && input.trusted), {
    message: 'The order is always untrusted',
    path: ['trusted'],
  });

const Guard = z.enum([
  'requiresOutDoc',
  'requiresCommits',
  'testsNotRemoved',
  'testsUnchanged',
  'noPush',
  'scope',
  'diffLimits',
]);

// `setup` is not a brewer field: it depends on the repository, so it is in foedrum.jsonc (ADR 0023).
const shared = {
  name: PathSafeId,
  description: NonEmpty,
  version: Count,
  doneWhen: NonEmpty.optional(),
  inputs: z
    .array(Input)
    .default([])
    .refine(
      (inputs) => new Set(inputs.map((input) => input.name)).size === inputs.length,
      'Each input name may be used once',
    ),
  houseYeast: z.boolean().default(false),
  toolbox: NonEmpty.optional(),
  output: z.strictObject({ doc: PathSafeId, schema: Identifier }),
  produces: z.enum(['commits', 'report', 'comment', 'none']),
  model: ModelAlias,
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  // Role-level tools only; the repository adds its toolchain commands (ADR 0023).
  tools: z.strictObject({ allow: z.array(AllowedTool), deny: z.array(ToolRule).default([]) }),
  skills: z.array(NonEmpty).default([]),
  mcp: z.array(NonEmpty).default([]),
  context: z.enum(['lean', 'repo']).default('lean'),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  deadline: Duration,
  maxTurns: Count.optional(),
  stall: z
    .strictObject({ turns: Count.optional(), minutes: Count.optional() })
    .refine((stall) => stall.turns !== undefined || stall.minutes !== undefined, {
      message: 'Must set turns, minutes or both',
    })
    .optional(),
  maxAttempts: Count,
  retryMode: z.enum(['resume', 'fresh']).default('fresh'),
  maxDenials: Count.optional(),
  guards: z
    .array(Guard)
    .default([])
    .refine((guards) => new Set(guards).size === guards.length, 'Each guard may be listed once'),
};

export const BrewerFrontmatter = z
  .discriminatedUnion('access', [
    z.strictObject({
      access: z.literal('read'),
      tree: z.enum(['task', 'integration', 'checkout', 'scratch']),
      ...shared,
    }),
    z.strictObject({
      access: z.literal('write'),
      // A fresh checkout is read-only.
      tree: z.enum(['task', 'integration', 'scratch']),
      git: z.strictObject({ commit: z.boolean() }).default({ commit: false }),
      ...shared,
    }),
  ])
  .superRefine((brewer, ctx) => {
    const commits = brewer.access === 'write' && brewer.git.commit;
    if (brewer.produces === 'commits' && !commits) {
      ctx.addIssue({
        code: 'custom',
        message: 'A brewer that produces commits needs write access and git.commit',
        path: ['produces'],
      });
    }
    if (brewer.guards.includes('requiresCommits') && brewer.produces !== 'commits') {
      ctx.addIssue({
        code: 'custom',
        message: 'requiresCommits needs a brewer that produces commits',
        path: ['guards'],
      });
    }
  });
export type BrewerFrontmatter = z.infer<typeof BrewerFrontmatter>;
