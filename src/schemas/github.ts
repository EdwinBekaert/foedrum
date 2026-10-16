// What Foedrum reads of GitHub's answers: only the fields it uses, checked, since they come from
// outside the process (ADR 0033). Unknown fields are ignored; GitHub adds them freely.

import { CommitSha } from './store.ts';
import { z } from './zod.ts';

/** `POST /repos/{owner}/{repo}/git/commits` and `GET .../git/commits/{sha}`. */
export const GitCommit = z.object({ sha: CommitSha, message: z.string().optional() });

/** `GET /repos/{owner}/{repo}/git/ref/{ref}`: one ref, never the list a partial name gives. */
export const GitRef = z.object({
  ref: z.string(),
  object: z.object({ type: z.string(), sha: CommitSha }),
});

/** A REST error's body. */
export const GitHubError = z.object({ message: z.string() });

/** The GraphQL answer to `repository(owner, name) { id }`. */
export const RepositoryId = z.object({ repository: z.object({ id: z.string().min(1) }) });
