# 0422. The merge brief names the files to read first and a review effort

Date: 2026-11-17 · Status: Accepted · Amends [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (the push's ledger result keeps how large its change is), [0225](0225-a-ready-pull-request-gets-a-merge-brief.md) (a line under the verdict) and [0384](0384-the-merge-brief-names-by-fixed-checks-what-to-look-at-before-merging.md) (the push also records how large its change is)

## Context
The merge brief tells the person who merges that a pull request is ready, why, and what to look at before merging ([ADR 0225](0225-a-ready-pull-request-gets-a-merge-brief.md), [ADR 0384](0384-the-merge-brief-names-by-fixed-checks-what-to-look-at-before-merging.md)).
It does not say where to start reading, nor how long a careful read takes (#820).
The idea came from prior art, a review that estimates its own effort and names the files to read first.
The maintainer settled the scope on #820 (2026-11-17): Foedrum computes the line with no model; "Read first" lists the files the Tasters' findings point at most, then the files with the largest changes; the effort, from 1 to 5, comes from the size of the change; no Taster writes it, and nothing says whether the change could be split.

## Decision
- **Recorded once, at the push**, as ADR 0384 records what to look at (`PushResult.size`, `src/schemas/store.ts`): the push effect reads the change's lines from where it starts to the commit pushed (`BranchPush.changedLines`, `git diff --numstat -z --no-renames`, read as committed as `touchedFiles` is) and records them with `sizeOf` (`src/engine/read-first.ts`).
  - The lines of a file are the lines it adds and deletes; a binary file has none. The secret scan refuses a push whose commits add one ([ADR 0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md)), and a push a person allows goes without a scan ([ADR 0420](0420-foedrum-answer-allow-lets-a-refused-push-of-one-exact-commit-go-with-who-and-why.md)), so a binary file reaches the size through such a push, counted among the files.
  - Lock files (ADR 0384's list) are left out: their churn is not review work, and the look line already names them.
  - The record keeps the changed lines, the changed files, a binary one too, and the 100 largest files with their lines, the most lines first, then by path; a binary file is never among them.
  - A change of lock files only records no size.
- **Read first**: at most three of the files the push recorded among the largest, those the Tasters' findings point at most first, then the most changed lines, then the path in code-unit order (`readFirstLine`).
  - A finding counts once for each round that recorded it: each finished attempt of each Taster's step on the head, an earlier recipe's too, since its commits are on this head as its rounds' dispositions are, the findings of its out doc when it succeeded and its recorded findings when it was blocked by them, as a later round's input reads them.
  - A finding's file is a model's words, which ADR 0225 shows only under the Findings heading, so a finding counts only for a file the push recorded; the line names only paths git gave.
  - A finding's file is read in the form git writes a path, `\` as `/` and without a leading `./`, so `./src/a.ts` counts for `src/a.ts`.
- **The review effort** (`reviewEffortOf`, a name apart from a step's effort, [ADR 0397](0397-recipe-steps-name-a-model-level-and-an-effort-of-foedrum-s-own-which-models-jsonc-translates-for-the-agent.md)), by the change's lines: 1 up to 50, 2 up to 200, 3 up to 400, 4 up to 1000, 5 past that.
  The cuts are the maintainer's to tune.
  About 50 lines is a small fix read in one short sitting; about 200 is what a reader takes in without notes; about 400 is about an hour's careful reading; past about 1000 the read takes several sittings.
- **The line**, its own paragraph after the look-before-merging line, or right under the verdict when there is none: `**Read first:** a.ts, b.ts · effort 3 of 5 (312 changed lines in 7 files).`
  The paths are escaped with `plain`, as the look line's are.
  With no file to name (only binary files beside lock files) it is `**Effort:** 1 of 5 (0 changed lines in 1 file).`
  A push that recorded no size gives no line.
- **Never a block**: as the look line, nothing reads it to hold or route the pull request.

## Migration
None: Foedrum has no release.
A person now sees, under the verdict of each new merge brief, which files to read first and how long the read takes.

## Consequences
- One more `git diff` per push of a batch with a recorded start.
- A push recorded before this change has no size: its brief has no read-first line.
- A finding on a file past the 100 largest does not count.
- The effort reads lines only, not how many files or how spread out the change is.

## Alternatives considered
- **A Taster writes the files and the effort in its out doc**: a model's estimate, and one more field every Taster's prompt carries, where the engine already holds the facts (the maintainer, #820).
- **Say whether the change could be split**: only a model could judge it (the maintainer, #820).
- **Read the size when the brief is written**: the brief would read git, and a later push by someone else could change what it says of Foedrum's own push (as ADR 0384 found).
- **Name a finding's file as the Taster wrote it**: model text outside the Findings heading, against ADR 0225.
- **Read the sizes through `touchedFiles`**: its one call would change shape for every caller and test; a second diff costs one git call per push.
