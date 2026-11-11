# 0381. A brewer that writes code runs the quick checks before its end, and is sent back once

Date: 2026-11-11 · Status: Accepted · Amends [0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md) (the runner may start claude a second time in one attempt, resuming its session, and `--safe-mode` stays), [0047](0047-the-claude-brewer-runner-its-stream-endings-and-progress.md) (an attempt that was sent back settles on its resumed run, and its checks count as progress), [0172](0172-an-attempt-s-receipt-from-its-stream.md) (such an attempt's receipt is the resumed run's with both runs' counts added) and [0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md) (a repository's check lines also run inside a brewer's attempt, and a lint, format or test line may take paths)

## Context
The Cellarman and the Finer write code.
Their prompts ask them to run the formatter, lint, typecheck and the tests they touched, but nothing makes them do it.
When their session ends, the recipe's `green` check step runs the repository's checks, and a failure sends the batch back along `onFail` (Nip: to `implement`).
That starts a whole new attempt, without the session's context (#993).

The maintainer decided on 2026-11-11 that these two brewers may not end before the checks pass on what they changed:
- build, typecheck, lint and format, on the changed files;
- the tests the red step defined, never the whole suite.

A failure sends the brewer back once, in the same session, with the failure as its message.
A second failure lets the session end as today, and `green` stays the final gate.

The decision named a Claude Code Stop hook in the attempt's settings as the means.
This was checked against claude 2.1.310 with the fake Messages API and the runner's own `claudeArgs`, with a Stop hook in the `--settings` file:
- **With `--safe-mode`,** which every brewer runs with ([ADR 0042](0042-the-claude-command-line-and-stream-contract.md)), the hook ran 0 times and the session ended after one model call. This confirms what [ADR 0049](0049-reviewers-read-only-inside-the-checkout.md) found for `PreToolUse` on 2.1.301: `--safe-mode` turns off hooks in the `--settings` file too.
- **Without `--safe-mode`,** the hook ran. An exit code of 2 sent its stderr back to the model as `Stop hook feedback`, and `stop_hook_active` was `true` on every stop after the first. Claude Code ended the turn only after 9 blocks in a row.
- **A hook past its `timeout`** was killed, and the stop went through.
- **The hook's environment** was the whole of claude's, `ANTHROPIC_API_KEY` included. Nothing put the hook in a sandbox: it ran outside both Claude Code's and the check sandbox.

Dropping `--safe-mode` for the two brewers would bring back the target repository's `CLAUDE.md`, skills, agents, plugins and output styles, which ADR 0042 and ADR 0049 keep out.
It would also run a command beside the model's tool rules, with claude's login in reach.

## Decision
**The runner does the send-back itself, with no hook, and `--safe-mode` stays.**

- **Who.** A brewer whose frontmatter says `"checksBeforeEnd": true`. The default Cellarman and Finer say it, and no other default brewer does.
  - The plan (`createAttemptPlans`) gives such a brewer's attempt `sendBack`, but only when it commits in a repository whose `foedrum.jsonc` has `checks`. `sendBack` holds:
  - the repository's checks it has, in green's order, each as its line for this platform (`sendBackChecks`);
  - the red step's test files (`redTestFiles`): the files the proven step's commits added or changed in a test area of the base's or that step's test map, read in the clone as the testsUnchanged guard reads them ([ADR 0274](0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)). There are none when the recipe has no red step or skipped it, or when git or a map cannot say;
  - the attempt's deadline;
  - the checks' environment, without claude's login ([ADR 0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md)).
- **When.** Once the session ends `done` and its commits are counted after its start ([ADR 0074](0074-git-commit-grants-fixed-git-rules-and-done-needs-a-commit.md)), before the attempt settles.
  An end that is not a success, or a session with no commits, runs no checks.
  So does a runner with no process runner for them, such as an interactive step's own session.
- **What runs (`sendBackLines`).**
  - **Build and typecheck** run whole: a file alone is not what they build or check.
  - **Lint and format** take the paths that the attempt's commits changed and did not delete (`changedPaths`, `git diff --name-only -z --no-renames --diff-filter=d` in the clone). They take them only when their command in `foedrum.jsonc` says `"files": true`. Each path goes after the line in double quotes.
  - **Lint or format runs whole** when its line takes no files, when git cannot list the paths, when a path is not one both `/bin/sh` and cmd.exe can name safely in double quotes, or when the line would pass 4,000 characters. On Windows the line runs in a Job Object through a PowerShell helper that carries it twice encoded, and past about 6,000 characters the helper's own command line passes CreateProcess's 32,767 ([ADR 0039](0039-windows-job-objects-through-a-powershell-helper.md)).
  - **Lint or format is skipped** when the commits only deleted files.
  - **The test line** runs only with `"files": true` and at least one red test file it can name safely, with those files after it. Otherwise it does not run: never the whole suite.
  - **A safe path** is letters, digits, `_ . @ + -`, space and `/`, and starts with a letter, a digit, `_` or `.`, never `- @ + /` or a space. A brewer names the files, so nothing a shell expands or ends a quote on reaches the line, and no tool reads one as an option or a response file.
  - **How the lines run:** one after another, as a check step's do ([ADR 0076](0076-check-steps-run-in-an-os-sandbox-with-no-network.md)). That is through the check sandbox with no network (`sandboxedChecks`; on native Windows unsandboxed, in a Job Object, [ADR 0039](0039-windows-job-objects-through-a-powershell-helper.md)), with a shell, in the worktree, in the checks' environment, and killed 10 s before the attempt's deadline (`runLine`).
  - While they run, the attempt reports progress.
- **The send-back.** The first line that does not pass is the failure.
  - The runner starts claude once more, with `--resume <session>` and the attempt's own settings, tools and system prompt.
  - Its message on stdin is Foedrum's fixed text naming the check and how it ended. The check's line, whose paths a brewer named, and the end of what it printed, which code the brewer wrote may have printed, follow as an untrusted input in a nonce tag ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)). A line or output that holds the tag's nonce is left out.
  - The resumed run's stall clock starts when the resume starts ([ADR 0027](0027-supervisor-lost-and-stalled-attempts.md)).
  - The attempt then settles on that second run: its out doc, its commits, the secret scan, and its own turns and denials, which claude limits per run (`--max-turns`, `maxDenials`), with the tokens of both runs added (`afterSendBack`). Its receipt is the resumed run's, marked `resumed`, with each run's turns, edits, tool errors and denials added ([ADR 0172](0172-an-attempt-s-receipt-from-its-stream.md)).
  - The checks do not run again. A second failure, or no fix, ends the attempt as the session ended it, and `green` decides.
  - A resume that sets up no session keeps the first end. A stop while the checks run, or during the resume, cancels the attempt.
- **What nothing records.** Neither the checks' readings nor the send-back is recorded as an event. The attempt's receipt shows the second run only through its added counts and `resumed`.
- **`files: true`** is optional on any command object in `foedrum.jsonc` (`{ "run": "biome lint", "files": true }`), the setup's and a recipe's literal check command included. Only the checks before a brewer's end read it, and only on `lint`, `format` and `test`. A check step runs the line as written.

## Consequences
- A failure the brewer could fix while it holds its context costs one resumed turn, not a new attempt through `green`'s `onFail`.
  The message is at most `MAX_TAIL_LENGTH` (4,000) characters of output and two sentences.
  The resumed run re-reads the session's context, mostly from the prompt cache.
- **Time per attempt,** measured on Foedrum's own checkout on 2026-11-11, before the build:
  - `tsc --noEmit` on the whole project: 11.3 s;
  - `biome check` on 3 files: 4.9 s, and on the whole repository 3.6 s, since its start-up dominates;
  - `node --test` on 2 unit files: 2.5 s;
  - so about 20 s, against `npm run check` taking 115 s on CI's Linux leg;
  - a send-back adds a second claude start, about 5 s against the fake Messages API, plus the model's turns.
  The checks run inside the attempt's deadline (Cellarman 30 min, Finer 20 min).
- `green` is unchanged and still the gate: it runs every check, the whole suite included.
- **The Stop hook is not used.** Should a later Claude Code run `--settings` hooks under `--safe-mode`, a hook would still run beside the model's tool rules with claude's login in reach. The runner's own send-back keeps the checks in the check sandbox, in the checks' environment.
- **The real `claude` test** (`test/integration/claude-runner-send-back.test.ts`, opt-in as [ADR 0057](0057-real-claude-tests-are-opt-in-and-claude-proofs-leave-the-suite.md) sets) shows that the resumed session's next model call holds the conversation before it and the failure.
- **Brewery migration:** none. Foedrum has no release yet. The key is optional: a repository whose lint or test line takes no `"files": true` runs lint whole and no tests before the end.
