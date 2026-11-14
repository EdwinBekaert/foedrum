// Recipe and brewer files for the recipe loader's tests: a brewer with every required field, and
// a recipe of brewer steps, each changed by the fields given.

/** The text of `brewers/<name>.md`: a read-only brewer, with `fields` on top. */
export const brewerText = (name: string, fields: Record<string, unknown> = {}): string =>
  `---\n${JSON.stringify(
    {
      name,
      description: `The ${name}.`,
      version: 1,
      output: { doc: 'out.md', schema: 'outDoc' },
      produces: 'report',
      tools: { allow: ['Read', 'Grep'] },
      access: 'read',
      tree: 'task',
      deadline: '30m',
      maxAttempts: 2,
      ...fields,
    },
    null,
    2,
  )}\n---\nDo the work of the ${name}.\n`;

/** Guidance for a test recipe: every recipe offered as a choice carries some (ADR 0375). */
export const testGuidance = {
  chooseWhen: 'An order a test brews',
  notWhen: 'An order no test brews',
  bestUsed: 'In a test',
};

/**
 * `steps` with a model level and an effort on every brewer step that names neither, its own kept,
 * in a parallel group too: every brewer step names both (ADR 0397).
 */
export const withStepLevels = (steps: readonly unknown[]): unknown[] =>
  steps.map((step) => {
    if (typeof step !== 'object' || step === null) return step;
    const { parallel } = step as { parallel?: unknown };
    if (Array.isArray(parallel)) return { ...step, parallel: withStepLevels(parallel) };
    return 'brewer' in step ? { model: 'standard', effort: 'moderate', ...step } : step;
  });

/**
 * The text of `recipes/<name>.jsonc`, with a comment and guidance, as a Brewery writes it, every
 * brewer step on `standard` at `moderate` unless it names its own.
 */
export const recipeText = (
  name: string,
  steps: readonly unknown[],
  fields: Record<string, unknown> = {},
): string =>
  `// The ${name} recipe.\n${JSON.stringify({ name, type: 'brew', description: `The ${name}.`, guidance: testGuidance, steps: withStepLevels(steps), ...fields }, null, 2)}\n`;
