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
      model: 'builder',
      effort: 'medium',
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

/** The text of `recipes/<name>.jsonc`, with a comment and guidance, as a Brewery writes it. */
export const recipeText = (
  name: string,
  steps: readonly unknown[],
  fields: Record<string, unknown> = {},
): string =>
  `// The ${name} recipe.\n${JSON.stringify({ name, type: 'brew', description: `The ${name}.`, guidance: testGuidance, steps, ...fields }, null, 2)}\n`;
