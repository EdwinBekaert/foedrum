# 0411. A Flight report calls equal passes the same and counts a run that measured nothing as not passed

Date: 2026-11-17 · Status: Accepted · Amends [0404](0404-the-flight-s-tasting-room-is-a-folder-of-orders-each-proved-by-its-hidden-tests.md) (how its rule reads equal counts) and [0409](0409-a-flight-brews-every-tasting-room-order-on-a-recipe-as-it-ships-or-with-one-brewer-swapped.md) (the comparison it left to #1084)

## Context
ADR 0404 set the rule a report of two Flights follows: a difference only when one setup passes every run and the other at most one; anything else is "too close to call".
ADR 0409's Flight records each run of each order in `results.jsonl`, and brews a run that left no head once more, so a Flight can end with a run that measured nothing.
Nothing compared two Flights, and three cases the rule does not name decide what the report says: two Flights that pass an order equally, a run that measured nothing, and an order only one Flight has.

## Decision
- **`node scripts/flight-report.ts --baseline <Flight folder> --candidate <Flight folder>`**, by hand, reads both folders' records with the harness's reader, prints the report and writes it as `report.md` in the candidate's folder.
  Its options and refusals go through one tested function, `flightReportRun` in `scripts/flight/report.ts`; a missing option, or a folder with no records, exits 2.
- **Each order both Flights measured gets one row:** each Flight's hidden tests passed ("3 of 3 against 1 of 3"), its runs with changes outside the order's paths, its tokens and brewers' time per measured run, and a verdict.
- **Decided in #1084's plan on 2026-11-17: equal pass counts of an equal number of runs are "the same", a verdict of their own**, apart from "too close to call".
  3 of 3 against 3 of 3 is no near miss, and the summary's "too close to call" count is to hold only the orders that differ without meeting the rule, as #1084's example line reads.
  With unequal runs, equal counts are not the same: 1 of 3 against 1 of 1 is ADR 0404's difference, and 3 of 3 against 3 of 5 is too close to call.
- **Decided in #1084's review on 2026-11-17: a difference needs the other Flight not to have passed every run.**
  Two Flights of unequal runs that both passed every run of an order, such as 1 of 1 against 3 of 3, are too close to call: the side with at most one pass did not fail, so a shorter Flight never makes a difference easier to call.
- **Decided in #1084's plan on 2026-11-17: a run that measured nothing counts as a run that did not pass.**
  An order's passes are out of its Flight's runs, the highest run number the Flight recorded, so a Flight that stopped short of an order's last runs did not pass them either.
  A setup "passes every run" only when it passed as many runs as its Flight recorded: a difference is never called from fewer runs than the Flight brewed.
  The records do not say how many runs a Flight was asked for, so a Flight stopped after its first runs counts only those: 1 of 1 against 0 of 3 is still called, and a person reads the Runs column of each Flight's own table.md before trusting a report of two Flights of unequal runs.
  The other columns are over the runs that measured something.
- **Decided in #1084's plan on 2026-11-17: an order only one Flight has, or that one Flight measured no run of, is listed under the table and left out of every count.**
  There is nothing to compare it with, and counting it on one side would move that side's total for an order the other never brewed.
- **One summary line:** "<baseline>: X of N orders, <candidate>: Y of N orders, K too close to call, tokens per order +P%".
  N is the orders both measured, X and Y those each Flight passed every run of, and P the candidate's tokens per run, summed over those orders, against the baseline's, rounded with its sign; when the baseline counted no tokens, the line says the tokens are not compared.
  A Flight is named by its recipe, "as it ships" or "with <brewer> on <model> at <effort>"; never a cost in money.

### A Brewery's files
None: this is a development script of Foedrum's own repository, run by hand on scratch folders, and nothing in a Brewery changes.

## Consequences
- A model or recipe change is judged by two command lines and one report, with the rule written before the runs.
- With 3 runs, an order differs only at 3 of 3 against 0 or 1 of 3; a run that measured nothing makes a difference harder to call, never easier.

## Alternatives considered
- **Equal counts as "too close to call":** the summary would count every order both Flights solved alike as a near miss.
- **Passes out of the runs that measured something:** 2 of 2 measured would pass "every run" of a Flight that brewed 3, calling a difference on less than the rule's evidence.
- **A mode of `flight.ts`:** the report reads two finished Flights and brews nothing, so it is a script of its own over the same records.
