// .foedrum/local.jsonc: what one machine says about a Brewery, git-ignored next to its event store
// (ADR 0063).

import { isAbsolute } from 'node:path';
import { Repo } from './events.ts';
import { z } from './zod.ts';

/**
 * A path on this machine, absolute, so it does not depend on the folder serve runs in: on Windows
 * with a drive or a UNC share, since `\\work` lies on the drive serve runs on.
 */
const AbsolutePath = z
  .string()
  .refine(
    (path) =>
      isAbsolute(path) &&
      (process.platform !== 'win32' || /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(path)),
    'Must be an absolute path, on Windows with its drive',
  );

export const LocalConfig = z.strictObject({
  workRoot: AbsolutePath.optional().describe(
    "The work root (ADR 0037); default <home>/.foedrum/<owner>.<name> of the Brewery's name",
  ),
  clones: z
    .record(Repo, AbsolutePath)
    .default({})
    .describe("The user's clone of each target repository, by owner/name"),
  keepAwake: z
    .boolean()
    .optional()
    .describe(
      "Whether brew and serve keep this machine awake while an attempt runs; before foedrum.jsonc's, default true (ADR 0195)",
    ),
});
export type LocalConfig = z.infer<typeof LocalConfig>;
