# The out doc contract

The only text Foedrum adds to every brewer prompt, besides the rule about tagged input when the brewer has inputs ([ADR 0041](../../adr/0041-untrusted-input-in-per-prompt-nonce-tags.md)):

```markdown
When you finish, write {outDoc}. It must start with JSON frontmatter: copy the example
below for how the run ended and fill it in, with only its keys and any your instructions
add. "questions" goes only with needs_input, "blockerKind" only with blocked.

The work is done:
---
{ "status": "done", "summary": "<one line>", "assumptions": ["<decided without asking>"] }
---

You need a human's answer to go on:
---
{ "status": "needs_input", "summary": "<one line>", "assumptions": ["<decided without asking>"],
  "questions": [{ "q": "...", "options": ["a", "b"], "recommended": "a", "whyBlocking": "..." }] }
---

Something stops the work. "blockerKind" is "findings" (problems to fix),
"environment" (a wall you cannot fix) or "divergence" (the plan does not match reality):
---
{ "status": "blocked", "summary": "<one line>", "assumptions": ["<decided without asking>"],
  "blockerKind": "findings" }
---

You could not finish:
---
{ "status": "failed", "summary": "<one line>", "assumptions": ["<decided without asking>"] }
---

An assumption or a risk states only what you did or read: "I did not check X" is
fine, but "X could not be checked" needs the attempt that failed.
Prefer deciding and recording an assumption over asking. Ask only when a wrong
guess would likely waste this run. Never ask questions any other way.
```

For a brewer with `git.commit: true`, two lines follow it ([ADR 0074](../../adr/0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md)):

```markdown
Commit your changes with git add and git commit before you write {outDoc}, and leave
{outDoc} out of every commit.
```

The attempt's shell commands and the rule not to push are not in the contract: they are the engine's fixed rules, in the attempt's system prompt file ([how a brewer runs](how-a-brewer-runs.md), [ADR 0183](../../adr/0183-the-engine-s-fixed-rules-for-a-brewer-go-in-an-appended-system-prompt.md)).

One example per status, because the schema is strict: a brewer that copies the example for its status as it is writes a valid out doc, and one that fills in every key of a single template did not (#195).
The blocked example says `findings`, the one kind that can give the work another chance: another round inside a loop, else the step's `onBlocked` route, else Stuck (the table below), bounded by `maxRounds`.
The contract stays around 350 tokens (ADR 0005, [ADR 0308](../../adr/0308-a-taster-reads-the-checks-that-ran-on-its-head-and-an-out-doc-claims-only-what-its-session-did.md)): a unit test holds it to 1,400 characters, and to 1,600 with the lines about committing.
Its rule on claims keeps every brewer's assumptions and risks to what its session did or read ([ADR 0308](../../adr/0308-a-taster-reads-the-checks-that-ran-on-its-head-and-an-out-doc-claims-only-what-its-session-did.md)).
Brewer-specific fields (for example a review verdict) are added by the brewer's own schema.
A brewer whose `output.schema` is `plan` writes a plan's sub-orders, checked against its repositories after a `done` ([work breakdown](../intake/work-breakdown.md), [ADR 0233](../../adr/0233-a-plan-is-an-out-doc-whose-paths-the-engine-checks-shown-as-one-comment-per-order.md)).
A brewer whose `output.schema` is `recipeChoice` ends `needs_input` with one question whose options are among the recipes its step may offer, which the engine fills its `"from": "recipes"` input with; a `done`, a second question or another option fails the attempt retryably ([ADR 0232](../../adr/0232-foedrum-mash-routes-an-issue-to-the-innkeeper-whose-question-the-answer-chooses-the-recipe-by.md)).
A Taster's finding may name the `lens` it was found through, and on a step of several lenses together each must, one of the step's ([lenses together](tasting.md#lenses-together)); an older Foedrum cannot read an out doc, or a Stuck event's open findings, that has one.
Every out doc may also list `dispositions`, which a brewer a findings route brought back writes for the findings of its route input: each with the finding's `file` and `line` as the Taster wrote them (none for the change as a whole), the `step` whose finding it is when another child of the routing step's group found it ([ADR 0349](../../adr/0349-a-group-s-round-back-carries-every-finding-of-the-round.md)) and a `disposition` of `fixed` (an optional `why`), `dismissed` or `pre-existing` (each with a `why` that names the evidence that shows it: a file and line, a test, or the sentence of the order or of a decision record it relies on, [ADR 0204](../../adr/0204-a-dismissal-names-the-evidence-that-shows-it.md)), at most 100 of them, a file of at most 1,000 characters and a `why` of at most 2,000, limits of their own, since a Taster's findings have none (past 100 findings, the default Cellarman disposes of the routing step's first, then the rest in the order its route input lists them, and the rest past 100 stay open) ([tasting](tasting.md), [ADR 0191](../../adr/0191-the-step-a-findings-route-goes-back-to-records-a-disposition-for-each-finding.md)).
A plan step's dispositions, which the default Brewmaster writes for a plan lens's findings, read a finding without a `file` as about the plan as a whole, and a dismissal's evidence is a line of the order, a file and line in a repository, or a field of the plan ([ADR 0318](../../adr/0318-a-plan-lens-s-findings-go-back-to-the-plan-step-and-the-plan-comment-lists-the-review-notes-left.md)).
The field is optional, so every older out doc still reads; an older Foedrum cannot read an out doc, or the event that records it, that has it.
Every out doc may also end with `handover`, at most 3 lines of at most 300 characters each, which the default brewers' own files ask for and the contract does not ([ADR 0340](../../adr/0340-a-brewer-s-handover-is-kept-as-a-proposal-and-reaches-no-later-prompt.md)).
It never fails an attempt, a line past its limit being cut with a mark: `readOutDoc` takes it out before any schema reads it, so no `output` holds it, and a later prompt reads the out doc without it.
`step.finished` records its lines, each read for a secret, whatever the ending; a person reads them in the pull request's body and through `foedrum handover`, and an older Foedrum cannot read an event that has them.

## How the engine routes an out doc

| Out doc | Next |
|---|---|
| `done` | Guards pass → next step; a Taster's `changes` verdict on a blocking step is routed as `blocked` + `findings` ([ADR 0161](../../adr/0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)) |
| `needs_input` | Stuck 🔔 with the questions; the answer, from any surface, resumes the brewer's session as the next attempt when its `retryMode` is `resume` ([brewers](brewers.md) says when that is overridden); otherwise, or when the session cannot be resumed, a fresh attempt gets every round's answers as its `answers` input ([ADR 0118](../../adr/0118-retrymode-resume-loads-and-an-answer-resumes-the-session-that-asked.md)) |
| `blocked` + `findings` | Next loop round, until `maxRounds`; outside a loop, the step's `onBlocked` route, else Stuck |
| `blocked` + `environment` | Stuck immediately: another round would hit the same wall |
| `blocked` + `divergence` | Stuck: the plan does not match reality |
| `failed` / missing / invalid | Retry per `maxAttempts`, then Stuck |
