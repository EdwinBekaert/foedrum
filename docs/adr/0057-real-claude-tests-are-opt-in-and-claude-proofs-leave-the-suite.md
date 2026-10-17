# 0057. Real-claude tests are opt-in, and proofs of claude leave the suite

Date: 2026-10-17 · Status: Accepted · Amends [0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md), [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md) and [0049](0049-reviewers-read-only-inside-the-checkout.md) (where their `claude` tests run)

## Context
Since #127, `npm run test:integration` starts the installed `claude` on every machine that has it on PATH: ADR 0046, 0047 and 0049 have their tests against `claude` and the fake Messages API run wherever it is found, and skip elsewhere, CI included. Three files did that:

- `test/integration/claude-cli.test.ts` proved that `claude` honours `--setting-sources ""` (ADR 0046).
- The `claude` block of `test/integration/read-guard.test.ts` ran our read guard as a hook inside `claude` once, and otherwise proved how `claude` treats a settings file's hooks under `--safe-mode`, file rules scoped to the worktree, and links inside a searched folder (ADR 0049).
- `test/integration/claude-runner.test.ts` runs our runner against the real `claude` (ADR 0047).

The first two test Claude Code, not Foedrum. Foedrum does not test whether third-party tools work: the same rule as for git, and the reason version tracking was dropped from #136. The third tests our code, but CI never runs it, so it adds minutes to every local integration run, gives results that depend on whichever `claude` happens to be installed, and protects nothing CI checks (#149).

## Decision
- **Proofs of `claude` are not tests in the suite.** `claude-cli.test.ts` is deleted, and so are eight of the nine tests in the `claude` block of `read-guard.test.ts`: the control read without a hook, and how `claude` treats hooks under `--safe-mode`, file rules scoped to the worktree, a bare `Grep` rule, and links inside a searched folder. What they showed stays on record in the Verification lines of ADR 0046 and 0049, against `claude` 2.1.301; the tests are in the history before #149. The read guard script keeps its own tests (the hook command run through bash, real links, short names).
- **One read-guard test against `claude` stays, opt-in.** "Blocks a read outside the worktree when the settings file has the read guard, without --safe-mode" runs our `scripts/read-guard.ts` as a hook inside the real `claude` and checks that its message (`outside the checkout`) is what the model gets back. That tests Foedrum's code against the real tool, like the runner test, so it is kept under the same switch.
- **Tests of Foedrum's code against the real `claude` are opt-in.** Those are the runner test (`claude-runner.test.ts`) and the read-guard test above. They run only when `FOEDRUM_REAL_CLAUDE=1` is set, and skip otherwise with a message that names the variable. `realClaude` (`test/helpers/real-claude.ts`) decides, so every such test asks the same way. Another value (`true`, `0`, an empty string) does not opt in.
- **Opted in without `claude`, the run fails.** When the variable is set and `claude` is not on PATH, `realClaude` throws, so the file fails to run instead of skipping: whoever asked for the tests learns they did not run.
- **git and npm integration tests stay as they are.** They test Foedrum's code against the real tools and run in CI on every leg.

## Consequences
- `npm run test:integration` no longer starts `claude` unless asked to. CLAUDE.md goes back to the original rule: tests against the real `claude` CLI are opt-in.
- A `claude` release that loads the user's settings again despite `--setting-sources ""`, or follows links in a search, is no longer caught by a test. At run time the init check (ADR 0046) still catches a session that is not what the runner asked for (a tool removed, the permission mode), but not an allow rule or a variable.
- A change to the claude runner should be run with `FOEDRUM_REAL_CLAUDE=1` on a machine that has `claude` before it is merged; CI cannot do it.

## Alternatives considered
- **Keep the proofs as a script under `scripts/`.** #149 allows it. Rejected for now: a script nobody runs drifts, and git history holds the exact test should someone need to prove a version again.
- **Skip when opted in without `claude`.** Rejected: a silent skip after asking for the tests is the trap the opt-in exists to avoid.
- **Run the runner test in CI with `claude` installed.** It would make CI depend on a third-party download at an unpinned version, and #136 dropped version tracking for that reason.
