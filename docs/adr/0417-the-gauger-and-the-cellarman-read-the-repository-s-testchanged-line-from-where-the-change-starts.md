# 0417. The Gauger and the Cellarman read the repository's testChanged line from where the change starts

Date: 2026-11-17 · Status: Accepted · Amends [0242](0242-a-repository-can-name-a-fast-local-test-and-its-pull-request-checks-are-the-full-gate.md) (the two brewers that run tests while they work are told its `testChanged` line)

## Context
[ADR 0242](0242-a-repository-can-name-a-fast-local-test-and-its-pull-request-checks-are-the-full-gate.md) lets a repository set `testChanged` in `foedrum.jsonc`: a check step runs it in place of `test`, `{base}` replaced, and the pull request's checks run the full test.
Brewers never see `foedrum.jsonc`, so the Gauger and the Cellarman did not know the quicker line existed and ran the full `test` while they worked (#1135).
The Maltster already reads the Brewery's test line as an input of its own ([ADR 0376](0376-foedrum-init-writes-a-test-line-that-saves-its-reports-and-doctor-and-the-maltster-read-it.md)).

## Decision
- **A brewer input `test-changed`**: the attempt's repository's `testChanged` line on the platform the brewer runs on, `{base}` replaced by the commit the batch's change starts from, the same line a check step would run (`testChangedLine`, `src/checks/gravity.ts`).
  It reaches the brewer between the nonce tags, `source="the Brewery's testChanged line for <repo>, from commit <sha>"` ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)).
  It is left out when the repository sets no `testChanged`, and when the attempt has no repository of its own (a Brewery order's folder of checkouts).
- **`{base}` is the base the batch merged last, else its start**, as the check step's ([ADR 0164](0164-a-batch-merges-its-base-before-its-last-check.md), ADR 0242).
  The issue named the batch's start; after a base merge, a line from the start would also test the code the base brought in, which the batch did not change, and would differ from what the check step runs.
- **Only this platform's line**, where the test-line input names each platform's: the brewer runs the line here, while the Maltster maps the reports of every platform's line.
- The default Gauger (version 16) and Cellarman (version 19) name it `testChanged`, and each says one sentence: when there is a `testChanged` input, run it to check the work; the check step and the pull request's checks run the rest.
- The checks before a brewer's end ([ADR 0381](0381-a-brewer-that-writes-code-runs-the-quick-checks-before-its-end-and-is-sent-back-once.md)) keep running `test`, as ADR 0242 says.

**Brewery migration:** a Brewery that copied the default Gauger or Cellarman gets the input and the sentence by copying them again; one that does not keeps running the full test while it works, as before.

## Consequences
- In a repository that sets `testChanged`, the two brewers that run tests while they work run the quicker line, the one the check step runs after them.
- A brewer's own run says nothing new about the tests the line skips: the pull request's checks still run them, as ADR 0242 promised.

## Alternatives considered
- **`{base}` as the batch's start always**, the issue's words. Not taken: after a base merge it reads the base's own changes as the batch's.
- **Each platform's line, named, as the test-line input gives it.** The brewer would pick the line for its platform, which the engine already knows.
- **Change the Cellarman's checks before its end to `testChanged`.** ADR 0242 kept them as they are, and #1135 does not ask for it.
