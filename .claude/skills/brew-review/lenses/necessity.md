# Lens: necessity

Review every safeguard the change adds for proof that it is needed and not already done elsewhere. You are one of several reviewers, each with one lens; stay inside this one. This lens is used by the review skill for Foedrum's own pull requests; Foedrum does not ship it as a default.

A **safeguard** here is a new mechanism whose only job is to stop or catch something: a gate rule, a guard, a check step or CI step, a scan, a retry, a lock, a sandbox rule, a review stage, a test layer, a test run in the workflow, or a follow-up issue for one.

**Not a safeguard: doing the code right.** Code that handles the inputs its own contract says it takes is correctness, not a guard, and needs no proof: validating input where it enters, handling the error paths, comparing a name the way its domain compares it (without case when case does not count), normalising a path, reading a command the way the shell reads it when the code's contract says it reads commands as the shells do (ADR 0045). The signs: it lives inside the code being written or fixed, costs next to nothing, and adds no file, step, job or issue. Never ask such code for proof.

## Look for

**No proof of need.** Each new safeguard must name what it protects against, and the proof that it happens or can happen here:
- an observed failure: an issue, a CI run, a session report, a kill in the chaos tests;
- or a concrete path reachable today: who or what controls which input, what they do, and what goes wrong without the safeguard.

"Could in theory", "to be safe", "defence in depth" and "for completeness" are not proof. A safeguard against an actor or input outside the security model (`docs/design/security.md`, and the security lens's "Treat as untrusted") is not needed.

**Done elsewhere.** Find the risk's row in `docs/trust-boundaries.md`, the one owner of each risk. A safeguard outside its row's owner, with no recorded second layer for it there, is a duplicate unless the change records why. Also name every existing layer that already covers the same risk: the local gate, CI, the ruleset on `main`, Claude Code's sandbox or permissions, another check or guard, a schema, the review itself, an earlier step of the same workflow. When one does, the new safeguard is a duplicate. That is a finding unless the change records a decision (an ADR, or the issue it closes) that says why both are kept and what the second one catches that the first misses.

**The same work twice.** A workflow that runs the same tests, checks or lookups more than once on the same input: a check on a tree that a step before it already checked, a CI job that asks the same question on several legs, a retry of something that cannot change between tries.

**Cost against benefit.** For each new safeguard, what it costs: time per run and how often it runs (every command, push, pull request, attempt), what it blocks when it is wrong (a false positive that stops legitimate work), and what keeping it costs (code, tests, documentation). Flag a safeguard whose cost is high and whose proof is thin.

**Scope creep.** A change that adds safeguards its issue didn't ask for. They belong in an issue of their own, with their proof.

## Do not

- argue against a safeguard that names its proof and duplicates nothing;
- propose new safeguards: other lenses find risks, this one weighs them;
- review the correctness of a safeguard that is needed (correctness, security).

## Leave to other lenses

Whether code is correct (correctness), whether a risk exists (security), portability (cross-platform), naming and documented decisions (design conformance), test strength (test design). Style is out of scope for every lens.

## Reporting

Report only what you can tie to specific lines of the change. For each finding, name the safeguard, what proof it gives (or "none given"), and the existing layer it duplicates with its file and line, ADR or workflow step. Suggest one of: remove it, keep it with a recorded reason, or move it to an issue of its own with its proof. Say when the defect was already there before this change, in code the change reaches but neither adds nor alters: such a finding is reported, but it does not hold the change up. If you find nothing, say so; do not invent findings.
