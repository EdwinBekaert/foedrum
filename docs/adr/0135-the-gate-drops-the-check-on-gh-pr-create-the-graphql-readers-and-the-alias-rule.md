# 0135. The gate drops the check on gh pr create, the GraphQL readers and the alias rule

Date: 2026-10-22 · Status: Accepted · Amends [0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) (no alias rule, no check on `gh pr create`), [0060](0060-the-gate-refuses-gh-pr-ready-without-the-review-summary.md) (the `gh api` forms of marking ready are no longer read) and [0104](0104-the-gate-checks-the-tree-a-command-pushes.md) (only a push has a tree to check) · Supersedes the GraphQL parts of [0108](0108-the-gate-blocks-merges-through-gh-api.md)

## Context
The local gate (`scripts/precheck.ts`) owns one row of [docs/trust-boundaries.md](../trust-boundaries.md): a session skipping the procedure by accident. ADR 0045 says it guards against mistakes, not a determined adversary, and that the ruleset on `main` is the line that holds. Since then three of its rules grew past that row (#360, decided in the safeguard audit of 2026-10-22):

- **`npm run check` before `gh pr create`.** A session pushes its branch, and the push ran the check on that tree, before it opens the pull request. The second run checks the same tree again: a full suite per pull request for nothing. It also brought its own blocks (a `gh pr create` in a directory computed at run time, or outside the project) that existed only because the check would run there.
- **Reading GraphQL through `gh api`.** The merge mutations (`mergePullRequest`, `enablePullRequestAutoMerge`, `enqueuePullRequest`), the ready mutation (`markPullRequestReadyForReview`), and a query the gate cannot read (`query=@file`, `--input`, a variable) sent to the GraphQL endpoint in every form gh accepts: `/graphql`, full URLs, an endpoint built at run time, dot segments and percent-escapes (ADR 0108, #314, #329). Each round of review found another form. The proof was review findings, never an incident: no session has merged or marked ready through GraphQL. Merging is owned by the pull request row: the ruleset on `main` requiring `ci-ok`, and the maintainer's merge.
- **Blocking git and gh aliases that push, merge or open a pull request** (`git config alias.*`, `git -c alias.*=`, `gh alias set`). A session that writes such an alias instead of running the command is evading the gate on purpose; that is the adversary ADR 0045 says the gate is not built for.

CLAUDE.md (Security) keeps a safeguard only with proof that it is needed and no other layer owning the risk. These three fail that test.

## Decision
- **`gh pr create` runs no check.** Only `git push` gets the detached-HEAD check, the `node_modules` check, the denylist scan of its commits and `npm run check`, in the tree it pushes (ADR 0104). The blocks that existed for `gh pr create`'s check go with it: from a directory computed at run time, from outside the project, and from two directories in one command. `gh pr ready` is still blocked in the same command as `git push`, whose lookup would see the old head.
- **The gate does not read GraphQL.** No mutation names, no GraphQL endpoint forms, no unreadable-query rule. ADR 0108's GraphQL parts are superseded; its REST part stays.
- **No alias rule.** Alias definitions are not read; an alias defined earlier was never followed anyway (ADR 0045).

What stays:
- `npm run check` before `git push`, in the tree it pushes, with the detached-HEAD and `node_modules` checks;
- `gh pr merge` blocked in every form the reader sees, a `gh pr` action computed at run time blocked, and the REST merge through `gh api`: a `PUT` (or a method computed at run time) to `…/pulls/<n>/merge` (ADR 0108);
- `gh pr ready`'s review summary check (ADR 0060, 0067);
- force, delete and mirror pushes blocked;
- the recursive delete of a path built from a variable (ADR 0102) and the `npx` rules (ADR 0065);
- the personal denylist, for pushes and for what gh posts (ADR 0114, 0132);
- reading commands as the shells would (ADR 0045), which every rule above needs.

## Consequences
- A pull request costs one check run, the push's, instead of two.
- `scripts/precheck.ts` and its tests lose the GraphQL endpoint parser, the query reader, the alias reader and `gh pr create`'s places, about 150 lines of code and 250 tests.
- A session can merge, enable auto-merge or mark a pull request ready through `gh api graphql`, or hide a push behind an alias. Neither is a mistake a session makes by accident. A merge into `main` still needs `ci-ok` under the ruleset, and the maintainer reviews what lands; a pull request marked ready without a review is visible on the pull request, which has no summary comment.
- `gh pr create` from another directory or a computed one now passes: it runs nothing of that tree's code.

## Alternatives considered
- **Keep the GraphQL readers and fix each form as it is found:** the list of forms has no end (#314, #329), and every fix guards a path no session has taken.
- **Block every `gh api graphql` call:** sessions and skills read through GraphQL; and it still would not cover `gh api` with a full URL computed at run time.
- **Keep the check on `gh pr create` only when no push ran in the session:** the gate has no memory between calls, and the pull request's CI runs the check anyway.
