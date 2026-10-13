# Glossary

Foedrum borrows its vocabulary from Belgian brewing. A *foeder* is the large oak vat in which Flemish red and oud bruin beers mature slowly and reliably, sometimes for decades.

## Core concepts

| Term | Meaning |
|---|---|
| **Brewery** | The control repository: configuration, brewers, recipes, house yeast, evaluations |
| **Order** | An issue in the Brewery; the unit of intake |
| **Sub-order** | A sub-issue of an order, targeting exactly one repository |
| **Bottle** | A pull request: one or more finished sub-orders of one repository |
| **Bottling** | Choosing which sub-orders go into a bottle |
| **Conditioning** ⏳ | Waiting for a merge, a release or a sibling batch — visible, with a reminder, never a failure |
| **Release signal** | How Foedrum learns a library version was published (GitHub release or tag first; NuGet, npm and others later) |
| **Triage source** | Issues in target repositories, read by Infection check and turned into Brewery orders |
| **Rewind** | Continuing a batch from an earlier step; branches reset to that step's commits |
| **Brewer** | A reusable agent role: prompt, in-docs, out doc, model, effort, tools, permissions, budget, guards |
| **Recipe** | A pipeline: brewers, checks and actions in order, with loops |
| **Batch** | One execution of a recipe for one order |
| **Step** | One position in a recipe |
| **Attempt** | One try at a step; has a lease, a deadline and an outcome |
| **In-doc / out doc** | Documents a brewer receives / must produce; the out doc's frontmatter is the step outcome |
| **Gravity reading** | A deterministic check: tests, lint, types, diff limits. Measured, not judged |
| **Red proof** | A gravity reading that must fail: the tests committed by the Gauger (or Microbiologist) fail on assertions before the implementation exists, read from a structured test report |
| **Tasting** | An AI review. Judged, not measured |
| **Lens** | One focus for a tasting: correctness, security, cross-platform, design conformance, or a Brewery's own |
| **Mutant** | A plausible bug proposed by Brett; a mutant the engine confirms the tests do not catch is a finding (advisory by default) |
| **Stuck** 🔔 | A batch that needs a human. Always visible, never silent |
| **House yeast** | Rules learned from reviews, carried from batch to batch — scoped, budgeted per attempt, promoted to checks when possible, curated over time |
| **Blending** | Combining branches; conflicts go to a bounded brewer step |
| **On tap** | Pull request opened or merged |
| **Cellar** | The engine (`foedrum serve`) |
| **Brewhouse** | The live dashboard (later) |
| **Tasting log** | Plain-language summaries of what a batch changed (later) |
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

## Default recipes — the Belgian strength ladder

| Recipe | Use |
|---|---|
| Tafelbier | Quick fix |
| Enkel | Small feature |
| Dubbel | Medium feature, with plan approval |
| Tripel | Large feature, split into child orders |
| Quadrupel | Multi-repository epic |
| Pilot batch | Spike or research |
| Infection check | Bug triage |
| Guest tasting | Review someone else's pull request |
| Re-pitch | Re-review a pull request after fixes |
| Refresh | Dependency upgrades |
