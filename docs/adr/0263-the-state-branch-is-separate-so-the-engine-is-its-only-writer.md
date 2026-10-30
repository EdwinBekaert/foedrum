# 0263. The state branch is separate so the engine is its only writer

Date: 2026-10-30 · Status: Accepted · Amends [0011](0011-state-in-the-brewery-repository.md) (why the state is on a branch of its own)

## Context
[ADR 0011](0011-state-in-the-brewery-repository.md) puts the durable record on the Brewery's branch `foedrum/state` and gives as the reason for a branch of its own that "commits on the state branch are frequent; keeping them off `main` avoids noise", rejecting state on `main` because it "floods the configuration history".
A Brewery is one person's working space: its `main` holds a few brewers, recipes and house-yeast rules that rarely change, and its issues are work in progress on other repositories' issues. Noise on `main` is not a cost anyone pays there.
The reason that does hold is in ADR 0011 itself and in [ADR 0024](0024-state-branch-layout-outbox-and-divergence.md): the engine commits and pushes the state at every step boundary, and a push rejected as non-fast-forward is read as another engine having written in between, which stops the engine rather than letting two histories diverge.

## Decision
- The state branch is separate so that its only writer is the engine. A rejected push of `foedrum/state` then means one thing: another engine wrote to it.
- ADR 0011's noise reason is withdrawn; its decision (the record on `foedrum/state`, SQLite as the local index rebuilt from it, `main` for configuration) stands.

## Consequences
- With the state on `main`, a person's own push of a recipe or a brewer would be rejected against the engine's pushes, or would make the engine's next push be rejected and stop a batch with a false "another engine wrote in between". The separate branch keeps the two writers apart even in a one-person Brewery.
- A person never commits to `foedrum/state` by hand; doing so is a second writer, as ADR 0024 already treats it.

## Alternatives considered
- **Keep the noise reason beside the one-writer reason.** It argues from readers of `main` who are not there in a personal Brewery, and it would justify the wrong thing if a team ever shared one: the branch would still be needed with no noise at all.
