// Brewer frontmatter: a reusable agent role (brewers-and-recipes §1).

import { LensName, PathSafeId } from './ids.ts';
import { ModelAlias } from './models.ts';
import { BrewerAllowedTool, BrewerDeniedTool, Duration, RelativePath } from './primitives.ts';
import { RECIPE_CHOICE } from './recipe-choice.ts';
import { NonEmpty } from './step-outcome.ts';
import { z } from './zod.ts';

const Count = z.int().positive();

/** A camelCase name: a `{variable}` in the prompt, or a named out-doc schema. */
const Identifier = z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'Must be a camelCase name');

// `repositories`: the Brewery's repositories and their bases, which the engine fills (ADR 0234);
// `recipes`: the recipes a step that chooses the recipe may offer (ADR 0232).
const source = /^(?:order|repositories|recipes|step:(.+)|file:(.+)|lens:(.+))$/;

const Input = z.strictObject({
  name: Identifier,
  from: z
    .string()
    .regex(
      source,
      'Must be "order", "repositories", "recipes", "step:<step id>", "file:<path in the repository>" or "lens:<folder>/<lens name>"',
    )
    .refine((from) => {
      const [, step, file, lens] = source.exec(from) ?? [];
      if (step !== undefined) return PathSafeId.safeParse(step).success;
      if (lens !== undefined) return LensName.safeParse(lens).success;
      return file === undefined || RelativePath.safeParse(file).success;
    }, 'Must name a path-safe step id, a lens as diff/<name> or plan/<name> (ADR 0143), or a relative path'),
  // Untrusted input goes between per-prompt nonce tags, as data (ADR 0041). Every
  // source is untrusted for now; a trusted one needs an ADR (brewers-and-recipes §1.1).
  trusted: z
    .literal(false, 'Every input is untrusted for now (brewers-and-recipes §1.1)')
    .default(false),
});

// Names that would undo the brewer's minimal environment, its sandbox or its credentials, in any
// case. The runner applies its own variables last, which is the real guarantee; this list only
// catches mistakes when the brewer is loaded.
const reservedEnv =
  /^(?:(?:node|npm_config|anthropic|claude|git|ssh|ld|dyld)_.*|path|pathext|comspec|systemroot|home|userprofile|appdata|bash_env|env|.*_proxy)$/i;

// The GitHub tokens, in any case: a push could carry one, and Foedrum never holds one (ADR 0109).
const gitHubToken = /^(?:gh|github)(?:_enterprise)?_token$/i;

const EnvName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Must be letters, digits and "_", not starting with a digit')
  .refine((name) => !reservedEnv.test(name), 'Reserved: the brewer runner sets this variable')
  .refine(
    (name) => !gitHubToken.test(name),
    'Reserved: a GitHub token, which a push could carry (ADR 0109)',
  );

const Guard = z.enum([
  'requiresOutDoc',
  'requiresCommits',
  'testsNotRemoved',
  'testsUnchanged',
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
  tools: z.strictObject({
    allow: z.array(BrewerAllowedTool),
    deny: z.array(BrewerDeniedTool).default([]),
  }),
  skills: z.array(NonEmpty).default([]),
  mcp: z.array(NonEmpty).default([]),
  context: z.enum(['lean', 'repo']).default('lean'),
  env: z
    .record(EnvName, z.string())
    .default({})
    .refine(
      (env) =>
        new Set(Object.keys(env).map((name) => name.toUpperCase())).size ===
        Object.keys(env).length,
      'Each name may be used once, in any case: Windows does not tell them apart',
    ),
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
    // The engine fills it with the recipes a step that chooses the recipe offers (ADR 0232).
    const recipes = brewer.inputs.findIndex(({ from }) => from === 'recipes');
    if (recipes >= 0 && brewer.output.schema !== RECIPE_CHOICE) {
      ctx.addIssue({
        code: 'custom',
        message: `The recipes input is for a brewer whose out doc schema is ${RECIPE_CHOICE} (ADR 0232)`,
        path: ['inputs', recipes, 'from'],
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
