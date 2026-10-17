// .foedrum/local.jsonc: what one machine says about a Brewery, git-ignored next to its event store
// (ADR 0063).

import { isAbsolute } from 'node:path';
import { Repo } from './events.ts';
import { z } from './zod.ts';

/** A path on this machine, absolute, so it does not depend on the folder serve runs in. */
const AbsolutePath = z.string().refine(isAbsolute, 'Must be an absolute path');

export const LocalConfig = z.strictObject({
  workRoot: AbsolutePath.optional().describe(
    "The work root (ADR 0037); default <home>/.foedrum/<owner>.<name> of the Brewery's name",
  ),
  clones: z
    .record(Repo, AbsolutePath)
    .default({})
    .describe("The user's clone of each target repository, by owner/name"),
});
export type LocalConfig = z.infer<typeof LocalConfig>;
