# 0316. A Brewery issue's label and status comment name the person's next action

Date: 2026-11-03 · Status: Accepted · Amends [0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md) (the lane labels, and when the first one is set), [0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md) (a pass with an Ordered batch waits for a tick before it routes), [0275](0275-a-finished-plan-waits-stuck-for-its-review-and-every-comment-links-the-doc-it-sums-up.md) (a plan at review is labelled for its approval, and its comment ends with one `Next:` line), [0281](0281-foedrum-approve-signs-off-a-plan-by-its-hash-and-puts-the-batch-on-tap.md) and [0293](0293-a-split-order-ends-once-every-sub-order-merged-and-the-engine-closes-it.md) (an approved plan on tap is labelled for its sub-orders, and its comment says what comes next) · Amended by [0334](0334-every-line-names-the-number-and-the-innkeeper-reads-it-from-its-input-s-source.md) and [0350](0350-a-brewed-pull-request-is-a-draft-until-its-merge-brief-and-the-next-line-follows-the-brief.md)

## Context
The first real run of M2's exit (2026-11-02, Brewery order #14 and its sub-orders #15 and #16, #777) showed that the labels and the status comments said where a batch was, but not what the person had to do:

- **A plan at review read as broken.** #14 showed `foedrum:stuck` while its plan waited for approval. Stuck is the right lane ([ADR 0275](0275-a-finished-plan-waits-stuck-for-its-review-and-every-comment-links-the-doc-it-sums-up.md)), but the label read as "something failed".
- **`foedrum:on-tap` meant two things.** On #14 it meant "plan approved, the sub-orders take over"; on #15, "pull request open, merge it". #15's comment said only `🍻 **On tap**` with the link, and no `Next:` line.
- **The first label lagged.** `foedrum:ordered` never showed. In `serve` the intake pass orders an issue and routes it by its `recipe:` label back to back, and the driver's tick, which applies the label effects, saw it brewing already.

## Decision
- **One label per issue, naming the person's action while the batch waits on them, else where it is** (`laneLabel`, `src/engine/lane-labels.ts`):

  | Lane | Label |
  |---|---|
  | Ordered, Brewing, Conditioning | `foedrum:ordered`, `foedrum:brewing`, `foedrum:conditioning` |
  | Stuck, `plan_review` | `foedrum:awaiting-approval` |
  | Stuck, `needs_input` | `foedrum:awaiting-answer` |
  | Stuck, any other reason | `foedrum:stuck` |
  | On tap, a pull request with no merge or close recorded | `foedrum:awaiting-merge` |
  | On tap, no pull request, an approved plan whose sub-orders have not all merged | `foedrum:sub-orders` |
  | On tap otherwise (every pull request ended, every sub-order merged, or none and no approved plan), Cancelled | none |

  Filtering an issue list by `awaiting-` shows the plans, questions and pull requests that wait on the person. `foedrum:stuck`, and a split order a sub-order keeps open, wait on them too, and their comments say how in their `Next:` line.
- **`foedrum:on-tap` is retired.** The ledger still parses a revision that left it (`RetiredLaneLabel`, `src/schemas/lane-label.ts`), and every revision takes it off with the lane labels. A batch whose latest revision left it gets no new one while it stays on tap, so an upgrade does not relabel every issue that ended on tap. Its next lane change, such as a pull request sent back to brewing, replaces it.
- **Every status comment that waits on the person, or hands over, ends its first block with one `Next:` line** (`nextLines`, `src/engine/status-comment.ts`). The first block is the lane line, the sub-order rows, the pause and the usage windows. It comes before everything a cut can drop, so a long comment keeps it:
  - Stuck for review: `Next:` and what to do with the plan (`planNextStep`), as before, then ``Its other option: `recipe`.`` for the lane's options it does not name. There is no separate `Get it moving with …` line.
  - Stuck for input: ``Next: answer the questions above with `foedrum answer <batch> <answer 1> …`, or get it moving with `retry`, `cancel`.``
  - Stuck for any other reason: ``Next: get it moving with `retry`, `cancel`.`` This replaces the `Get it moving with …` line, with the same options.
  - On tap with open pull requests: `Next: review and merge <each one not merged or closed>.`
  - A split order on tap: `Next: nothing to do; the sub-orders brew (#15, #16), and each pull request comes to you on tap.`, numbered from its sub-order rows, else the sub-issues its plan opened. When a sub-order keeps the order open (cancelled, closed without merging, needs refinement): `Next: see to what keeps the order open (#16).` Once the order is done, there is no `Next:` line.
  - Ordered, Brewing, Conditioning, Cancelled, and On tap with nothing open: no `Next:` line.
- **The Ordered label goes on before its batch brews.** An intake pass that ordered a batch, while an Ordered batch waits for its route, awaits its `ordered` hook after it orders and before it routes (`createIntake`, `src/engine/intake.ts`). `serve` makes it wait for the end of the next driver tick that begins after the call, and that tick applies the effects. So the ledger's first lane label revision is `foedrum:ordered`, and the effects never run beside a drive. A stop releases a waiting pass, and so does a tick that throws. A pass that reaches the hook once serve is stopping goes on at once, since no tick comes.

## Consequences
- A person scans the issue list by label and each comment for one word, `Next:`, to know whose turn it is.
- Routing waits for one tick (`serve`'s tick interval, a few seconds), not for the next intake poll.
- An issue an older Foedrum left on tap keeps `foedrum:on-tap` until its batch's lane changes, or the issue is ordered again.
- `foedrum brew` has no intake: its labels follow its driver's ticks as before.

## Alternatives considered
- **Keep the lane labels and add an `awaiting-*` label beside them.** Two labels say one thing twice, and the issue list shows both. The decision with the maintainer was one label.
- **Route an issue ordered in this pass only at the next pass.** It holds every order back by a poll (60 s by default) to show a label for that long.
- **Call the driver's `applyEffects` from the intake.** It would apply effects beside a drive, which no driver did before. A wait for the tick reuses the order the tick already keeps.
- **Relabel every on-tap issue on upgrade.** It writes to every issue that ever ended on tap, the closed ones too, for a label nobody reads there.
