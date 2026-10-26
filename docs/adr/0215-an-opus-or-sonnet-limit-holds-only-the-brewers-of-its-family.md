# 0215. An Opus or Sonnet limit holds only the brewers of its family

Date: 2026-10-26 · Status: Accepted · Amends [0206](0206-a-run-out-usage-window-holds-every-brewer-attempt-until-it-reopens.md) (a window per scope instead of one for every brewer)

## Context
[ADR 0206](0206-a-run-out-usage-window-holds-every-brewer-attempt-until-it-reopens.md) holds every brewer attempt while any usage window is closed, whichever of the four limits of [ADR 0091](0091-a-run-out-usage-window-blocks-on-the-environment.md) claude hit.
A session or weekly limit covers every model, but an Opus or Sonnet limit covers only its family: a brewer on Sonnet would go through while the Opus window is closed, and waits for nothing (#537).
The maintainer settled on #242 (2026-10-25) that an Opus or Sonnet limit pauses only that family.

## Decision

### Scopes
- **A usage window has a scope**: `all` for a session or weekly limit, `Opus` for an Opus limit, `Sonnet` for a Sonnet limit.
  The limit names its scope, so `usage.window_closed` keeps its fields: its `limit` is its scope.
- **A brewer attempt is held** while the `all` window is closed, or the window of its model's family.
- **Its family is read from its model** as the attempt runs it: the brewer's alias, a blind-tasting swap in `models.jsonc`'s `brewers` included, through `models.jsonc`'s `models` (`modelOf`).
  The model id or family, split into words at every character that is not a letter or a digit, is in the Opus family when one word is `opus`, in the Sonnet family when one is `sonnet` (`claude-opus-5-5`, `opus`, `opus[1m]`, `claude-sonnet-5-5`).
- **A model whose family cannot be told is held by every limit**, the safe side: one with neither word, one with both, or a brewer whose alias has no model.
- **A model of another family (Haiku, Fable) counts as one whose family cannot be told**, so an Opus or Sonnet limit holds it too.
  No documented limit says whether it counts against an Opus or Sonnet window, and a list of the other families would have to follow Anthropic's models; what it costs is a brewer on Haiku that waits for an Opus reset, as every brewer does today.
  Foedrum's defaults run on `sonnet`.

### The state
- **`State.usageWindows` holds a window per scope** while it is closed, each with its limit, claude's reset text, its reopen and `read`.
- **A later limit of the same scope** moves that scope's reopen only when its own is later, as one window does now; a limit of another scope closes its own window and leaves the others as they are.
  A weekly limit while the Opus window is closed closes `all` beside it: every brewer waits for `all`, and an Opus brewer for both.

### Old logs
- Events are never rewritten. A `usage.window_closed` from before this change folds by its `limit` into its scope, as a new one does.
- **`usage.window_opened` names the `scope` it opens**, a new optional field; without it, as #543 wrote it, it opens every closed window, as it opened the one window then.
  A `scope` that is not closed is refused, as an open with none closed is.

### Who knows an attempt's family
- **The driver** knows it: it is given each attempt's family (`family`, from the brewer and `models.jsonc` in `serve` and `brew`; none, every limit's, by default), and starts no brewer attempt a closed window holds.
- **`decide` and the supervisor** see only state, which records no attempt's family: while any window is closed, no scheduled attempt that has not started expires, whatever its family.
  A brewer of an open family starts at once, so its wait is a lease's at most, and every reopen gives it a fresh deadline.
  One that the hold kept past its deadline and that starts before a reopen is expired by the next tick, as it would have been without the window: the hold never ends it sooner.

### The reopen
- **Each scope reopens at its own reset.** When one or more windows' reopens have passed, the supervisor issues `reopen`; the engine appends `usage.window_opened` `{ at, scope }` for each of them, and then gives every waiting attempt a fresh deadline, as ADR 0206 does.
  Every reopen reschedules, also while another window stays closed: an attempt of the reopened family starts now and keeps the deadline it was scheduled with, which the hold may have outlasted.
- An attempt still held by the window that stays closed gets a fresh deadline again at that window's reopen.

### Where it shows
- **The status comment** of a brewing batch and **`foedrum status`** show a line for each closed window, `all` first, then Opus, then Sonnet.
  The `all` window keeps ADR 0206's line; a family's names it: `Opus usage window closed: claude hit its Opus limit, which resets <resets>; brewers on Opus wait until <hh:mm> UTC, <day month>`.
- **`foedrum replay`** lists the window events since every window was last open before the batch was ordered.

## Consequences
- With an Opus limit hit, a Sonnet brewer still starts, and `foedrum status` says only the Opus window is closed.
- A brewer on a model Foedrum cannot place still waits for every limit, as under ADR 0206: an Opus limit also holds a Haiku brewer, and `foedrum status` then shows only the Opus window closed while that brewer waits.
- `openDriver` gains a `family` option; `serve` and `brew` give it from the brewer's model; `decide`'s `reopen` stays one command.
- A log of #543 still folds and reopens.
- Chaos case: a driver killed while one family's window is closed; after the restart that family's brewers wait for the reopen, the other family's start, and every batch goes on to on tap.

## Alternatives considered
- **Keep one window for every limit.** The safe side, but a Sonnet brewer waits hours for an Opus reset that does not concern it.
- **Tell Haiku and Fable apart as families no Opus or Sonnet limit holds.** A brewer on them would go on, but on a guess that no limit counts them, and with a list of families to keep current.
- **A `scope` field on `usage.window_closed`.** The limit already names it; a second field could disagree with it.
- **Record each attempt's family where it is scheduled, so `decide` and the supervisor hold only that family's.** Every `step.scheduled` would carry a model fact the engine otherwise never needs, and it could go stale when `models.jsonc` changes before the attempt starts; an attempt of the open family starts at once anyway.
- **A `reopen` command per scope.** The supervisor finds them due at once; one command that opens each due window and reschedules once appends fewer events.
- **Reschedule only when the last window opens.** An attempt of the family that reopened would start with the deadline the hold outlasted, and go Stuck at once.
