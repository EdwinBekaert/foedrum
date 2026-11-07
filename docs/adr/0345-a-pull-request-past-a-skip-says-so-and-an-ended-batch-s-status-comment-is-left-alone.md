# 0345. A pull request past a skip says so, and an ended batch's status comment is left alone

Date: 2026-11-07 · Status: Accepted · Amends [0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md) (when a pull request opens as a draft), [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) (when a revision is due), [0225](0225-a-ready-pull-request-gets-a-merge-brief.md) (what else says what the brief's skip lines say; its decision stands), [0343](0343-nip-tastes-through-design-conformance-as-a-fourth-advisory-lens.md) (corrects what it says of a skip past correctness), [0227](0227-a-later-round-renders-the-pull-request-s-body-again-unless-someone-edited-it.md) (what a later round's body says), [0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) (a step left open by a skip shows its latest round's findings on the status comment)

## Context
A batch's correctness Taster asks for changes in all three rounds, the batch goes Stuck, and a person runs `foedrum skip`.
Its pull request opened ready, with "Ready for review: every Taster approved.", no correctness in its reports and no Findings in its status comment (#920).
A blocked attempt has no verdict, so `opensAsDraft` read the verdicts of the others, and on the rounds-out path those were the approvals of an earlier head.
The merge brief, posted later, does say it: ADR 0225 lists a skipped step's findings as left open.
ADR 0343 says these findings are "listed nowhere". That is wrong about the merge brief, and this record corrects it.

The same claim follows a skip past any step that did not pass: a failing `green`, a Cellarman blocked by findings, a new Taster that never ran.

`skip` stays allowed, and ADR 0225's decision stands: the skip is the person's acceptance, and the brief is still posted.

Checking what an upgrade does to this text showed a second thing. `statusDue` compares digests and nothing else, and the driver asks every batch of the store on each pass, so a new text edits the comment of every merged or cancelled batch once.

## Decision
### What a skip went past
- **The fold records it**, from `batch.resumed` with `action: 'skip'`, with no new event, so a log from before this record reads the same way: each step of the batch whose latest attempt did not succeed, with that attempt's number, and the Stuck step with none when it never ran. A skip of a child skips its group (ADR 0168), and this reads the group's other children without the recipe.
- **A step that ran since is not counted.** `pastBySkip` (`src/engine/skip-past.ts`) keeps a step only while the attempt the skip saw is still its latest, so a correctness that was waiting for its fix round and approved after a skip of the Cellarman's fix is not listed. A recipe a person chose drops them, as it drops `skipped`, and a later skip does not count a step of a recipe the batch left, whose attempts it keeps.
- **A child a recipe gained and that is not the Stuck step is not named.** The fold has no recipe, so it reads the steps the batch has and the one Stuck on. A recipe file that gains a Taster while a batch is inside its group, with another child the reason the batch is Stuck, opens a draft and names that other child only. The merge brief's own line says the new one did not run.
- **A skip of a batch Stuck on its pull request's checks records none.** It leaves that head as it is (ADR 0219), and the status comment says so already.

### What each text says
- **The pull request opens as a draft**, and no text says every Taster approved. A line for each step, in the brief's words:
  - `` `correctness` is left open by a skip: its attempt 3 was blocked by its findings; its findings are in the reports below. ``
  - `` `green` did not pass: its attempt 2 failed, and a person's skip went past it. ``
  - `` `design-conformance` did not run, and a person's skip went past it. ``
- **These lines take the place of the one that says why it is a draft or ready.** A Taster that asks for changes keeps its line beside them, in words that hold of a ready pull request.
- **The reports list a left-open step's findings**, those its latest round recorded (ADR 0221), by `findingText` and in the reports' fence and filters, as `  left open by a skip: …`, and how many more. Its reason takes the place of an earlier round's summary, and its verdict and mutants go, which were not current: the stale `verdict: approve` is gone. What else that round wrote stays, a Cellarman's How it works too.
- **A Taster the rounds stopped says so beside what it had.** When correctness's third block makes the batch Stuck, its siblings' third attempts are abandoned. Each is listed as `` `acceptance` did not pass: its attempt 3 was stopped ``, and its second attempt's report stays. `endedText`, which the brief shares, now calls an abandoned attempt stopped.
- **The status comment says the same**, in a section of its own, `**Past a skip**`, before the sections that grow, with at most ten findings of a step and how many more, through its own filter (`leftOpenLines`, which the brief uses too). A cut keeps it.
- **One way of reading findings.** The brief, the reports and the comment all read `latest.findings`. The brief keeps its own selection of steps: what it lists is unchanged but for the abandoned attempt's word.

### A pull request already open
- **A ready pull request stays ready.** The engine sends no draft state after the open (ADR 0227), and turning one back would need a GraphQL effect of its own, for a pull request a person may be reading or merging. The maintainer decided against one.
- **Its later round tells it.** The lines above are worded to hold of a draft and of a ready pull request alike, so they say nothing of waiting to be marked ready.
- **A batch on tap keeps the body it has**, unless a later round renders it again, which then shows the lines. Its status comment takes them at the next pass, while it has not ended.

### An ended batch's status comment
- **A batch that ended is done** (the maintainer's rule): cancelled, or on tap with pull requests that have all ended. `admit` lets nothing move such a batch: a check of an ended pull request is refused, and so is a send back, and a fix needs `openOf`, which has no ended pull request. A split order on tap has no pull requests, so its rows go on changing.
- **Once a revision shows it ended, no further revision is due** (`endShown`). The merge's own last revision is still written, at once, and a batch skipped after this record keeps its lines in it. So an old batch's comment and pull request stay exactly as they are.
- **A revision rendered before the end does not count.** The intake's pass is not awaited by a tick (ADR 0068), so a merge can be recorded while an edit is on its way, and that revision shows the text from before it. A revision now records `open: true` when its batch had not ended, and when the text found under its key is not the one due. A revision from before this field counts by when it was applied.
- **A batch where something fails after its close is no longer done.** ADR 0335 has every lane take the mark, cancelled too, since a release may be what waits. `batch.failing` and `batch.recovered` each make one revision due, which also carries any newer text. Today that is only the mark: its lane stays as it is. Reopening such a batch with a failing state, so something can act on it, is future work in #921.
- **A batch with no pull request is not covered, and stays as it is in this record.** `batchEnded` needs at least one pull request. So a split order whose sub-orders all merged and whose issue the engine has closed (ADR 0293) still gets a revision when its text changes, as does any other batch on tap with no pull request. A release recorded after the close can change a split order's rows. Whether such a batch is done is for #921, which is not built yet.
- **A comment deleted by hand** is not made again on an ended batch. It was not before either, unless its text changed.
- **A handover line keeps the name it had.** It names a batch by `calledAs`, which changes when a later batch of the same issue is ordered. An ended batch's comment stays as it is, by the same rule, even when its number comes to mean the later batch.

## Consequences
- **What an existing Brewery must do: nothing in its files.** Nothing in a Brewery's files changes, no `foedrum.jsonc` key or recipe field is new, and no default brewer's `version` changes.
- **A Brewery run from more than one machine updates all of them together, and going back to an older version does not work once a new revision is recorded.** A status revision can now record `open`, and `StatusRevision` is a strict schema, so an older version refuses the record: `numberedEffects` throws when it reads that batch's status revisions, and that batch's effects pass fails, on every pass, until the driver runs this version. The new version reads older records as they are. Nothing else changes.
- A batch skipped and on tap when this ships gets the lines in its status comment at the next pass, and in its body only if a later round renders it. One that has ended keeps what it has.
- `applyPass` still goes over every batch on each pass. This record stops the writes, not that reading.

## Alternatives considered
- **Show the lines only while the pull request is open.** The edit at the merge would then take them away.
- **A flag on the ended revision alone.** A record from before it has no flag, so every old batch would look unwritten and be edited once at the upgrade. Hence the mark on the open ones.
- **Convert a ready pull request back to a draft.** See above.
- **Warn at `skip`.** Out of scope for #920: `skip` keeps its behaviour.
