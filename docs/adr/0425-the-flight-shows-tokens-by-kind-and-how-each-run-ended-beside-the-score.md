# 0425. The Flight shows tokens by kind and how each run ended beside the score

Date: 2026-11-19 · Status: Accepted · Amends [0409](0409-a-flight-brews-every-tasting-room-order-on-a-recipe-as-it-ships-or-with-one-brewer-swapped.md) (the table splits its tokens and shows the ending beside the score; a missing option value is a refusal), [0411](0411-a-flight-report-calls-equal-passes-the-same-and-counts-a-run-that-measured-nothing-as-not-passed.md) (the report splits its tokens, shows the endings and counts the runs that reached a pull request) and [0416](0416-models-jsonc-keeps-a-tasted-list-the-latest-flight-of-each-brewer-recipe-level-and-effort.md) (the entry keeps `tokensPerOrder` apart by kind; the description's sentence reads plainly)

## Context
The first real Flight (2026-11-17, nip, 10 orders, 1 run each) showed 7,935,142 tokens in one number: 1,110 fresh input, 248,272 output, 6,473,834 cache reads (82%) and 1,211,926 cache writes (15%).
Cache reads cost far less per token than output, so one sum overstates what a Flight costs, and the `tasted` list's `tokensPerOrder` ([ADR 0416](0416-models-jsonc-keeps-a-tasted-list-the-latest-flight-of-each-brewer-recipe-level-and-effort.md)) and `foedrum taste`'s token guess (#1143) would carry the same overstatement.
That Flight also ended shelf-tags stuck, with no pull request, yet [ADR 0409](0409-a-flight-brews-every-tasting-room-order-on-a-recipe-as-it-ships-or-with-one-brewer-swapped.md) scores a run on the commit its green step read, so the table showed "Hidden tests passed 1 of 1" and nothing said the batch never finished.
Decided by the maintainer on 2026-11-17 (#1161): keep ADR 0409's scoring, and show the ending beside it.

## Decision
- **The table and the report keep the sum and add the kinds**: output, cache read, cache write and fresh input (the input the cache neither read nor wrote), each summed over an order's measured runs in the table and a mean per measured run in the report.
- **The table and the report show how an order's runs ended** in an "Ended" column, grouped by the word before the colon of the record's `ended`, with underscores as spaces, over the runs that measured something: "on tap 1 of 4, cancelled 1 of 4, stuck 2 of 4", on tap first and the rest in alphabetical order.
  The report writes one cell per order, the baseline's against the candidate's.
  The score is unchanged: a run stuck on the commit green read still passes if its hidden tests do (ADR 0409).
- **The report's summary counts the runs that reached a pull request beside the orders passed**: "<n> of <m> orders (<p> of <q> runs reached a pull request)" for each Flight.
  A run reached one when it measured something and its head was read from the pull request (`headFrom`); `q` is the Flight's runs times the orders both Flights measured, so a run that measured nothing counts as one that did not.
- **The tasted entry gains an optional `tokensPerOrderSplit`** (`output`, `cacheRead`, `cacheWrite`, `input`), each the mean over the orders both Flights measured, rounded as `tokensPerOrder` is, which stays the sum.
  It is optional because nothing needs migrating until the first publish.
- **A missing option value is a refusal of one line with exit 2**: `scripts/flight.ts` and `scripts/flight-report.ts` read their command line through `flightArgsOf` and `flightReportArgsOf`, which turn what `parseArgs` throws into "--option needs a value", or into its own first message for any other mistake, instead of a raw Node stack trace.
- **The pull request description's sentence reads plainly**: "on <model> it passed every run on 2 of 2 orders, where <baseline> on <model> passed every run on 1 of 2, at 351 tokens per order (1 output, 1 cache read, 1 cache write and 348 fresh input)."

## Consequences
- A reader of the table sees at once that a high token count is mostly cache reads, and which orders never reached a pull request.
- A later token guess can weigh the kinds apart.
- An entry written before the split has none, and stays valid.

## Alternatives considered
- **Scoring a run stuck with no pull request as failed:** the maintainer kept ADR 0409's scoring, so the hidden tests keep their meaning of "does the head work".
- **A cost in money per kind:** prices move; the report states tokens only, as ADR 0411 has it.
