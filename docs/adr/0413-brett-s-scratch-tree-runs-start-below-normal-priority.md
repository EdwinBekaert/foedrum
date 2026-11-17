# 0413. Brett's scratch-tree runs start below normal priority

Date: 2026-11-17 · Status: Accepted · Amends [0313](0313-the-engine-runs-brett-s-mutants-in-scratch-trees-against-a-fresh-baseline.md) (its runs no longer start at normal priority) and [0039](0039-windows-job-objects-through-a-powershell-helper.md) (the helper may create its program below normal)

## Context
[ADR 0313](0313-the-engine-runs-brett-s-mutants-in-scratch-trees-against-a-fresh-baseline.md) has the engine run a Brett step's baseline and each valid mutant's `test` check in scratch trees of their own: up to six full test runs, each with the repository's setup, on the machine where the Brewery's other brewers and sessions run.
They started at normal priority, and it left running them below normal to #809.
Deep-brew now runs a blocking Brett step ([ADR 0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md)), so every deep-brew batch runs them.
`scripts/below-normal-priority.ts` lowers only its own process, for Foedrum's own test runs (#140), and nothing in `src/platform/` started a child below normal.
Setting a child's priority after it starts leaves a moment when it runs at normal and may already have started its own children, which keep the class they started with.
Tools that start a child below normal set it when they create the child:
- Gradle's daemon with `org.gradle.priority=low` (gradle/gradle pull request 7403, `DefaultDaemonStarter.getPriorityArgs`) starts it through `nice -n 10` on POSIX and `cmd /C start /B /belownormal /WAIT` on Windows.
- CPython since 3.7 (bpo-31884, pull request 4150) takes `subprocess.BELOW_NORMAL_PRIORITY_CLASS` among `Popen`'s `creationflags`.
- On Windows, a process created with no priority class flag inherits its creator's class when that is `BELOW_NORMAL_PRIORITY_CLASS` or `IDLE_PRIORITY_CLASS`, and gets `NORMAL_PRIORITY_CLASS` otherwise (Microsoft's documentation of `CreateProcessW` and of scheduling priorities).

## Decision
- **`execProcess` takes `belowNormal`.** The program starts below normal priority, and every process it starts inherits it.
- **Outside Windows, through `nice -n 10`.** `belowNormalCommand` puts `nice -n 10` before the program, or before `/bin/sh -c <line>` for a command line, so the sandbox's bwrap or sandbox-exec, the shell and everything under them start niced. nice is found on `PATH`, as bwrap is. A run that cannot have it does not start, and says that nice is not on `PATH`. nice runs its program in its own process, so bwrap's extra pipes still reach bwrap.
- **On Windows, in the Job Object's creation flags.** `jobObjectCommand` gives the helper `$flags`, and with `belowNormal` the helper adds `BELOW_NORMAL_PRIORITY_CLASS` (0x4000) to `CREATE_SUSPENDED` and `CREATE_UNICODE_ENVIRONMENT`. The program is created below normal, before it runs, and its children inherit the class. The helper itself, which only waits, stays at normal. Without a Job Object the option does nothing on Windows. Its one caller, `runLine`, always asks for a Job Object.
- **Only Brett's scratch-tree runs ask for it.** `testRun` runs the setup and the `test` check below normal, through `runLine`'s `belowNormal`. A check step's checks, the red proof, the checks before a brewer's end and a pull request's merged tree keep normal priority: they gate a step, and nothing else is waiting on Brett's runs.
- **The check sandbox passes it on.** `sandboxedChecks` already hands the caller's options to the process it starts: bwrap, a setup's bwrap with its network namespace, sandbox-exec, and the line on native Windows. A setup's network stack (pasta or slirp4netns) keeps normal priority, since it carries packets for the line rather than running tests.

## Consequences
- While a Brett step runs its mutants, its test processes show below normal priority (`ps -o ni` shows 10 more than the Brewery's own process; the task manager shows "Below normal"). The Brewery's other brewers and a person's terminal keep their share of the CPU.
- A Brett step on a busy machine takes longer, within its deadline as before. A slow run leaves later mutants `notJudged`, as [ADR 0313](0313-the-engine-runs-brett-s-mutants-in-scratch-trees-against-a-fresh-baseline.md) says.
- A Brewery needs no change. Outside Windows the Cellar needs `nice` on `PATH`. POSIX requires it, and coreutils, BusyBox and macOS install it by default, so `foedrum doctor` does not look for it as it does for bwrap, which a Cellar installs itself. On a Cellar without it, every mutant of a Brett step is recorded `notJudged` with the baseline's reason, `nice: not found on PATH`, and a blocking Brett step blocks nothing.
- An integration test on every CI platform starts a command line with `belowNormal` and reads the priority of the program its shell starts.

## Alternatives considered
- **Set the helper's priority class right after spawn, as #809 first said.** node answers from spawn while PowerShell is still loading, so the helper would usually be lowered before it creates the program, but nothing guarantees that order. The creation flag has no such moment, and Gradle and CPython both set the class at creation.
- **`os.setPriority` on the child's pid after spawn, on every platform.** The same race, and outside Windows a priority set on one process does not reach the children it already started.
- **Lower Foedrum's own process, as `scripts/below-normal-priority.ts` does for Foedrum's tests.** Then every brewer, check and git call would run below normal too, including the steps that gate a batch.
- **Below normal for every check.** A check step gates its batch, and a person waits on it. Brett's runs are the ones with up to six full test runs in a row.
