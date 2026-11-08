# 0349. A group's round back carries every finding of the round

Date: 2026-11-08 · Status: Accepted · Amends [0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md) (what a group's route hands the step it goes back to), [0191](0191-the-step-a-findings-route-goes-back-to-records-a-disposition-for-each-finding.md) (a disposition names the step whose finding it is, and which round reads it) and [0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md) (what a findings route's input holds)

## Context
When a blocking child of a parallel group asks for changes, the batch goes back along that child's route with its own out doc only ([ADR 0168](0168-a-parallel-group-runs-its-lens-steps-side-by-side.md), [ADR 0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)).
In `nip` that is correctness: what acceptance, security and design conformance found in the same round reaches the pull request and the status comment, where nothing acts on it unless a person reads it.
When two blocking children both ask, the step they go back to reads the first one's findings, and the second's wait for the next round.
ADR 0168 left "a route input of every blocking child's out doc" as a change of its own.
A disposition ([ADR 0191](0191-the-step-a-findings-route-goes-back-to-records-a-disposition-for-each-finding.md)) is matched by its place only, and a round of a step reads the dispositions of an attempt whose findings route came from that step, so a disposition of an advisory finding would reach no round.
The maintainer decided (#938) that a round going back carries every finding of that round, from every child of the group, blocking and advisory, each marked as which.
A round back with nothing blocking is not this decision: advisory findings when no round goes back are #926's.

## Decision
- **The route input of a group's round back.** After the routing child's reason and its out doc, as before, it lists the group's other children in that round: one section per child, `Step <id>, through <lens> and <lens>, blocking:` or `advisory:`, then one line per finding, its lens first when it names one, its severity, place, `there before the change` when it was, and its `why` on one line, or `no findings.` (`groupRoundOf`, `withGroup`, `src/brewers/attempt-plan.ts`).
  A succeeded child's findings come from its recorded out doc; a blocked one's from `step.finished` as recorded ([ADR 0221](0221-foedrum-lenses-reports-each-lens-s-findings-their-ends-and-its-tokens.md)), its first 100, with a line that says how many more it did not record, each `why` cut at 1,000 characters.
  So a second blocking child's findings arrive in the same round.
  Blocking children come first, then advisory ones, each in the order the batch scheduled them.
- **That round only.** The round is the run of the group's attempts on the batch's path around the routing attempt, with no attempt of another step between: entering the group schedules every child at once, and a round back leaves it. A child with no attempt that reviewed in that run brings nothing, so an earlier round's findings never come back.
- **The step's group.** A Taster's step in a group knows its group from the load (`StepBrewer.group`), read under the recipe each attempt was scheduled under, as the out doc's name is ([ADR 0309](0309-the-attempt-plans-find-every-brewer-in-the-recipe-its-attempt-was-scheduled-under.md)).
- **The limit.** The input keeps ADR 0128's 64 KiB. The other children's lines are cut first: the routing child's reason and out doc are held to the limit less the intro line and the longest cut line, then the other children's lines are added whole, in order, while they fit, and a last line names how many findings of each child were left out (`[cut: past the route input's limit of 65536 bytes, left out: 52 findings of acceptance, 3 of design]`).
- **A disposition names its step.** A disposition gains an optional `step`, a step's id: the step whose finding it is. Without one it is the routing step's, so every out doc written before reads as before.
  A round of a step reads the dispositions of the attempt a findings route brought back, of its own route or another's, that name it, or that name no step when the route was its own (`lensRounds`, `src/engine/lens-rounds.ts`); another step's route leaves a round's dispositions as they were when it names none of its findings.
  So an advisory child's next round gets its findings with what was done with them, and the merge brief's disposition lines and `foedrum lenses` count them under its step, all three through `lensRounds`.
  `npm run schemas` adds `step` to the out doc schema; the event stores the output as JSON and does not change. An older Foedrum cannot read an out doc whose disposition names a step, as ADR 0191 records for `dispositions`.
- **The brewers.** The default Cellarman's prompt (version 12) says that an advisory finding is fixed or dismissed with a reason like a blocking one, and that a disposition of a finding listed under another step names that `step`; past 100 findings it disposes of the routing step's first. The default Brewmaster's (version 7) says the same for a plan, since `mash` and `decoction` route their plan lenses back to it from a group.
- **Rounds** count as before, against the route of the child that sent the batch back, and an advisory child's `changes` never sends the batch back by itself (`settle`, `src/engine/decide.ts`, unchanged).

## Consequences
- In `nip`, the Cellarman fixes or dismisses acceptance's, security's and design conformance's findings in the round correctness sends back, and their next round reads what it did.
- A round back with two blocking children carries both, so the second's findings no longer wait a round; its rounds still count only against the first one's route, as ADR 0168 has it.
- What the status comment and the pull request body show does not change: each child's latest attempt's findings, and every child runs again on the round back. The merge brief lists the advisory dispositions beside the blocking ones.
- The route input grows by the other children's findings, at most to the 64 KiB it already had.
- The routing out doc is cut a little sooner than before, by the length of the cut line, when the group has findings and the out doc alone nears the limit.
- **Migration.** None needed to keep running: recipes keep their routes. A Brewery with its own `cellarman.md` keeps its prompt until it copies, in `## A Taster's findings`, the sentences from "When that step is one of a group of Tasters" to "fix it, or dismiss it with a reason, as below.", the words "its `step` when it is listed under another step than the one whose out doc {route} holds", the third example entry, and "dispose of the blocking step's first, in the order {route} lists them". Without them, its Cellarman still reads every finding, and a disposition it writes without `step` counts as the routing step's. A Brewery with its own `brewmaster.md` copies the like lines of `## A plan lens's findings`.

## Alternatives considered
- **Every child's whole out doc.** Each read from its worktree: more file reads in the plan, and a second 1 MiB input per child, for findings the events already hold.
- **Only the blocking children's findings.** It answers ADR 0168's open point, not the maintainer's rule that a finding never waits for a person.
- **Dispositions matched by place across every child.** Two children's findings at one line would take each other's.
- **A `step` the disposition must name.** Every out doc before it would stop reading, and on a route that is not a group's it says nothing.
- **Cut the routing out doc evenly with the rest.** The routing child's findings are the ones that sent the batch back, and only its out doc holds them whole.
