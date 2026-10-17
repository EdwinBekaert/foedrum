# Architecture decision records

Each record captures one decision: context, decision, consequences and the alternatives considered. Records are immutable once accepted; a change of mind is a new record that supersedes the old one.

| # | Decision | Status |
|---|---|---|
| [0001](0001-typescript-on-node.md) | TypeScript, run by Node's built-in type stripping | Accepted |
| [0002](0002-event-sourced-engine-on-node-sqlite.md) | Event-sourced engine on `node:sqlite` | Accepted, amended by 0011, 0024 and 0044 |
| [0003](0003-drive-the-claude-cli.md) | Drive the user's `claude` CLI, not the Agent SDK | Accepted, amended by 0042 |
| [0004](0004-built-in-first-dependency-policy.md) | Built-in first dependency policy | Accepted |
| [0005](0005-typed-step-outcomes-and-out-docs.md) | Typed step outcomes via out docs | Accepted |
| [0006](0006-no-mid-run-questions.md) | Brewers never ask questions mid-run | Accepted |
| [0007](0007-jsonc-config-and-json-frontmatter.md) | JSONC configuration, JSON frontmatter | Accepted, amended by 0020 |
| [0008](0008-polling-intake.md) | Polling intake | Accepted, amended by 0043, 0050 and 0052 |
| [0009](0009-agpl-and-cla.md) | AGPL-3.0 with a Contributor License Agreement | Accepted |
| [0010](0010-cross-platform-and-isolation-levels.md) | Cross-platform support and isolation levels | Accepted, amended by 0039 and 0049 |
| [0011](0011-state-in-the-brewery-repository.md) | State in the Brewery repository (amends 0002) | Accepted, amended by 0024 and 0044 |
| [0012](0012-worktrees-from-local-clones.md) | Worktrees from local clones | Accepted, amended by 0029 |
| [0013](0013-single-repo-sub-orders-bottles-and-releases.md) | Single-repository sub-orders, bottles and release dependencies | Accepted, amended by 0043 |
| [0014](0014-interactive-refinement-plugin.md) | Interactive refinement through a Claude Code plugin | Accepted, generalised by 0019 |
| [0015](0015-house-yeast.md) | House yeast: scoped, budgeted, promotable rules | Accepted, amended by 0017 and 0018 |
| [0016](0016-delivery-npm-cli-and-companion-plugin.md) | Delivery: an npm CLI and a companion Claude Code plugin | Accepted |
| [0017](0017-test-first-recipes-and-tasting-lenses.md) | Test-first recipes and tasting lenses | Accepted, amended by 0022, 0034 and 0040 |
| [0018](0018-house-yeast-layers.md) | House yeast in three layers: defaults, Brewery, repository | Accepted, amended by 0041 |
| [0019](0019-interactive-sessions-and-one-command-layer.md) | Interactive sessions, the autonomous Cellar, and one command layer | Accepted, amended by 0025, 0030, 0041, 0042 and 0044 |
| [0020](0020-jsonc-frontmatter.md) | Frontmatter is read as JSONC (amends 0007) | Accepted |
| [0021](0021-unit-tests-spawn-no-processes.md) | Unit tests start no processes | Accepted, amended by 0036 and 0038 |
| [0022](0022-five-default-lenses.md) | Five default lenses: test design joins the four (amends 0017) | Accepted, amended by 0058 |
| [0023](0023-language-independent-recipes.md) | Default recipes are language-independent | Accepted |
| [0024](0024-state-branch-layout-outbox-and-divergence.md) | The state branch: layout, outbox and divergence (amends 0002 and 0011) | Accepted, amended by 0027, 0033, 0043 and 0044 |
| [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) | Batch lifecycle: a reminder on Stuck, rewind only from Stuck (amends 0019) | Accepted, amended by 0027, 0032, 0044 and 0053 |
| [0026](0026-how-a-permission-ceiling-covers-a-rule.md) | How a permission ceiling covers a rule | Accepted |
| [0027](0027-supervisor-lost-and-stalled-attempts.md) | The supervisor: lost and stalled attempts, reminders and the flush retry (amends 0024 and 0025) | Accepted, amended by 0032, 0044 and 0047 |
| [0028](0028-brewer-runner-outcomes-environment-and-test-first.md) | The brewer runner: how an attempt ends, its environment, and testFirst when unset | Accepted, amended by 0042, 0044, 0046 and 0047 |
| [0029](0029-attempt-worktrees-layout-claims-and-repair.md) | Attempt worktrees: layout, claims, repair and resumed sessions (amends 0012) | Accepted, amended by 0037 and 0043 |
| [0030](0030-only-commands-that-change-state-are-recorded.md) | Only commands that change state are recorded (amends 0019) | Accepted |
| [0031](0031-cmd-and-bat-files-through-cmd-exe.md) | `.cmd` and `.bat` files start through cmd.exe | Accepted |
| [0032](0032-routing-deadline-for-ordered-batches.md) | A routing deadline for Ordered batches (amends 0025 and 0027) | Accepted |
| [0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md) | Chaos tests: effects found by their key, and a driver's leases at its start (amends 0024) | Accepted, amended by 0037, 0043, 0044 and 0051 |
| [0034](0034-brett-mutants-as-structured-line-edits.md) | Brett’s mutants are one-line structured edits, not patches (amends 0017) | Accepted, amended by 0040 and 0054 |
| [0035](0035-the-process-runner-kills-at-an-output-limit.md) | The process runner kills a process at an output limit | Accepted |
| [0036](0036-test-budget-in-cpu-time.md) | The per-file test budget is CPU time (amends 0021) | Accepted, amended by 0038 and 0054 |
| [0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md) | Attempt worktrees in the engine, the Brewery marker and driver locks (amends 0029 and 0033) | Accepted, amended by 0061 |
| [0038](0038-npm-test-processes-refuse-process-starts.md) | npm test's processes refuse to start processes (amends 0021 and 0036) | Accepted |
| [0039](0039-windows-job-objects-through-a-powershell-helper.md) | On Windows, a process tree that must not outlive a kill runs in a Job Object (amends 0010) | Accepted |
| [0040](0040-brett-covers-scripts-and-kills-need-a-failing-test.md) | Brett covers `scripts/`, and only a test the mutant makes fail kills it (amends 0017 and 0034) | Accepted, amended by 0054 |
| [0041](0041-untrusted-input-in-per-prompt-nonce-tags.md) | Untrusted input in per-prompt nonce tags (amends 0018 and 0019) | Accepted |
| [0042](0042-the-claude-command-line-and-stream-contract.md) | The `claude` command line and the stream the brewer runner reads (amends 0003, 0019 and 0028) | Accepted, amended by 0046, 0047 and 0062 |
| [0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md) | Target-repository issues as a work queue, claimed by a ref (amends 0008, 0013, 0024, 0029 and 0033) | Accepted, amended by 0050 |
| [0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) | Batch leases held by the driver, and one command log (amends 0002, 0011, 0019, 0024, 0025, 0027, 0028 and 0033) | Accepted, amended by 0050, 0051 and 0055 |
| [0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) | The local gate reads commands as the shells would, and assumes the worst of what it cannot read | Accepted, amended by 0056 and 0060 |
| [0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md) | Only the runner's settings, the init check, and a stream read line by line (amends 0028 and 0042) | Accepted, amended by 0047, 0049, 0057 and 0062 |
| [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md) | The `claude` brewer runner: its stream, its endings and its progress (amends 0027, 0028, 0042 and 0046) | Accepted, amended by 0048 and 0057 |
| [0048](0048-retried-pre-stream-failures-commit-detection-and-out-doc-identity.md) | Retried failures before the stream, commit detection, and the out doc's identity (amends 0047) | Accepted |
| [0049](0049-reviewers-read-only-inside-the-checkout.md) | Reviewers read only inside the checkout: a read guard for the read-only agents, scoped rules for brewers (amends 0010 and 0046) | Accepted, amended by 0057 |
| [0050](0050-the-intake-of-target-repository-issues.md) | The intake of target-repository issues: aliases, recorded pull request ends and effect deadlines (amends 0008, 0043 and 0044) | Accepted, amended by 0052 |
| [0051](0051-chaos-runs-on-the-real-driver-with-two-drivers-and-a-terminal.md) | Chaos runs on the real driver, with two drivers and a terminal on one store (amends 0033 and 0044) | Accepted, amended by 0055 and 0061 |
| [0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md) | GitHub reads: conditional requests, rate-limit pauses and the polling interval (amends 0008 and 0050) | Accepted |
| [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) | Recipe files reach the engine: brewer steps in a line first, and all or nothing (amends 0025) | Accepted |
| [0054](0054-test-runs-below-normal-priority-and-review-runs-scoped-to-the-question.md) | Test runs below normal priority, and review runs scoped to their question (amends 0034, 0036 and 0040) | Accepted |
| [0055](0055-a-step-waits-for-the-lease-of-its-abandoned-attempt.md) | A step waits for the lease of its abandoned attempt (amends 0044 and 0051) | Accepted |
| [0056](0056-the-gate-pre-filter-reads-the-command.md) | The local gate's pre-filter reads the command, not the whole hook input (amends 0045) | Accepted, amended by 0060 |
| [0057](0057-real-claude-tests-are-opt-in-and-claude-proofs-leave-the-suite.md) | Real-claude tests are opt-in, and proofs of claude leave the suite (amends 0046, 0047 and 0049) | Accepted, amended by 0062 |
| [0058](0058-the-planted-git-defect-moves-from-the-unit-test-to-the-code.md) | The planted git defect moves from the unit test to the code (amends 0022) | Accepted |
| [0060](0060-the-gate-refuses-gh-pr-ready-without-the-review-summary.md) | The local gate refuses `gh pr ready` until the review summary for the head is on the pull request (amends 0045 and 0056) | Accepted |
| [0061](0061-chaos-faults-at-sites-shrinking-worktrees-and-the-state-branch.md) | Chaos faults at their sites, shrinking, and the worktree and state branch cases (amends 0037 and 0051) | Accepted |
| [0062](0062-brewers-never-allow-git-with-no-fixed-subcommand.md) | Brewers never allow git with no fixed subcommand, and `noPush` still waits for the remote (amends 0042, 0046, 0057 and 0059) | Accepted |

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
