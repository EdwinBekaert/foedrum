# 0378. Out doc lines that look like secrets stay off the state branch, and a push refused for one stops the engine

Date: 2026-11-11 · Status: Accepted · Amends [0103](0103-out-docs-reach-the-state-branch-through-the-store.md) (the flush no longer writes an out doc byte for byte), [0024](0024-state-branch-layout-outbox-and-divergence.md) (a third outcome of the state branch's push) and [0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md) (out doc text that looks like a secret now also stays off the state branch, the later issue it left that to, and there a full commit hash passes)

## Context
A flush wrote a kept out doc to the state branch as the brewer wrote it ([ADR 0103](0103-out-docs-reach-the-state-branch-through-the-store.md)); only past 256 KiB did a fixed line take its place.
Out docs are model output that read the order, the repository and tools' output, so one can hold a token-shaped string.
[ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md) leaves such text out of the pull request and the status comment, and #753 filters release notes before they are recorded, but nothing read the out doc on its way to the branch.
When GitHub's push protection matches one, the state-branch push is refused.
`classifyPush` called a refusal `rejected` only for `[rejected]` (another engine pushed); push protection's `[remote rejected]` fell to `failed`, which the supervisor reports as `flush_failed` at every tick and retries.
The log is append-only, so every later commit carries the refused one: the same push is refused forever, in a line a person reads as a network blip.
No failure has been seen; the path was found in the review of #753 (security lens), and this is #756.

## Decision
- **Each out doc line that looks like a secret is replaced where it stood** by `[left out: a line of <step>#<attempt> that looks like a secret]`, with the line's own line end, in `outDocFile` (`src/engine/state-branch.ts`), after the 256 KiB check.
  Never the line, nor `findSecrets`' excerpt of it.
  The rest of the doc keeps its bytes and its line numbers, so a person reading what a brewer did sees where something was taken out.
- **A private key's block goes whole:** from a line `findSecrets` reads as a private key's start (`-----BEGIN … PRIVATE KEY-----`) every line is replaced, through the line that ends it, or to the end of the doc without one.
  Its body lines need not look like a secret one by one: a key's last line is often shorter than the 40 characters the base64 pattern reads, and a model may wrap them shorter still.
- **By line, not the whole doc** as `withoutSecrets` does for the pull request: one token would otherwise turn a 256 KiB plan or review into one line.
  A match that only joining two lines makes (`password` on one, `= x` on the next) is not read for; push protection matches single tokens.
- **A full commit hash passes** (`isCommit` answers yes, as release notes' does): out docs name the commits they made and read, and a hash is no key a brewer can choose.
  `findSecrets` asks this only of a hexadecimal word of exactly 40 characters, so a secret of exactly that shape reaches the branch; shorter and longer ones are still left out.
  The state's known commits (ADR 0088's lookup) would need a fold in the flush and would still miss a brewer's own commits, such as the Gauger's red commit.
- **The filter runs where the bytes leave**, not where the doc is kept: `planFlush` is the one place every kept doc goes through, it is pure, and it covers any later writer of the store's `out_docs`.
  The local store keeps the raw text until the push forgets it, on the machine whose attempt worktree holds the same file; the flush is that table's only reader, and the handover reads the raw doc before it is kept and filters each of its own lines ([ADR 0340](0340-a-brewer-s-handover-is-kept-as-a-proposal-and-reaches-no-later-prompt.md)).
- **A push refused for a secret is its own outcome**, `secret`: `git push --porcelain` prints a `!` line with `[remote rejected]`, and stderr names push protection (`push protection`, `Push cannot contain secrets`, or the older `Secrets detected`).
  `[rejected]` stays another engine's push; a `[remote rejected]` without those words (a hook, another ruleset rule) and a push with no `!` line (no network) stay `failed`.
- **It stops the engine** with `StateBranchStopError`, reported once, as a rejected push does: no batch can record anything on the branch until the refused commit is accepted, so a Stuck event could never reach it.
  The line names the commit, the events it holds, each unblock page GitHub printed (`https://<host>/<owner>/<repo>/security/secret-scanning/unblock-secret/<id>`, the only part of stderr it repeats) and the way on: the account that pushed allows the secret on that page and starts the engine again within three hours, or, without that right, asks an admin of the repository for a bypass.
  The start-up flush then pushes the same commit; nothing is rewritten ([ADR 0024](0024-state-branch-layout-outbox-and-divergence.md)).
  Last, the line says the other way: start again after moving the database aside, which rebuilds it from the branch and loses what is not on it.
- **Known: the event log carries model text that is not filtered.** On `events.jsonl` these fields hold it with no secret filter on their way: `step.finished`'s `outcome.output` (the out doc's whole frontmatter: summary, assumptions, plan entries, findings, risk left; `src/schemas/step-outcome.ts`, built in `src/engine/brewer-runner.ts`), a `needs_input` outcome's questions and `batch.stuck`'s `reason.questions`, a `blocked` outcome's summary and findings with `batch.stuck`'s `reason.summary` and `roundsOut.open`, `step.finished`'s `findings`, `attempts_exhausted`'s `lastReason` where its failed reason quotes the out doc, and `step.finished`'s `mutants` texts.
  Handover lines, release notes, check tails and job log excerpts are read for secrets before they are recorded.
  Nothing is built for these here: if push protection ever refuses one, the push is named and the unblock page gets the engine going again.

## Consequences
- A token an out doc copied stays off the Brewery's state branch, where it may have other readers than the place it came from, and off GitHub's push protection.
- A refused state-branch push is one line that says what happened and what to do, not a `flush_failed` at every tick.
- The exact text push protection prints is not in GitHub's documentation: the words `classifyPush` reads are those it printed when this was written, and a change of them makes the refusal a `failed` flush again, as before.
- Each flush reads each kept doc again until its push lands, normally once: at most 256 KiB per doc.
- **Brewery migration:** none: Foedrum has no release.

## Alternatives considered
- **Leave the whole doc out on any match**, as ADR 0088 does for the pull request: a person would lose the whole plan or review for one line.
- **Filter when the doc is kept** (`keepOutDocs`): the store would never hold the text, but the worktree beside it does, and a second writer of the table would bypass it.
- **A Stuck-like state the driver reports once:** it would need an event, and no event reaches the branch past the refused commit.
- **Keep retrying, with the refusal named:** the log is never rewritten, so every retry is refused again.
