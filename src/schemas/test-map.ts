// The test map, .foedrum/test-map.jsonc: per module of a target repository, where its code, its
// tests and its reports are; places only, never a command (ADR 0274).

import { SensitivePath } from './brewery-config.ts';
import { z } from './zod.ts';

/** A path glob relative to the repository, with `/` between folders, as a sensitive path is. */
const Glob = SensitivePath;

/** A report's file or folder pattern: `*` within a folder name, never `**` across folders. */
const ReportPath = Glob.refine(
  (path) => !path.includes('**'),
  'Must be a file or a folder pattern without "**", such as "svc/test/*/TestResults"',
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
      globs: z.array(Glob).min(1).describe('The manifest globs the map was derived from'),
      paths: z.array(z.string().min(1)).describe('The paths the globs matched when it was'),
    })
    .describe('What the map was derived from, so a change to the manifests makes it stale'),
  modules: z.array(TestMapModule).min(1),
});
export type TestMap = z.infer<typeof TestMap>;
