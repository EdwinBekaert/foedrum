# Glossary

Foedrum borrows its vocabulary from Belgian brewing. A *foeder* is the large oak vat in which Flemish red and oud bruin beers mature slowly and reliably, sometimes for decades.

## Core concepts

| Term | Meaning |
|---|---|
| **Brewery** | The control repository: configuration, brewers, recipes, house yeast, evaluations |
| **Order** | An issue in the Brewery, or an issue of a target repository the Brewery claimed (an issue claim); the unit of intake. In M1 a Brewery issue is an order once an allow-listed user opened it with a `recipe:<name>` label (ADR 0068) |
| **Issue claim** | The ref `refs/foedrum/claims/issues/<n>` by which one Brewery takes a target-repository issue; exactly one Brewery can create it, and it is released when the batch ends. Not the claims of attempt worktrees (ADR 0029), which say what a cleanup must keep |
| **Sub-order** | A sub-issue of an order, targeting exactly one repository |
| **Bottle** | A pull request: one or more finished sub-orders of one repository |
| **Bottling** | Choosing which sub-orders go into a bottle |
| **Conditioning** ⏳ | Waiting for a merge, a release or a sibling batch — visible, with a reminder, never a failure |
| **Release signal** | How Foedrum learns a library version was published (GitHub release or tag first; NuGet, npm and others later) |
| **Triage source** | Issues in target repositories configured for triage, read by Infection check and turned into Brewery orders |
| **Rewind** | Continuing a batch from an earlier step; branches reset to that step's commits |
| **Brewer** | A reusable agent role: prompt, in-docs, out doc, model, effort, tools, permissions, budget, guards |
| **Recipe** | A pipeline: brewers, checks and actions in order, with loops |
| **Batch** | One execution of a recipe for one order |
| **Task tree** | Where a batch's work is: the branch of its latest attempt that succeeded with a worktree, or its latest rewind's commit, else the repository's base; each new attempt's worktree starts there (ADR 0066) |
| **Step** | One position in a recipe |
| **Attempt** | One try at a step; has a lease, a deadline and an outcome |
| **In-doc / out doc** | Documents a brewer receives / must produce; the out doc's frontmatter is the step outcome |
| **Gravity reading** | A deterministic check: tests, lint, types, diff limits. Measured, not judged. A check step is one; it records a reading per check it ran or skipped (`readings` on `step.finished`, ADR 0069), after a first reading of the repository's setup when it has one (ADR 0140) |
| **Red proof** | A gravity reading that must fail: the tests committed by the Gauger (or Microbiologist) fail because the behaviour is missing (an assertion or an error from the code under test, not a load error), read from a structured test report |
| **Tasting** | An AI review. Judged, not measured |
| **Lens** | One focus for a tasting: correctness, security, cross-platform, design conformance, test design, or a Brewery's own |
| **Mutant** | A plausible bug proposed by Brett; a mutant the engine confirms the tests do not catch is a finding (advisory by default) |
| **Stuck** 🔔 | A batch that needs a human. Always visible, never silent |
| **House yeast** | Rules learned from reviews, carried from batch to batch — in three layers (defaults, Brewery, repository), scoped, budgeted per attempt, promoted to checks when possible, curated over time |
| **Candidate** | A lesson recorded from a review; proposed as a house-yeast rule when it recurs or a human asks |
| **Blending** | Combining branches; conflicts go to a bounded brewer step |
| **On tap** | Pull request opened or merged, or the recipe done without one (a recipe without the openPullRequest action, whose brewers commit nothing, ADR 0059 and ADR 0084; one with it goes on tap only with its pull request, ADR 0071) |
| **Cellar** | The autonomous driver (`foedrum serve`): brews orders unattended, steered through GitHub comments and later the dashboard |
| **Driver** | What moves a batch forward: an engineer's Claude Code session or terminal through `foedrum brew` (interactive, ADR 0123) or the Cellar (autonomous); one at a time per batch, held as a batch lease it renews |
| **Session step** | A recipe step that runs in an engineer's own Claude Code session: refine, triage, review |
| **Brewhouse** | The live dashboard (later) |
| **Tasting log** | Plain-language summaries of what a batch changed (later) |
| **Brew sheet** | A one-page explanation of a part of Foedrum, a pull request or an issue: one line with the premise, then one verified picture (`/brew-sheet`) |
| **Flight** | The evaluation suite: a set of samples |
| **Blind tasting** | Comparing models, brewers or recipes on the Flight |
| **Pack** | A shareable, declarative bundle of brewers, recipes and checks (later) |

## Board lanes

**Ordered → Brewing → Conditioning ⏳ → Stuck 🔔 → On tap**

## Default brewers

| Brewer | Role |
|---|---|
| Innkeeper | Router |
| Maltster | Context gathering |
| Brewmaster | Planning |
| Gauger | Failing tests first |
| Cellarman | Implementation |
| Taster | Review, one lens at a time |
| Brett | Mutation check |
| Cooper | Fixing review findings |
| Blender | Merge conflicts |
| Microbiologist | Bug triage |
| Lab tech | Verification |
| Tasting panel | Evaluation |

## Default recipes — sized by the glass

The bigger the work, the bigger the vessel. Choose one with a label such as `recipe:pint`, or let the router pick.

| Recipe | Use |
|---|---|
| Nip | Quick fix |
| Half-pint | Small feature |
| Pint | Medium feature, with plan approval |
| Growler | Large feature, split into sub-orders |
| Keg | Multi-repository change with release dependencies |
| Pilot batch | Spike or research |
| Infection check | Bug triage |
| Guest tasting | Review someone else's pull request |
| Re-pitch | Re-review a pull request after fixes |
| Refresh | Dependency upgrades |
