# Architecture decision records

Each record captures one decision: context, decision, consequences and the alternatives considered. Records are immutable once accepted; a change of mind is a new record that supersedes the old one.

| # | Decision | Status |
|---|---|---|
| [0001](0001-typescript-on-node.md) | TypeScript, run by Node's built-in type stripping | Accepted |
| [0002](0002-event-sourced-engine-on-node-sqlite.md) | Event-sourced engine on `node:sqlite` | Accepted, amended by 0011 |
| [0003](0003-drive-the-claude-cli.md) | Drive the user's `claude` CLI, not the Agent SDK | Accepted |
| [0004](0004-built-in-first-dependency-policy.md) | Built-in first dependency policy | Accepted |
| [0005](0005-typed-step-outcomes-and-out-docs.md) | Typed step outcomes via out docs | Accepted |
| [0006](0006-no-mid-run-questions.md) | Brewers never ask questions mid-run | Accepted |
| [0007](0007-jsonc-config-and-json-frontmatter.md) | JSONC configuration, JSON frontmatter | Accepted, amended by 0020 |
| [0008](0008-polling-intake.md) | Polling intake | Accepted |
| [0009](0009-agpl-and-cla.md) | AGPL-3.0 with a Contributor License Agreement | Accepted |
| [0010](0010-cross-platform-and-isolation-levels.md) | Cross-platform support and isolation levels | Accepted |
| [0011](0011-state-in-the-brewery-repository.md) | State in the Brewery repository (amends 0002) | Accepted |
| [0012](0012-worktrees-from-local-clones.md) | Worktrees from local clones | Accepted |
| [0013](0013-single-repo-sub-orders-bottles-and-releases.md) | Single-repository sub-orders, bottles and release dependencies | Accepted |
| [0014](0014-interactive-refinement-plugin.md) | Interactive refinement through a Claude Code plugin | Accepted, generalised by 0019 |
| [0015](0015-house-yeast.md) | House yeast: scoped, budgeted, promotable rules | Accepted, amended by 0017 and 0018 |
| [0016](0016-delivery-npm-cli-and-companion-plugin.md) | Delivery: an npm CLI and a companion Claude Code plugin | Accepted |
| [0017](0017-test-first-recipes-and-tasting-lenses.md) | Test-first recipes and tasting lenses | Accepted |
| [0018](0018-house-yeast-layers.md) | House yeast in three layers: defaults, Brewery, repository | Accepted |
| [0019](0019-interactive-sessions-and-one-command-layer.md) | Interactive sessions, the autonomous Cellar, and one command layer | Accepted |
| [0020](0020-jsonc-frontmatter.md) | Frontmatter is read as JSONC (amends 0007) | Accepted |

## Template

```markdown
# NNNN. Title

Date: YYYY-MM-DD · Status: Proposed | Accepted | Superseded by NNNN

## Context
## Decision
## Consequences
## Alternatives considered
## Verification (optional: evidence added after acceptance, such as spike results; it does not change the decision)
```
