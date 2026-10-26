# 0209. A check that fails on an open pull request's merged tree is posted on it

Date: 2026-10-26 · Status: Accepted · Amends [0203](0203-an-open-pull-request-s-checks-run-on-its-merged-tree-when-its-base-moves.md) (a failure on the merged tree is posted on the pull request, not only in the status comment) and [0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md) (the conflict comment's effect posts a second kind of comment)

## Context
Since [ADR 0203](0203-an-open-pull-request-s-checks-run-on-its-merged-tree-when-its-base-moves.md) Foedrum runs an open pull request's checks on its merged tree when its base moves, and records the first reading that did not pass on `pull_request.base_checked` (`failed`), or why the checks did not run (`unchecked`).
Only the batch's status comment on the Brewery issue shows it: the person looking at the pull request sees nothing (#526).
A conflict is already posted on the pull request, through the ledger, when it first appears or its files change ([ADR 0198](0198-an-open-pull-request-is-merge-tree-checked-when-its-base-moves.md)).

Three facts shaped it.
Each base move runs the checks again, so a pull request that stays broken records the same failure on every merge into its base.
The reading's tail is text a brewer's code may have printed, and a pull request on a public repository is read by anyone.
And an effect is found by its marker in the Brewery's own comment ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md)), so a comment that quotes a marker would be found as the post it names.

## Decision
- **A failure is posted when its check first fails** (`failurePosts`, `src/engine/base-check.ts`): a check with `failed` whose pull request's check before it, if any, was clean, conflicted, unchecked, someone else's push, or failed another check.
  - **The same check failing again on the next move posts nothing**, whatever its exit code or tail: one comment per stretch of failures, as one per set of conflicting files.
  - **A check is the one the status line names** (`checkOf`, `src/engine/status-comment.ts`, which `readingText` now names it with): the setup and its command, a named check and its command, or a literal command. The post and the status line can never disagree on whether it is the same check. A named check whose command the repository changed counts as another check, and posts again: rare, and the post then names the command that failed.
  - **`unchecked` posts nothing.** It says the run could not start (a worktree, a setup the repository no longer names), a fault of the machine or the Brewery's configuration, not of the pull request: the person on the pull request can do nothing about it, and it would post on every pull request at once. The status line says it.
  - **A pass after a failure posts nothing.** The failure's comment stays where it was; the status line says it "passes its checks … again", as it says a conflict merges cleanly again.
  - A failure after an `unchecked`, a conflict or a pass posts again, the same check included: the stretch of that failure ended.
- **Numbered on its own, from 1, under its own key** `[batch, "base_check_failed.<n>"]`, beside `[batch, "base_conflict.<n>"]`, whose numbering does not change: a log that already holds `base_conflict.2` posts nothing again. Both are due from the same effect (`baseConflictEffects`), so the driver's wiring is as it was. Each post is a pure function of the recorded checks, and the comment is found by its marker before it is applied, so a kill between the record and the post, or between the post and its ledger entry, posts once (ADR 0033).
- **Due only while the batch is On tap and the pull request has no recorded end**, as a conflict's. A pull request someone else pushed to is checked no more (ADR 0198), so it records no failure and gets no post.
- **The text**: the conflict's heading (`### Foedrum · batch <id>`), that the base moved to its full tip, that the pull request merges with it cleanly but no longer passes its checks there, the failing check as the status line says it (`readingText`, escaped by `plain`), the reading's tail, and that the batch stays On tap and that Foedrum checks the commit it pushed.
  - **The tail goes in a fenced code block whose fence is one backtick longer than its longest run of backticks**, three at least, as `codeCell` does for a code span: no line of the tail can close it. An empty tail, or a skipped reading, shows none.
  - **Each `<!--` in the tail is posted as `<!- -`**: a check's output could print the marker of a later post, `[batch, "base_check_failed.<n+1>"]`, whose batch id is on the pull request, and that later post would then be found as posted and never made. Inside a code block nothing else is markup: no mention, no link and no HTML renders. The conflict comment's file names, which whoever committed them chose, cannot carry a marker: `plain` writes each `<` as `&lt;`, so its text never holds `<!--` (a regression test says so).
  - **Nothing else is filtered at the post.** The tail is the one recorded, which `readingOf` (`src/checks/gravity.ts`) already cut to `MAX_TAIL_LENGTH` and read for secrets before it was recorded, every line that looks like one, a 40-character commit hash included, replaced by a fixed line ([ADR 0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md), #177). It has done so since 93985bdf (2026-10-17), before `failed` existed, so every `failed` in any log was read that way; the check runner is the one writer of a reading, and the post would only read the same patterns again. The check's name and command come from the Brewery's configuration, which a person wrote (ADR 0088).

## Consequences
- An open pull request whose merged tree fails a check gets one comment naming the check, the base's tip and the end of the check's output, within a pass and a run of its base moving.
- A pull request that stays broken over many base moves gets one comment, not one per move; a different check failing gets one more.
- The tail, which the state branch already holds, is now also on the pull request.
- A tail that quotes `<!--` shows `<!- -` there.
- One more ledger entry per post; no new event and no change to the fold or the admission.

## Alternatives considered
- **One numbering for both kinds**: a failure would take the next number after the conflicts, but a log written before this decision would then have its existing `base_conflict.<n>` entries renumbered, and a post that was made could be made again. Two numberings keep each kind's posts fixed by its own history.
- **Post every failure, once per tip**: a busy base would comment on every merge into it with the same failure.
- **Post `unchecked` too**: a broken setup or worktree would comment on every open pull request, which none of their authors can fix.
- **Post when the checks pass again**: the status line says so; a comment for each recovery doubles the noise of a flaky check.
- **A check's identity by its name alone, else its command**: closer to the issue's wording, but a second function beside the status line's naming, which could disagree with it.
- **Read the tail for secrets again at the post**: the same patterns over the same text, which was read before it was recorded.
- **Leave out a line of the tail that holds a marker**: hides the very output a failing test may be about; opening the comment changes only its markup.
