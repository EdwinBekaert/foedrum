// foedrum.jsonc: the Brewery's repositories and permission ceiling (architecture §14, ADR 0023).

import { Repo } from './events.ts';
import { RepositoryAlias } from './ids.ts';
import {
  CeilingTool,
  Command,
  Duration,
  durationMs,
  RelativePath,
  withinCeiling,
} from './primitives.ts';
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
export type TestReportConfig = z.infer<typeof TestReport>;

/** Which open issues of a repository the intake claims: those with all the labels (ADR 0043). */
export const IntakeFilter = z
  .strictObject({
    labels: z.array(z.string().min(1)).min(1).describe('Labels an issue must all have'),
    milestone: z.string().min(1).optional().describe('The milestone an issue must be in'),
  })
  .describe('Polls the repository for issues to claim and brew; without it, none are');
export type IntakeFilter = z.infer<typeof IntakeFilter>;

/** A branch name git reads as one: no option, range, reflog entry or empty segment. */
const BranchName = z
  .string()
  .regex(
    /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<![/.])$/,
    'Must be a branch name such as "main" or "release/2.x"',
  );

/** Where a repository's attempt worktrees come from (ADR 0012). */
export const RepositorySource = z.enum(['local', 'managed']);
export type RepositorySource = z.infer<typeof RepositorySource>;

/**
 * The host gh reaches `api` by (ADR 0073): `github.com` for https://api.github.com, a GitHub
 * Enterprise host for https://<host>/api/v3, `github.localhost` for http://api.github.localhost;
 * `undefined` for any other URL.
 */
export const githubHostOf = (api: string): string | undefined => {
  const parsed = URL.parse(api);
  if (parsed === null || parsed.username !== '' || parsed.password !== '') return undefined;
  if (parsed.search !== '' || parsed.hash !== '' || parsed.port !== '') return undefined;
  const { protocol, hostname } = parsed;
  const path = parsed.pathname.replace(/\/$/, '');
  if (protocol === 'http:') {
    return hostname === 'api.github.localhost' && path === '' ? 'github.localhost' : undefined;
  }
  if (protocol !== 'https:') return undefined;
  if (hostname === 'api.github.com') return path === '' ? 'github.com' : undefined;
  if (hostname.endsWith('github.localhost')) return undefined;
  return path === '/api/v3' ? hostname : undefined;
};

/** Where the GitHub REST API is: an API root gh reaches by its host (ADR 0073). */
const GitHubApi = z
  .url()
  .refine(
    (url) => githubHostOf(url) !== undefined,
    'Must be https://api.github.com, https://<host>/api/v3 for GitHub Enterprise, or http://api.github.localhost',
  );

/** A GitHub login: letters, digits and single hyphens, never at either end, at most 39. */
const GitHubLogin = z
  .string()
  .regex(
    /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
    'Must be a GitHub login such as "octocat"',
  );

/** How often the intake polls (ADR 0052, ADR 0068). */
const PollEvery = Duration.refine((duration) => {
  const ms = durationMs(duration);
  return ms >= 30_000 && ms <= 3_600_000;
}, 'Must be from "30s" to "1h"');

const RepositoryConfig = z
  .strictObject({
    checks: Checks,
    testReport: TestReport.optional(),
    setup: z
      .strictObject({ command: Command, timeout: Duration })
      .optional()
      .describe('Runs once per worktree, before the first step'),
    tools: z
      .array(CeilingTool)
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
    source: RepositorySource.optional().describe(
      "Where attempt worktrees come from: the user's clone (local, the default) or a managed clone (ADR 0012)",
    ),
    base: BranchName.optional().describe(
      'The branch attempts start from, at origin/<base> after a fetch; default main (ADR 0063)',
    ),
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
    brewery: Repo.optional().describe(
      "The Brewery's own owner/name on GitHub; foedrum serve needs it (ADR 0063)",
    ),
    githubApi: GitHubApi.optional().describe(
      "The GitHub REST API's base URL; default https://api.github.com",
    ),
    users: z
      .array(GitHubLogin)
      .optional()
      .describe('The GitHub users who may order work: only their issues become orders'),
    concurrency: z
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('How many batches may be Ordered or Brewing at once; default 1 (ADR 0068)'),
    pollEvery: PollEvery.optional().describe(
      'How often the intake polls GitHub, from "30s" to "1h"; default "60s" (ADR 0052)',
    ),
    permissionCeiling: z
      .array(CeilingTool)
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
