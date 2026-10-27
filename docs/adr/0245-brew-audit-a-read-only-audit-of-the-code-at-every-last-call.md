# 0245. /brew-audit: a read-only audit of the code and the ADRs at every last call, its findings kept in the main checkout

Date: 2026-10-27 · Status: Accepted

## Context
`/brew-review` judges one pull request through the diff lenses, and `/brew-last-call` audits Foedrum's instruction files before a milestone closes. Nothing reads the code and the ADRs as they stand: how many changes add up, code they left dead or duplicated, decisions the code drifted from.
On 2026-10-27 the consultant ran a one-off read-only audit of `b01300bb` (an auditor per area, a skeptic per auditor, one report): 28 findings survived the skeptics, none high, all in code that had passed `/brew-review`.
The maintainer asked to keep it as a skill and to run it at every milestone (#610).

## Decision

### A skill that runs a saved workflow
`/brew-audit` (`.claude/skills/brew-audit/`) runs `.claude/workflows/brew-audit.js`, Foedrum's first saved workflow: one auditor per area of the code, one for a sample of the tests and one for the ADRs, one skeptic per area that tries to refute each finding, and one agent that writes the report from what survives.
The auditors use the diff lenses in `defaults/lenses/diff/` as their checklists, and every prompt says that finding nothing is a good result.
The workflow file ends with a top-level `return`, as the Workflow tool runs it as a function body, so Biome leaves `.claude/workflows/` out.

### Read-only by its tools
Every agent of the workflow is the `auditor` agent (`.claude/agents/auditor.md`): Read, Grep and Glob behind the read guard, like the reviewers of [ADR 0049](0049-reviewers-read-only-inside-the-checkout.md).
It reads a detached worktree pinned at `origin/main`; the skill computes what changed since the previous audit and passes the list as data, so no agent needs a shell.
The audit files nothing, comments nowhere and changes no branch.

### Findings are kept in the main checkout
The report and the findings live in `<main>/.foedrum/tmp/audits/<sha>/`, git-ignored, where `<main>` is the folder above git's common directory, shared by every worktree as the house-yeast candidates are ([ADR 0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md)).
They outlive the run, unlike the per-issue scratch files of CLAUDE.md "Temporary files": the next audit reads them to audit only what changed and to re-check each earlier finding as fixed, open or gone.
An earlier finding stays in `findings.json` until an audit finds it fixed or gone, and so does a new finding its skeptic did not answer, marked unverified.
An area the audit could not finish is listed in `unfinished.json`, and the next audit audits it in full.

### Security findings stay local
Public text (a pull request, an issue) gives security findings only as counts per severity and area, never their file or what they are, until they are fixed.
The auditor or the skeptic can mark a finding as security, and the last call also counts a finding about the push gate, the read guard, the check sandbox or secrets as one.

### Every last call runs it
`/brew-last-call` invokes `/brew-audit` through the Skill tool and lists its findings as follow-ups grouped into proposed issues with their milestone; it files nothing.

## Consequences
A full audit costs about 19 agents and a few million tokens; one since the previous audit costs in proportion to what changed.
The findings of the `b01300bb` run are the first baseline, so the first audit at a last call is incremental.
A finding becomes an issue only when a person picks it.

## Alternatives considered
- Running the audit by hand only: it would not happen at a fixed point, and the chain of incremental audits would break.
- Reusing the `taster` agent: its system prompt reviews a prepared diff and answers in a fixed JSON, which fights the audit prompts.
- Filing findings as issues automatically: security findings would be public before they are fixed, and a person would no longer pick what is worth an issue.
