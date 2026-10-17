# 0060. The local gate refuses `gh pr ready` until the review summary for the head is on the pull request

Date: 2026-10-17 · Status: Accepted · Amends [0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) (what the gate reads) and [0056](0056-the-gate-pre-filter-reads-the-command.md) (the pre-filter's words)

## Context
CLAUDE.md says to open pull requests as drafts and run `/brew-review` before marking them ready, but nothing enforced it. #153 was marked ready after only `/brew-review --red-proof`, because the session's prompt listed the closing steps without the review and the session took that list as the whole procedure (#154). A rule that depends on how a prompt is worded will be skipped again.

The review skill posts its summary as a comment headed ``## Review: `<branch>` @ `<short head hash>` `` (`summary-template.md`). That heading is what the gate can check: whether the pull request has a summary, and for which head. A summary is often posted before a merge of `origin/main` is pushed (#146), and that merge brings in only commits that are already on the base.

## Decision
- **`gh pr ready` needs the summary for the head.** The gate reads `gh pr ready` the way it reads pushes and merges (ADR 0045): in both shells, behind wrappers, other shells and evaluators, and with a computed `gh` taken as the worst case. Before letting it through, it looks the pull request up with `gh` in the hook's working directory: `gh pr view [<n>] [--repo <r>] --json number,url,headRefOid,comments`, then the pull request's commits with their parents (`gh api repos/<owner>/<repo>/pulls/<n>/commits`, which `gh pr view` leaves out). Each call gets 30 s.
- **What counts as covering the head.** A summary heading in any comment whose hash is the head's, or names a commit of the pull request after which every commit of the branch is a merge. The commits of a pull request are those not on its base, so a merge of the base adds the merge commit and nothing else; a commit of the branch's own after the review is not a merge, and fails. The heading is matched at the start of a line, in any comment, by anyone.
- **What is refused.** No summary, a summary for an older head with work after it, and a pull request that cannot be looked up (the gate fails closed), each with one line that names `/brew-review <n>` as the remedy. A pull request or repository computed at run time (`gh pr ready $n`) is blocked without a lookup, since the gate cannot tell which one it is.
- **`gh pr ready` runs as a command of its own.** The lookup happens before the command runs, so in `git push && gh pr ready <n>` it would see the head from before the push, and new work would be marked ready unreviewed. With `gh pr create` the pull request does not exist yet. So `gh pr ready` in the same command as a push or `gh pr create` is blocked without a lookup, which also keeps the lookups out of the check's 540 s budget under the hook's 600 s. So is `gh pr ready` in a command that mentions `GH_REPO` or `GH_HOST`, which gh reads and the lookup would not; `-R` names the repository instead, and the last `-R` counts, as in gh.
- **`gh pr ready --undo` always passes.** Turning a pull request back into a draft needs no review.
- **The `gh api` form is blocked, not checked.** A `gh api` call that mentions `markPullRequestReadyForReview` names the pull request by its node ID, often through a variable, so the gate cannot tell which pull request it is without parsing GraphQL and making another lookup. It is refused with the remedy `gh pr ready <n>`, which does the same thing and which the gate can check. #154 asked for it to be checked like `gh pr ready`; refusing it always is the smaller change, and costs a session nothing it needs. A `gh api graphql` call whose query the gate cannot read (`query=@file`, `--input`, or a query computed at run time) is blocked too, since it may be that mutation; give the query inline.
- **Aliases.** Defining a `gh` alias that marks a pull request ready is blocked, like one that pushes, merges or opens a pull request.
- **`ready` joins the pre-filter's words**, so a `gh` computed at run time before a literal `pr ready` is still parsed (ADR 0056 kept `push` and `merge` for the same reason).

## Consequences
- Marking a pull request ready from a Claude Code session needs the review summary, whatever the session's prompt says. The rule no longer depends on its wording.
- `gh pr ready` costs two GitHub calls, about two seconds, and fails when GitHub cannot be reached; the remedy then is to retry, not to work around the gate. A refusal quotes at most one short line of what gh said.
- Pushing and marking ready take two commands, and so does reading data with a GraphQL query kept in a file.
- The gate checks that a summary exists for the head, not what the review found or whether its findings were addressed (#43).
- Anyone who can comment on the pull request can post a heading that satisfies the gate. The gate guards against mistakes by sessions, not against a determined adversary (ADR 0045).
- A merge commit may carry changes of its own (a resolved conflict); the gate counts it as a merge. A summary older than the 100 comments `gh pr view` returns, or a pull request with more commits than GitHub lists (250), may be refused.
- `gh pr ready` without a number asks gh for the current branch's pull request in the hook's working directory: `cd elsewhere && gh pr ready` checks the wrong one, as with pushes. Give the number.
- Every word that contains `ready` now sends a command to the parser, which costs a few milliseconds.

## Alternatives considered
- **Check the `gh api` mutation too:** needs the GraphQL query and its variables read, and a lookup from node ID to pull request; the gain is a second way to do what `gh pr ready` does.
- **Check the comments' author:** the summary is posted from the same account as everything else in this repository, so it would tell nothing.
- **Compare with a local `git` instead of GitHub's commit list:** the local `origin/main` and branch may be behind what is on GitHub, which is what marking ready acts on.
- **A permission rule (`ask` on `gh pr ready`):** the user would approve the step without seeing whether the review ran.
