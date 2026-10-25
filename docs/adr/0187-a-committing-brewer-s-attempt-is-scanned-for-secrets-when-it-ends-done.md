# 0187. A committing brewer's attempt is scanned for secrets when it ends done

Date: 2026-10-25 · Status: Accepted · Amends [0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md) (the scan also runs when a committing brewer's attempt ends `done`; the push's scan stays the last line) and [0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md) (what a `done` with commits needs)

## Context
The push scans every commit of a batch for what looks like a secret ([ADR 0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md)), once, in the openPullRequest action, at the end of the recipe.
A finding makes the batch Stuck, and the ledger keeps the refusal for the batch's life: a rewind does not scan again, so a person rewrites the commits by hand, cancels the batch and pushes, or orders it again.
On the fourth brew (batch 9-1, #442) the Gauger's first commit held three key-shaped test fixtures as literals (an AWS key id, a GitHub token, a URL with a token query).
Every later step built on that commit, and only the push refused it.

A failed attempt never becomes part of the task tree ([ADR 0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md)): a fresh retry starts where the failed attempt started, and its commits are gone from what the next step sees.
So a scan when the step's attempt ends lets its retry write the fixture another way, as the repository does (`['ghp', …].join('_')`), with no rewrite and no person.

## Decision
- **When a committing brewer's attempt ends `done` with commits, the runner scans them** before the attempt counts as succeeded: the commits from the attempt's start (the limits' `commitsSince`, where its worktree started, [ADR 0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md)) to the tip of its branch in the clone, never in its worktree.
  It is the push's scan: `secretScan` of `src/workspace/branch-push-git.ts`, with the same git environment and flags ([ADR 0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md)), so what fails the attempt is what would stop the push (`scanAttemptCommits`, `src/workspace/attempt-commits-git.ts`).
  A commit before the start is not the attempt's and is not read: the step before scanned it.
- **A finding fails the attempt retryably**: `the attempt's commits hold what looks like a secret, or what the scan cannot read (ADR 0187): commit <sha>, <kind> in <place>; …`, naming the first three findings and counting the rest, as the refused push does (`scannedEnding`, `src/engine/brewer-runner.ts`).
  It names each commit, place and kind, never the matched text or `findSecrets`' excerpt of it ([ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md)).
  A commit is named by its first 12 characters: the failed attempt's commits are not ones the folded state knows (`knownCommits`), so a full hash would read as a key and the status comment would leave the whole reason out.
  The reason itself passes `findSecrets`, so the status comment and the receipt show it like any other failed attempt's.
- **The attempt's retry is told why.** A fresh retry starts at the unchanged task tree, so the commit is gone; without the reason it would write the same literal again.
  The plan of a retry whose attempt before failed by the scan gives it one input with that reason, and the advice to write such text so it does not look like a secret, for example built at run time; a reason that looks like a secret is left out as a route's is (`leftOutReason`).
  The failed outcome carries `scanned: true`, so the plan knows it from the event log.
- **A git failure while scanning blocks the attempt on its environment**, as git's failure while counting does (ADR 0074): `the commits since <start> were not scanned for secrets: <reason>`.
  A stop while it scans ends the attempt cancelled.
- **The push's scan stays as it is**, the last line: commits that no attempt's scan read still reach it (a merge of the base before the last check, ADR 0164; a rewind's commits, ADR 0025; a step whose brewer does not produce commits but commits anyway, ADR 0066), and it is the one point every pushed commit passes.

## Consequences
- A brewer that commits a key-shaped literal costs its step one attempt, not the batch: the retry writes it another way, and the batch goes on.
- A binary file, or more than 4 MiB of changes, fails the attempt too, as it would stop the push; the step uses its attempts and goes Stuck with the reason, which a person reads earlier than at the push.
- A brewer that resumes its session on a retry (`retryMode: resume`, [ADR 0117](0117-a-retry-resumes-the-session-of-the-attempt-before-it-in-that-attempt-s-worktree.md)) continues on the same branch, so its retry must rewrite the commit to pass, which its git rules may not allow; no default brewer resumes on a retry.
- Each committing attempt that ends `done` costs three `git log` calls and a `rev-parse` in the clone, and a `cat-file` call when a hexadecimal word turns up.
- The push may now refuse less often, but its refusal, and its summary, do not change.

## Alternatives considered
- **Scan every attempt that made commits, however it ended:** a failed or blocked attempt's commits never reach the task tree, so the scan would cost git calls for nothing.
- **Scan in the attempt's worktree:** the worktree's git files are the brewer's to write; the clone's branch is where the attempt's commits are counted (ADR 0074).
- **Move the scan from the push to the attempts:** commits no attempt made reach the push too, and the push is the last point before anything leaves the machine.
- **Every retry is told why the attempt before it failed:** a wider change of what every retry costs and reads, for every reason; left to an issue of its own if retries need it.
