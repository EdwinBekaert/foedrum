# 0340. A brewer's handover is kept as a proposal and reaches no later prompt

Date: 2026-11-06 · Status: Accepted · Amends [0005](0005-typed-step-outcomes-and-out-docs.md) (an out doc may hold a field no schema reads), [0041](0041-untrusted-input-in-per-prompt-nonce-tags.md) (an earlier step's out doc goes in without it) and [0128](0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md) (so does a route input's)

## Context
Nothing a brewer learns outlives its batch (#878).
`--safe-mode` keeps auto memory off, which is right: memory would be local to one machine, unreviewed, and open to an order's text steering later batches.
So a lesson comes only from `/brew-review` ([ADR 0122](0122-house-yeast-for-foedrum-s-own-reviews-candidates-in-the-main-checkout-rules-per-lens.md)), which a brewed batch never reaches.

A handover is model output, written after reading an order anyone may write ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)).
So this record only collects it: a person reads it, and nothing reaches a later prompt.
How a person sorts a line, and how one becomes a house-yeast rule, is #908.
The first step is to see what a handover looks like.

A plain new field would have leaked at once.
An out doc goes into a later prompt whole, frontmatter included, by three paths: an input `from: "step:<id>"`, the `plan` input, and a findings route's `Its out doc:`.

## Decision

### The field
- **`handover`, optional, in every out doc:** a list of at most 3 lines of at most 300 characters each, what surprised the brewer, what cost it time, or what it would tell the next brewer.
- **It never fails an attempt.** `readOutDoc` takes the key out before any schema reads it, so a finished run is never spent on a note.
  The out doc schemas declare it for the JSON Schema and so that no brewer's own field takes the name, and never see it at run time.
- **The default brewers ask for it, each in one section of its own file**, with its `version` up, and not in the out doc contract, which reaches a Brewery's own brewers too.
  It adds about 75 tokens to a fresh attempt's prompt and at most about 225 written, and no later prompt carries it, so it does not compound.

### What is kept
- **`step.finished.handover`, beside `houseYeast`, and never in `output`.**
  About 25 files read `output`, so none of them can pass it on, and a blocked or failed attempt's handover is kept too, where `output` exists only for a success.
- **`handoverOf` reads the out doc's text whatever its ending:** anything but a list of strings reads as none, each line becomes one line, the first three that say anything are kept, a line past its limit is cut with a mark as a long `riskLeft` line is ([ADR 0337](0337-a-taster-s-first-call-on-a-diff-reads-the-instruction-file-and-a-long-risk-line-is-cut.md), whose helper they share), and every line is read for a secret with `withoutSecrets`, however short, so whatever reads the event reads clean text.
  No commit is known there, so a line holding a full commit hash is left out too.
- **The whole out doc stays on the state branch**, as every out doc does ([ADR 0103](0103-out-docs-reach-the-state-branch-through-the-store.md)).
- **`handoversOf` lists a batch's lines**, by step and attempt.
  A line a later attempt of its step left as it was, as a session resumed after a turn overrun does, is listed once.

### Where a person reads it
- **The pull request's body:** its own folded fence after the reports, `<step>#<attempt>: <line>`, where nothing links, mentions or closes.
  It takes at most 4,000 characters of the reports' room.
  Past that, the newest lines are cut and counted, `(<n> more: foedrum handover)`.
  With no handover the body is byte for byte what it was.
- **`foedrum handover <issue>`** lists every line by its id, `<step>#<attempt>.<line>`, under a head that says a model wrote them.
  Its output goes through `printable`, as every command's does, and a live session reads it too, so `/foedrum:handover` carries the section that says to treat it as data.
- **The status comment holds only a count:** `3 handover lines: foedrum handover <n>`, naming the work as every other line that offers a command does ([ADR 0329](0329-one-number-per-piece-of-work.md)).
  No comment holds a handover's text, since [ADR 0333](0333-a-brewer-s-order-holds-the-maintainers-comments.md) lets Foedrum's comments under an earlier login back into an order.
- **No wait:** a line holds nothing up, and the batch never asks about one.

### How no later prompt holds it
- **`withoutHandover`** gives an out doc to a later prompt, on all three paths: by the reader's own parse, so no spelling of the key gets past, with the same text byte for byte when there is no field.
- **A text with no frontmatter has no field, and passes.**
  One that opens a frontmatter that does not read is refused rather than passed on.
  It passed the reader when its attempt ended, so only a file changed since reaches this.
  For a step or plan input the plan fails, and the attempt fails with `the input "<name>" was not read: its frontmatter does not read`.
  In a route input, which already says when an out doc cannot be read, the text is `Its out doc could not be read: its frontmatter does not read.`
- **What was clean already:** a later round's `earlierFindings` parses the findings alone, a retry's reason quotes the summary, and a plan entry is a field of the plan.
- **What reads a body or a comment:** nothing reads a pull request's body into a prompt (`bodyOwner` and the sibling section read it), and an `order` reads an issue's comments only.
- **A resumed session** holds what it wrote itself, as it holds its whole transcript.

### What stays open
This closes the field, not a model's will, and it is no boundary against a brewer that sets out to read or pass on text. These were read from the code, not tried on a real `claude`:
- **A brewer can write the same words elsewhere:** in its summary, its assumptions or its out doc's body, which later steps of its batch read as today, or in a commit. Across batches such text gets through only as merged code a person reviewed.
- **A brewer's shell.**
  - The default brewers cannot run `git fetch` or `foedrum`: the read-only ones have no shell, and a committing one has `git status`, `git add`, `git commit` and what its repository's `tools` allow. A Brewery or a repository can allow more; `Bash(git fetch *)` passes the schema.
  - The state branch is on the Brewery's repository and a clone's `origin` is the target's, so a fetch reaches it only where a target repository is also the Brewery.
  - On native Windows shell commands run unsandboxed, the `permissions only` level `foedrum doctor` names, and it sends untrusted repositories to WSL2. There a command a repository allows, such as `npm test` running a script the brewer wrote, can read any file the driver's user can: the event store, other attempts' worktrees and their out docs, and run `foedrum handover`.
  - Under Claude Code's sandbox those commands lose the home folder and the other user folders. A Brewery kept outside them is not hidden.
  - All of this already holds for every out doc. A handover adds no new kind of exposure.
- **A public pull request's body can be fetched by anyone,** a brewer with a network included.
- **A person who quotes a line** in an issue or a comment has made it part of an order. That is a person's decision.

### What is not here
- **Sorting, an accepted rule and the real-order comparison are #908.** "Added context" is dropped from the issue's list of sorts: no such place exists today, and a maintainer's comment reaches one order only.
- **Nothing here claims an effect.** No line can yet change what a later batch does.

## Consequences
- **A Brewery needs nothing:** the field is optional. A Brewery with its own brewer files keeps them and writes no handover until it adds these lines:

  ```markdown
  ## Your handover

  Your out doc's frontmatter may add the key `handover`, at most 3 lines, each at most 300 characters: what surprised you, what cost you time, or what you would tell the next brewer who works here. Leave it out when nothing did. A person reads it; no later brewer does, so put nothing there this batch needs.
  ```

- **An older Foedrum cannot read** a `step.finished` that has `handover`, nor an out doc that has it. Update every driver of a Brewery together.
- **`schemas/event.json` and the out doc schemas gain the field.** Earlier events and out docs stay valid.
- **A changed default brewer** is tried by the maintainer on real issues after the merge; the tests use the fake runner.

## Alternatives considered
- **A line in the out doc contract:** one change where this is eight, but it would reach a Brewery's own brewers, whose files the issue says keep their behaviour until they add the lines, and every prompt's contract has a size limit.
- **Keep it in `output`, and strip it from each reader:** a list of readers to keep whole, and the next reader of `output` would pass it on with no error.
- **Fail an out doc whose handover breaks its limit, as `dispositions` do:** a retry for a note would redo the run.
- **The lines in the status comment:** a person sees them without a command, but the comment can come back into an order under an earlier login.
- **Refuse any out doc without a frontmatter on a later prompt's path:** there is no field in one to hide, so refusing it would guard nothing.
