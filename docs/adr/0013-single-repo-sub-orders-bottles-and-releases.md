# 0013. Single-repository sub-orders, bottles and release dependencies

Date: 2026-10-13 · Status: Accepted · Amended by [0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md)

## Context
In enterprise codebases a solution usually changes several repositories, and repositories depend on each other through published libraries: a change in a library must be merged, built and released before the consuming repository can use it. Teams also want control over what goes into a pull request — sometimes one small change, sometimes several together.

## Decision
- **All work items live in the Brewery.** An order can be **decomposed** into **sub-orders** (GitHub sub-issues) with native "blocked by" dependencies. Foedrum never creates or edits issues in target repositories; their issues are only a triage source.
- **A sub-order targets exactly one repository.** A brewer writes in one repository and may read siblings for context.
- Each sub-order has its own batch; batches run in dependency order.
- **Bottles:** a pull request bundles one or more finished sub-orders of one repository. Bottling policy per recipe (`perSubOrder`, `perRepo`, `manual`); manual bottling by command. Bottles of one order link to each other with a suggested merge order.
- **Dependency kinds:** `code` (stacked on another sub-order's branch in the same repository) and `release` (waits until a configured **release signal** reports a new version of a library — GitHub release or tag first, package registries later — then starts by bumping the dependency).
- Decomposition requires human approval by default (READY / NOT READY); breakdowns made with the interactive refine plugin count as approved.
- Waiting for merges and releases is a distinct state, **Conditioning**, with a visible reason and a reminder deadline.
- The data model is multi-repository from the first milestone.

## Consequences
- Cross-repository solutions are first-class, including the real-world release cycle between libraries and consumers.
- Pull requests stay reviewable: one repository each, with the scope the team chooses.
- Long waits on human merges and CI are visible and never mistaken for being stuck.
- Foedrum depends on CI publishing versions; repositories without a release signal can only use `code` dependencies.

## Alternatives considered
- **One batch spanning several repositories:** a single agent with write access to many repositories is harder to review, isolate and retry.
- **Always one pull request per sub-order:** simple, but floods reviewers with small pull requests.
- **Developing consumers against unreleased builds by default:** faster, but leaves a dependency bump to remember; kept as a later option.
