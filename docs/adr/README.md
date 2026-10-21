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
| [0008](0008-polling-intake.md) | Polling intake | Accepted, amended by 0043, 0050, 0052 and 0068; partly superseded by 0073 |
| [0009](0009-agpl-and-cla.md) | AGPL-3.0 with a Contributor License Agreement | Accepted |
| [0010](0010-cross-platform-and-isolation-levels.md) | Cross-platform support and isolation levels | Accepted, amended by 0039 and 0049 |
| [0011](0011-state-in-the-brewery-repository.md) | State in the Brewery repository (amends 0002) | Accepted, amended by 0024 and 0044 |
| [0012](0012-worktrees-from-local-clones.md) | Worktrees from local clones | Accepted, amended by 0029, 0063 and 0096 |
| [0013](0013-single-repo-sub-orders-bottles-and-releases.md) | Single-repository sub-orders, bottles and release dependencies | Accepted, amended by 0043 |
| [0014](0014-interactive-refinement-plugin.md) | Interactive refinement through a Claude Code plugin | Accepted, generalised by 0019 |
| [0015](0015-house-yeast.md) | House yeast: scoped, budgeted, promotable rules | Accepted, amended by 0017 and 0018 |
| [0016](0016-delivery-npm-cli-and-companion-plugin.md) | Delivery: an npm CLI and a companion Claude Code plugin | Accepted |
| [0017](0017-test-first-recipes-and-tasting-lenses.md) | Test-first recipes and tasting lenses | Accepted, amended by 0022, 0034, 0040, 0078 and 0094 |
| [0018](0018-house-yeast-layers.md) | House yeast in three layers: defaults, Brewery, repository | Accepted, amended by 0041 |
| [0019](0019-interactive-sessions-and-one-command-layer.md) | Interactive sessions, the autonomous Cellar, and one command layer | Accepted, amended by 0025, 0030, 0041, 0042 and 0044 |
| [0020](0020-jsonc-frontmatter.md) | Frontmatter is read as JSONC (amends 0007) | Accepted |
| [0021](0021-unit-tests-spawn-no-processes.md) | Unit tests start no processes | Accepted, amended by 0036, 0038 and 0086 |
| [0022](0022-five-default-lenses.md) | Five default lenses: test design joins the four (amends 0017) | Accepted, amended by 0058 and 0094 |
| [0023](0023-language-independent-recipes.md) | Default recipes are language-independent | Accepted, amended by 0069 |
| [0024](0024-state-branch-layout-outbox-and-divergence.md) | The state branch: layout, outbox and divergence (amends 0002 and 0011) | Accepted, amended by 0027, 0033, 0043 and 0044 |
| [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) | Batch lifecycle: a reminder on Stuck, rewind only from Stuck (amends 0019) | Accepted, amended by 0027, 0032, 0044, 0053 and 0064 |
| [0026](0026-how-a-permission-ceiling-covers-a-rule.md) | How a permission ceiling covers a rule | Accepted |
| [0027](0027-supervisor-lost-and-stalled-attempts.md) | The supervisor: lost and stalled attempts, reminders and the flush retry (amends 0024 and 0025) | Accepted, amended by 0032, 0044 and 0047 |
| [0028](0028-brewer-runner-outcomes-environment-and-test-first.md) | The brewer runner: how an attempt ends, its environment, and testFirst when unset | Accepted, amended by 0042, 0044, 0046, 0047, 0074 and 0099 |
| [0029](0029-attempt-worktrees-layout-claims-and-repair.md) | Attempt worktrees: layout, claims, repair and resumed sessions (amends 0012) | Accepted, amended by 0037, 0043, 0066, 0081, 0084, 0095 and 0096 |
| [0030](0030-only-commands-that-change-state-are-recorded.md) | Only commands that change state are recorded (amends 0019) | Accepted |
| [0031](0031-cmd-and-bat-files-through-cmd-exe.md) | `.cmd` and `.bat` files start through cmd.exe | Accepted, amended by 0069 |
| [0032](0032-routing-deadline-for-ordered-batches.md) | A routing deadline for Ordered batches (amends 0025 and 0027) | Accepted, amended by 0064 and 0068 |
| [0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md) | Chaos tests: effects found by their key, and a driver's leases at its start (amends 0024) | Accepted, amended by 0037, 0043, 0044, 0051 and 0072 |
| [0034](0034-brett-mutants-as-structured-line-edits.md) | Brett’s mutants are one-line structured edits, not patches (amends 0017) | Accepted, amended by 0040 and 0054 |
| [0035](0035-the-process-runner-kills-at-an-output-limit.md) | The process runner kills a process at an output limit | Accepted |
| [0036](0036-test-budget-in-cpu-time.md) | The per-file test budget is CPU time (amends 0021) | Accepted, amended by 0038, 0054 and 0089 |
| [0037](0037-attempt-worktrees-in-the-engine-and-driver-locks.md) | Attempt worktrees in the engine, the Brewery marker and driver locks (amends 0029 and 0033) | Accepted, amended by 0061, 0063, 0066 and 0081 |
| [0038](0038-npm-test-processes-refuse-process-starts.md) | npm test's processes refuse to start processes (amends 0021 and 0036) | Accepted |
| [0039](0039-windows-job-objects-through-a-powershell-helper.md) | On Windows, a process tree that must not outlive a kill runs in a Job Object (amends 0010) | Accepted |
| [0040](0040-brett-covers-scripts-and-kills-need-a-failing-test.md) | Brett covers `scripts/`, and only a test the mutant makes fail kills it (amends 0017 and 0034) | Accepted, amended by 0054 |
| [0041](0041-untrusted-input-in-per-prompt-nonce-tags.md) | Untrusted input in per-prompt nonce tags (amends 0018 and 0019) | Accepted, amended by 0098 |
| [0042](0042-the-claude-command-line-and-stream-contract.md) | The `claude` command line and the stream the brewer runner reads (amends 0003, 0019 and 0028) | Accepted, amended by 0046, 0047, 0062 and 0087 |
| [0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md) | Target-repository issues as a work queue, claimed by a ref (amends 0008, 0013, 0024, 0029 and 0033) | Accepted, amended by 0050 |
| [0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md) | Batch leases held by the driver, and one command log (amends 0002, 0011, 0019, 0024, 0025, 0027, 0028 and 0033) | Accepted, amended by 0050, 0051, 0055 and 0063 |
| [0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) | The local gate reads commands as the shells would, and assumes the worst of what it cannot read | Accepted, amended by 0056, 0060, 0065, 0102 and 0104 |
| [0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md) | Only the runner's settings, the init check, and a stream read line by line (amends 0028 and 0042) | Accepted, amended by 0047, 0049, 0057, 0062 and 0087 |
| [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md) | The `claude` brewer runner: its stream, its endings and its progress (amends 0027, 0028, 0042 and 0046) | Accepted, amended by 0048, 0057 and 0091 |
| [0048](0048-retried-pre-stream-failures-commit-detection-and-out-doc-identity.md) | Retried failures before the stream, commit detection, and the out doc's identity (amends 0047) | Accepted |
| [0049](0049-reviewers-read-only-inside-the-checkout.md) | Reviewers read only inside the checkout: a read guard for the read-only agents, scoped rules for brewers (amends 0010 and 0046) | Accepted, amended by 0057 and 0093 |
| [0050](0050-the-intake-of-target-repository-issues.md) | The intake of target-repository issues: aliases, recorded pull request ends and effect deadlines (amends 0008, 0043 and 0044) | Accepted, amended by 0052 and 0068 |
| [0051](0051-chaos-runs-on-the-real-driver-with-two-drivers-and-a-terminal.md) | Chaos runs on the real driver, with two drivers and a terminal on one store (amends 0033 and 0044) | Accepted, amended by 0055 and 0061 |
| [0052](0052-github-reads-rate-limit-pauses-and-the-polling-interval.md) | GitHub reads: conditional requests, rate-limit pauses and the polling interval (amends 0008 and 0050) | Accepted, amended by 0068, 0072 and 0073 |
| [0053](0053-recipe-files-reach-the-engine-brewer-steps-in-a-line-first.md) | Recipe files reach the engine: brewer steps in a line first, and all or nothing (amends 0025) | Accepted, amended by 0064, 0069, 0084 and 0098 |
| [0054](0054-test-runs-below-normal-priority-and-review-runs-scoped-to-the-question.md) | Test runs below normal priority, and review runs scoped to their question (amends 0034, 0036 and 0040) | Accepted, amended by 0089 |
| [0055](0055-a-step-waits-for-the-lease-of-its-abandoned-attempt.md) | A step waits for the lease of its abandoned attempt (amends 0044 and 0051) | Accepted |
| [0056](0056-the-gate-pre-filter-reads-the-command.md) | The local gate's pre-filter reads the command, not the whole hook input (amends 0045) | Accepted, amended by 0060, 0065 and 0102 |
| [0057](0057-real-claude-tests-are-opt-in-and-claude-proofs-leave-the-suite.md) | Real-claude tests are opt-in, and proofs of claude leave the suite (amends 0046, 0047 and 0049) | Accepted, amended by 0062 and 0093 |
| [0058](0058-the-planted-git-defect-moves-from-the-unit-test-to-the-code.md) | The planted git defect moves from the unit test to the code (amends 0022) | Accepted |
| [0059](0059-attempt-plans-from-the-brewer-of-the-step.md) | Attempt plans from the brewer of the step, and on tap without a pull request (amends 0043, 0047 and 0053) | Accepted, amended by 0062, 0063, 0066, 0071, 0074, 0078 and 0084 |
| [0060](0060-the-gate-refuses-gh-pr-ready-without-the-review-summary.md) | The local gate refuses `gh pr ready` until the review summary for the head is on the pull request (amends 0045 and 0056) | Accepted, amended by 0104 |
| [0061](0061-chaos-faults-at-sites-shrinking-worktrees-and-the-state-branch.md) | Chaos faults at their sites, shrinking, and the worktree and state branch cases (amends 0037 and 0051) | Accepted |
| [0062](0062-brewers-never-allow-git-with-no-fixed-subcommand.md) | Brewers never allow git with no fixed subcommand, and `noPush` still waits for the remote (amends 0042, 0046, 0057 and 0059) | Accepted, amended by 0082 |
| [0063](0063-foedrum-serve-its-configuration-and-wiring.md) | `foedrum serve`: its configuration and wiring (amends 0012, 0037, 0044 and 0059) | Accepted, amended by 0066, 0068 and 0073 |
| [0064](0064-test-first-recipes-when-onblocked-and-a-red-proof-required.md) | Test-first recipes reach the engine: when, onBlocked rounds, and a red proof required (amends 0025, 0032 and 0053) | Accepted, amended by 0069 and 0078 |
| [0065](0065-the-gate-refuses-npx-of-packages-not-in-the-lockfile.md) | The local gate refuses npx of packages that are not in the lockfile (amends 0045 and 0056) | Accepted |
| [0066](0066-the-task-tree-continues-from-the-latest-succeeded-attempt.md) | The task tree continues from the latest succeeded attempt (amends 0029, 0037, 0059 and 0063) | Accepted, amended by 0078 |
| [0067](0067-a-pull-request-of-only-plain-docs-needs-no-review-summary.md) | A pull request of only plain documentation needs no review summary (amends 0060) | Accepted |
| [0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md) | The intake in `foedrum serve`: Brewery orders, routing by label, and relabelled issues (amends 0008, 0032, 0050, 0052 and 0063) | Accepted, amended by 0072 |
| [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) | Check steps run the repository's commands in an attempt of their own (amends 0023, 0031, 0053 and 0064) | Accepted, amended by 0078 |
| [0070](0070-tests-never-hold-the-wall-clock-to-a-limit.md) | Tests never hold the wall clock to a limit (extends 0036) | Accepted, amended by 0075 |
| [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) | The openPullRequest action: two effects of the batch, run by the driver (amends 0053 and 0059) | Accepted, amended by 0079, 0088, 0090 and 0096 |
| [0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md) | The status comment: edits as revisions in the ledger, one a minute per order (amends 0033, 0052 and 0068) | Accepted, amended by 0088 |
| [0073](0073-github-only-through-gh-s-own-login.md) | GitHub only through `gh`'s own login: Foedrum never holds a token (supersedes part of 0008 and 0063, amends 0052) | Accepted, amended by 0075 and 0082 |
| [0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md) | `git.commit` grants fixed git rules, and a commit-producing brewer's `done` needs a commit (amends 0028 and 0059) | Accepted, amended by 0085 and 0095 |
| [0075](0075-only-a-lower-bound-reads-the-wall-clock-and-doctor-runs-against-stub-tools.md) | Only a lower bound reads the wall clock, and doctor's tests run against stub tools (amends 0070 and 0073) | Accepted |
| [0078](0078-the-red-proof-reads-the-test-report-and-testsunchanged-compares-lines.md) | The red proof reads the test report, and testsUnchanged compares the lines of the tests (amends 0017, 0059, 0064, 0066 and 0069) | Accepted |
| [0079](0079-the-push-scans-the-batch-s-commits-for-secrets.md) | The push scans the batch's commits for secrets (amends 0071 and 0084) | Accepted, amended by 0088 and 0090 |
| [0081](0081-the-cleanup-ignores-the-steps-own-out-doc.md) | The cleanup ignores the step's own out doc (amends 0029 and 0037) | Accepted, amended by 0084 |
| [0082](0082-brewers-never-allow-gh.md) | Brewers never allow `gh`, and doctor says what can still reach its login (amends 0062 and 0073) | Accepted, amended by 0088 |
| [0084](0084-a-batch-s-commits-end-in-a-pull-request-or-on-a-kept-branch.md) | A batch's commits end in a pull request or on a kept branch (amends 0029, 0053, 0059 and 0081) | Accepted, amended by 0079, 0092 and 0101 |
| [0085](0085-the-out-doc-contract-names-the-attempts-shell-commands.md) | The out doc contract names the attempt's shell commands (amends 0074) | Accepted, amended by 0087 |
| [0086](0086-the-test-layer-guard-refuses-integration-tests-that-can-start-the-real-gh.md) | The test-layer guard refuses integration tests that can start the real `gh` (amends 0021) | Accepted |
| [0087](0087-sandboxed-commands-go-through-the-allow-rules-and-never-see-credentials.md) | Sandboxed commands go through the allow rules, and never see the credentials Foedrum names (amends 0042, 0046 and 0085) | Accepted |
| [0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md) | Out doc text that looks like a secret is left out of the pull request and the status comment (amends 0071, 0072, 0079 and 0082) | Accepted |
| [0089](0089-a-file-over-the-test-budget-is-measured-again-alone.md) | A file over the test budget is measured again alone (amends 0036 and 0054) | Accepted |
| [0090](0090-the-push-fetches-the-base-in-a-git-directory-of-its-own.md) | The push fetches the base in a git directory of its own (amends 0071 and 0079) | Accepted, amended by 0096 |
| [0091](0091-a-run-out-usage-window-blocks-on-the-environment.md) | A run-out usage window blocks on the environment (amends 0047) | Accepted |
| [0092](0092-foedrum-status-lists-the-task-tree-branches-the-cleanup-keeps.md) | `foedrum status` lists the task-tree branches the cleanup keeps (amends 0084) | Accepted, amended by 0101 |
| [0093](0093-brewers-file-tool-rules-are-read-and-edit-rules-scoped-to-the-worktree.md) | A brewer's file-tool rules are Read and Edit rules scoped to its worktree (amends 0049 and 0057) | Accepted |
| [0094](0094-reviewers-show-their-evidence-and-mark-pre-existing-defects.md) | Reviewers show their evidence and mark pre-existing defects (amends 0017 and 0022) | Accepted |
| [0095](0095-the-cleanups-read-a-worktree-through-its-record-and-run-no-fsmonitor-or-hook.md) | The cleanups read a worktree through its record, and run no fsmonitor command or hook there (amends 0029 and 0074) | Accepted |
| [0096](0096-the-engine-s-git-reaches-the-remote-outside-the-clone-s-configuration.md) | The engine's git reaches the remote outside the clone's configuration (amends 0012, 0029, 0071 and 0090) | Accepted |
| [0097](0097-npm-run-demo-is-a-script-on-serve-s-seams-with-the-tests-fakes.md) | `npm run demo` is a development script on serve's seams, with the tests' fakes | Accepted |
| [0098](0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md) | Foedrum's defaults load under the Brewery's files, and a brewer input can name a lens (amends 0041 and 0053) | Accepted, amended by 0100 |
| [0099](0099-a-rejected-run-end-is-blocked-on-the-environment-not-a-failed-tick.md) | A rejected run end is blocked on the environment, not a failed tick (amends 0028) | Accepted |
| [0100](0100-nip-ships-with-a-default-cellarman-and-the-default-brewers-name-the-builder-alias.md) | Nip ships with a default Cellarman, and the default brewers name the builder alias (amends 0098) | Accepted |
| [0101](0101-the-cleanup-keeps-the-attempt-branches-that-hold-a-rewound-task-tree.md) | The cleanup keeps the attempt branches that hold a rewound task tree (amends 0084 and 0092) | Accepted |
| [0102](0102-the-gate-blocks-a-recursive-delete-of-a-path-built-from-a-variable.md) | The local gate blocks a recursive delete of a path built from a variable (amends 0045 and 0056) | Accepted |
| [0104](0104-the-gate-checks-the-tree-a-command-pushes.md) | The local gate checks the tree a command pushes, not the hook's working directory (amends 0045 and 0060) | Accepted |

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
