---
paths:
  - "**/*.{ts,tsx,mts,cts}"
---

<!-- Generated from .foedrum/house-yeast/ by npm run house-yeast:rules; do not edit. -->

# House yeast

Rules learned from reviews of Foedrum's own pull requests (ADR 0122), for the files this session reads or changes (ADR 0271). Follow them where your change meets them: /brew-review looks for what they describe.

## comments-count-what-the-change-runs (semantic)

A comment that counts or names what a run does (its attempts, its recipe) is reworded in the change that alters the run, in every file that repeats the count, found by searching for the old words.

## compare-paths-in-one-normal-form (semantic)

Code that compares two paths brings both sides to one form first (normalized, no trailing slash, and lower-cased where a case-insensitive file system such as macOS's can hold them), never only the side it builds itself.

## each-guard-condition-has-its-own-case (semantic)

A guard made of several conditions (a phase check, an outcome check, a walk back over retries or answers, a repository match) has a test for each condition that only that condition rejects, so deleting or loosening any one of them fails a test.

## fixtures-out-of-order-for-sorts-and-keys (semantic)

A test of a sort or of state kept per key feeds its input out of order and interleaved across keys, so dropping the sort, a tiebreak or the key fails it.

## path-inside-test-has-sibling-near-miss (semantic)

Code that decides whether a path lies inside a folder has a test with a sibling whose name starts with that folder's name (/home/adam beside /home/ada), and one with the root as the folder.

## tool-error-fixture-from-the-tool (semantic)

A test fixture that stands for another tool's or module's output (an error text, a report it prints) builds it from that tool or module when the test can call it in process, so the test breaks when the real format drifts.

## unread-file-claims-nothing (semantic)

A report about a file's content says nothing of a file it could not read beyond that it could not: a comparison with an unread file is never worded as a match or a difference.
