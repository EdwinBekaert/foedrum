# 0280. A new module is judged unreached only on a passing test run

Date: 2026-10-31 · Status: Accepted · Amends [0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) (when a module no confirmed line reaches makes the batch Stuck, and a compile error of a reached new module)

## Context
[ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md) makes a batch Stuck (`environment`) when a module that only the batch's test map lists writes no report: no confirmed line reaches it.
It accepts that a new module the confirmed line does reach, but that fails to compile, reads as unreached, and its batch is Stuck instead of retried.
The review of #715 found a wider case.
A confirmed line that runs several suites one after another stops at the first one that fails, so a later module writes no report though the line reaches it.
At a red proof, the run is meant to fail: every red proof of the batch would end Stuck, saying no line reaches the module, until the map merged.
A green step whose older test still fails would be Stuck the same way, where its `onFail` route should send it back.

## Decision
- **A new module is judged unreached only when the test check exited 0.** A failing run, or one that did not exit, keeps its own ending: a red proof's verdict stands, and a failed check takes its `onFail` route.
- **A truly unreached module is caught at the next passing run**, such as Nip's `green`, which must pass before the pull request opens.
- **A compile error or a failing run of a reached new module goes along `onFail`**, to the brewer, instead of Stuck.
- The Stuck reason no longer suggests chaining the module's tests after the others with `&&`: it says to make the `test` line also run them, whatever the tests before them give.

## Consequences
- A module that no line reaches is found one passing run later than 0274 has it, never at a red proof.
- A new module that fails to compile costs a retry of the step that broke it before a person sees it, rather than a Stuck batch at once.
- An unreadable map at the step's tip is read only on a passing run too; a failing run already goes along `onFail` to the brewer that would fix it.

## Alternatives considered
- **Judge every exited run, and only change the suggested line.** A line a person already wrote with `&&`, or a runner that stops at its first failing project, would still make every red proof Stuck.
- **Judge a failing run by whether the module's report folder exists.** That reads the runner's layout, which the test map deliberately leaves to the reports.
