# 0445. The Flight report shows the spread of the runs and says when a token or time difference is within it

Date: 2026-11-27 · Status: Accepted · Amends [0411](0411-a-flight-report-calls-equal-passes-the-same-and-counts-a-run-that-measured-nothing-as-not-passed.md) (the summary's tokens figure says whether it is within the spread of the runs, and a figure for brewers' time follows it) and [0425](0425-the-flight-shows-tokens-by-kind-and-how-each-run-ended-beside-the-score.md) (the row's tokens in sum and its time show the lowest and highest run beside the mean)

## Context
The report gave the mean per run of tokens and of brewers' time, and one bare figure for tokens in the summary.
Nothing showed how far the runs of one order differ from each other.
The same comparison, cellarman in nip on claude-opus-5-5 against nip as it ships, said −21% tokens on 2026-11-17 (one run per order) and +5% on 2026-11-19 (three runs per order, #1186): the difference between runs was larger than the difference the summary reported.
Hidden-test passes already have a rule for this ([ADR 0404](0404-the-flight-s-tasting-room-is-a-folder-of-orders-each-proved-by-its-hidden-tests.md), ADR 0411); tokens and time had none.

## Decision
- **Each order's row shows the lowest and the highest run beside the mean**, for tokens in sum and for brewers' time, on both sides: `520705 (480112–566030) against 560788 (530220–601455)`, and `30 s (20–40 s) against 15 s (10–20 s)`.
  The columns of the tokens by kind keep the mean only.
  The lowest and highest are over the runs that measured something, as the mean is.
- **The summary says whether the difference is real**, for tokens and, in its own words, for brewers' time.
  For each Flight it adds up each order's lowest run and, apart, each order's highest run, over the orders both Flights measured: the lowest and highest total the Flight's runs allow.
  When the two Flights' ranges overlap (they touch or share a point), the figure reads `tokens per order +5%, within the spread of the runs (baseline 6.1M–6.9M, candidate 6.4M–7.3M)`, with tokens in millions of one decimal; time reads `brewers' time per order +16%, within the spread of the runs (baseline 210–290 s, candidate 250–330 s)`, in whole seconds.
  When they do not overlap, the figure stands alone, as before.
  The percent stays the difference of the means.
- **A Flight of one run per order says so**: when either Flight has one run per order, the summary ends with `one run per order: no spread to compare against`, in place of the within-the-spread wording.
- **The tasted entry is unchanged**: `defaults/models.jsonc` keeps the means ([ADR 0416](0416-models-jsonc-keeps-a-tasted-list-the-latest-flight-of-each-brewer-recipe-level-and-effort.md), [ADR 0426](0426-a-tasted-entry-requires-its-tokens-per-order-split.md)).
- **The verdict stays the hidden-test rule**: tokens and time never change an order's verdict.

## Consequences
- A reader sees whether a token or time difference is larger than the difference between the runs of one side, instead of one figure that three runs per order may overturn.
- The summary line is longer.
- The sums of the lowest and of the highest runs are bounds, not a confidence interval: a Flight of two runs has them too.

## Alternatives considered
- **A statistical test:** three runs per order are too few for one to mean anything; the overlap of the bounds is a plain rule a reader checks by eye.
- **The spread in the tasted entry:** the entry's `tokensPerOrder` is the mean a later token guess reads, so the spread stays in the report.
