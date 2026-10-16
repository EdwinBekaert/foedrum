// foedrum.jsonc: the Brewery's repositories and permission ceiling (architecture §14, ADR 0023).

import { Repo } from './events.ts';
import { RepositoryAlias } from './ids.ts';
import { AllowedTool, Command, Duration, RelativePath, withinCeiling } from './primitives.ts';
import { z } from './zod.ts';

// null: the repository has no such check; a gravity reading skips it and records the skip.
const check = Command.nullable();

/** Every check is required, so a missing one is always an explicit null (ADR 0023). */
const Checks = z
  .strictObject({ build: check, typecheck: check, lint: check, format: check, test: check })
  .describe('The command behind each check recipes name, or null when the repository has none');

/** Where the structured report of the test check is, for red proof (ADR 0017). */
const TestReport = z.discriminatedUnion('format', [
  z.strictObject({
    format: z.literal('tap'),
    path: RelativePath.optional().describe('Without a path, the test command writes TAP to stdout'),
  }),
  z.strictObject({ format: z.literal('junit'), path: RelativePath }),
]);

/** Which open issues of a repository the intake claims: those with all the labels (ADR 0043). */
const IntakeFilter = z
  .strictObject({
    labels: z.array(z.string().min(1)).min(1).describe('Labels an issue must all have'),
    milestone: z.string().min(1).optional().describe('The milestone an issue must be in'),
  })
  .describe('Polls the repository for issues to claim and brew; without it, none are');

const RepositoryConfig = z
  .strictObject({
    checks: Checks,
    testReport: TestReport.optional(),
    setup: z
      .strictObject({ command: Command, timeout: Duration })
      .optional()
      .describe('Runs once per worktree, before the first step'),
    tools: z
      .array(AllowedTool)
      .default([])
      .describe("Toolchain rules added to every brewer's allowlist, within the permission ceiling"),
    houseYeast: z
      .enum(['repo', 'brewery'])
      .default('repo')
      .describe('Where repository-layer house-yeast rules are kept (ADR 0018)'),
    alias: RepositoryAlias.optional().describe(
      'The short name that starts the batch ids of its claimed issues; required with an intake',
    ),
    intake: IntakeFilter.optional(),
  })
  .refine((repository) => repository.intake === undefined || repository.alias !== undefined, {
    message: 'An intake needs an alias, for the batch ids of the issues it claims',
    path: ['alias'],
  })
  .refine((repository) => !repository.testReport || repository.checks.test !== null, {
    message: 'A test report needs a test check',
    path: ['testReport'],
  });

export const BreweryConfig = z
  .strictObject({
    $schema: z.string().optional().describe('The JSON Schema of this file, for editors'),
    permissionCeiling: z
      .array(AllowedTool)
      .default([])
      .describe('The most any repository may add to its brewers; a rule covers narrower ones'),
    repositories: z
      .record(Repo, RepositoryConfig)
      .describe('The target repositories, by owner/name'),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    // Batch ids start with the alias, so two repositories never share one.
    const aliases = new Map<string, string>();
    for (const [repo, repository] of Object.entries(config.repositories)) {
      // GitHub names are case-insensitive: two spellings would be one repository.
      if (seen.has(repo.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          message: `${repo} is already listed in another case`,
          path: ['repositories', repo],
        });
      }
      seen.add(repo.toLowerCase());
      const { alias } = repository;
      if (alias !== undefined) {
        const other = aliases.get(alias);
        if (other !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `The alias ${alias} is already the alias of ${other}`,
            path: ['repositories', repo, 'alias'],
          });
        }
        aliases.set(alias, other ?? repo);
      }
      for (const [index, tool] of repository.tools.entries()) {
        if (!withinCeiling(tool, config.permissionCeiling)) {
          ctx.addIssue({
            code: 'custom',
            message: `${tool} is outside the permission ceiling`,
            path: ['repositories', repo, 'tools', index],
          });
        }
      }
    }
  });
export type BreweryConfig = z.infer<typeof BreweryConfig>;
