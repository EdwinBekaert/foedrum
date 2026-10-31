// The test map, .foedrum/test-map.jsonc: per module of a target repository, where its code, its
// tests and its reports are; places only, never a command (ADR 0274).

import { SensitivePath } from './brewery-config.ts';
import { RelativePath } from './primitives.ts';
import { z } from './zod.ts';

/** A path glob relative to the repository, with `/` between folders, as a sensitive path is. */
const Glob = SensitivePath;

/**
 * A report's file or folder pattern: `*` within a folder name, never `**` across folders, and no
 * other wildcard, so a reader matches it at once whatever a batch's map writes.
 */
const ReportPath = Glob.refine(
  (path) => path.length <= 256 && !path.includes('**') && !/[?[\]{}()+@!]/.test(path),
  'Must be a file or a folder pattern of at most 256 characters with "*" as its only wildcard, such as "svc/test/*/TestResults"',
);

/**
 * A manifest glob: one git's `glob` magic lists as the map's readers match it (ADR 0282), so with
 * `*`, `**`, `?` and `[…]` only, never a brace or an extended glob, which git reads as text.
 */
const ManifestGlob = Glob.refine(
  (glob) => !/[{}()+@!]/.test(glob),
  'Must be a glob with "*", "**", "?" and "[...]" only, such as "**/*.csproj": git lists the manifests with its glob magic',
);

const Tests = z.union([
  z.strictObject({ paths: z.array(Glob).min(1).describe('Globs of the separate test files') }),
  z.strictObject({
    projects: z
      .array(z.strictObject({ path: ReportPath.describe('The test project folder') }))
      .min(1),
  }),
  z.strictObject({ inline: z.literal(true).describe('The tests live in the code files') }),
]);

export const TestMapModule = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Must be a module name such as "web"'),
  code: z.array(Glob).min(1).describe("Globs of the module's code"),
  tests: Tests,
  testReport: z
    .strictObject({ format: z.enum(['tap', 'junit', 'trx']), path: ReportPath })
    .describe('Where the confirmed check line writes the test report: a file or a folder pattern'),
  coverage: z
    .union([
      z.strictObject({ format: z.enum(['lcov', 'cobertura']), path: ReportPath }),
      z.literal('none'),
    ])
    .describe('Where the coverage report is written, or "none" for a module with no coverage tool'),
});
export type TestMapModule = z.infer<typeof TestMapModule>;

export const TestMap = z.strictObject({
  $schema: z.string().optional().describe('The JSON Schema of this file, for editors'),
  derivedFrom: z
    .strictObject({
      globs: z.array(ManifestGlob).min(1).describe('The manifest globs the map was derived from'),
      paths: z
        .array(RelativePath)
        .describe('The paths the globs matched when it was, as git names them'),
    })
    .describe('What the map was derived from, so a change to the manifests makes it stale'),
  modules: z.array(TestMapModule).min(1),
});
export type TestMap = z.infer<typeof TestMap>;
