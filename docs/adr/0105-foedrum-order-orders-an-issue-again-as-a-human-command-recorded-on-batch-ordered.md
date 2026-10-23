# 0105. `foedrum order` orders an issue again, as a human command recorded on `batch.ordered`

Date: 2026-10-21 · Status: Accepted · Amends [0019](0019-interactive-sessions-and-one-command-layer.md) (the commands), [0025](0025-batch-lifecycle-stuck-reminders-and-rewind.md) (the human commands `decide` takes), [0030](0030-only-commands-that-change-state-are-recorded.md) (how an order by hand is recorded), [0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md) (ordering again), [0050](0050-the-intake-of-target-repository-issues.md) (`foedrum order`) and [0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md) (the terminal reads `foedrum.jsonc`) · Amended by [0125](0125-the-foedrum-plugin-is-markdown-skills-that-run-the-terminal-with-via-plugin.md)

## Context
The intake never orders an issue again once it has a batch in any lane: a cancelled batch, or one whose pull request was closed, stays ended, and "a human orders it again" ([ADR 0043](0043-target-repository-issues-as-a-work-queue-claimed-by-a-ref.md), [ADR 0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)). [ADR 0050](0050-the-intake-of-target-repository-issues.md) named the command, `foedrum order <alias>#<n>`, and the batch id it orders, `<alias>-<n>-<k>`. #186 builds it, and left these questions:

- **When it is refused.** An issue with a live batch must not get a second one. A target issue's claim is the subtler case: once its batch ends, the release is due as the driver's effects, and the last of them deletes the claim ref when its record names this Brewery. A new claim made before that release runs names this Brewery too, so the old batch's release would delete it, and remove the new batch's label after the new marks were made.
- **Who ordered.** Every command that changes state is recorded by events that carry who issued it and from where (`by`, `via`, [ADR 0030](0030-only-commands-that-change-state-are-recorded.md)). `batch.ordered` has neither, since only the engine ordered until now. The issue asked for a human `order` command in `decide`, or a field on the event.
- **What the terminal needs.** No command read `foedrum.jsonc` or reached GitHub yet; claiming does both. GitHub is reached only through `gh`'s own login ([ADR 0073](0073-github-only-through-gh-s-own-login.md)).

## Decision

### The command
- **`foedrum order <issue>`** is a command of the registry that changes state (`OrderCommand`, `src/schemas/commands.ts`). `<issue>` is `<alias>#<n>`, an issue of the repository of `foedrum.jsonc` with that alias, or `#<n>` for a Brewery issue. `#` starts a comment in bash and PowerShell, so a Brewery issue may also be given as `<n>`; an alias always needs its `#`. Anything else is a mistake of the command line (exit 2).
- The alias must name a repository **with an intake**. Without one, `serve` would neither mark nor release the claim, nor route the batch by its label. `foedrum.jsonc` must name the Brewery (`brewery`), which the claim records. A Brewery issue is never claimed, so it needs neither the file nor GitHub.
- The command reads nothing of the issue itself (open, author, labels): whoever runs the terminal may issue it ([ADR 0019](0019-interactive-sessions-and-one-command-layer.md)'s authorisation). A surface for GitHub comments will check its allow-list first, as for every command.
- It may also order an issue that never had a batch, as `<alias>-<n>` or `<n>-1`. The intake then finds the issue brewed and leaves it alone.

### When it is refused
`decide` refuses the order (`orderRefusal`, `src/engine/decide.ts`), with one line that names the batch:
- while a batch of the issue is **live**: Ordered, Brewing, Conditioning or Stuck (`batch web-7 of acme/web#7 is still stuck`). A Brewery issue on tap can be ordered again: it holds no claim, and a person decides;
- while a target issue's last **claim is held**: its batch is on tap and a pull request of it has no recorded end;
- while that claim is **being released**: its release is due and the ledger does not yet have every effect of it (`release.label`, `release.comment`, `release.ref`). `serve` applies them, then the issue can be ordered again. `claimStanding` (`src/engine/issue-claims.ts`) says which of `held`, `releasing` and `released` a batch's claim is, from the recorded events alone, as `claimEffectsDue` decides what is due;
- when the Brewery issue is a **sub-order**: its decomposition orders it ([ADR 0013](0013-single-repo-sub-orders-bottles-and-releases.md)).

### A target issue is claimed again first
- The terminal opens the store, checks `orderRefusal` against it, and only then claims the issue through `claimIssue`, so a refused order claims nothing. A claim **won** or found as **ours** is ordered; a claim **taken** is refused with its holder (`acme/web#7 is claimed by other/brewery`, or `by a ref whose record cannot be read`).
- The batch is `targetBatchId`'s next id, `<alias>-<n>-<k>`, from the store as it is after the claim; a Brewery issue's is `nextBatchId`'s, `<n>-<k>`. The order is issued through the command log, so `decide` checks the refusals again against the latest events in the transaction that appends it ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)).
- The claim marks of the new batch are `serve`'s, as for every claimed batch: the driver's effects, with keys of the new batch id ([ADR 0050](0050-the-intake-of-target-repository-issues.md)). The batch is Ordered with its routing deadline; the intake routes it by its `recipe:` label when it reads the issue, and otherwise it goes Stuck on routing after the hour of [ADR 0032](0032-routing-deadline-for-ordered-batches.md).
- If the order is refused after the claim was won (another order landed in between), or the terminal is stopped there, the ref names this Brewery and nothing orders it: the intake finds the issue brewed. Running `foedrum order` again finds the claim as ours and orders it.

### Who ordered: a human command in `decide`, recorded on `batch.ordered`
Both, since they answer different questions:
- **`batch.ordered` gains optional `by` and `via`**, set together when a person ordered the batch and absent when the engine did (the intake, a decomposition). That is how the order is recorded, as for every command that changes state ([ADR 0030](0030-only-commands-that-change-state-are-recorded.md)); `foedrum replay` shows them with the event. Logs written before stay valid.
- **`decide` gains the human command `order_again`**, beside the engine's `order`. It is where the refusals above are decided, against the latest events inside the command log's transaction, as for `retry`, `cancel` and the rest. A field alone would have left the check to the terminal, before the transaction, racing the Cellar.
- **The engine's `order` of a target issue is refused the same way.** The intake reads which issues are brewed, then waits on GitHub for each claim before it orders, so a `foedrum order` of the same issue can land in between; without the check the issue would get two live batches. The engine's order of a Brewery issue is not checked: the intake's check and its order run with no wait between them, and the generated runs of the property and chaos tests order a live Brewery issue again on purpose, to keep the fold's handling of several batches of one issue covered.

### `foedrum.jsonc` and GitHub in the terminal
`CliContext` gains `config()`, `foedrum.jsonc` read against its schema (`readBreweryConfig`, one line when it is missing or does not pass), and `claims(config)`, the claim host over `gh api` on the host its `githubApi` names (`githubClaimHost`, `githubHostname`, [ADR 0073](0073-github-only-through-gh-s-own-login.md)). Only `order` of a target issue calls them. The claim needs the Brewery's name, not `gh`'s login, so the command reads no login (`GET /user`).

## Consequences
- A person can brew an issue again after a cancel, a closed pull request or a merge, from the terminal; the plugin and the comment surface will issue the same command when they come, and the event records which surface it came from.
- A cancelled target issue can be ordered again only after `serve` has applied its release. Without a running `serve` the release never runs, and the command says so; `serve` is also what marks the new claim, so ordering earlier would not get the batch brewed sooner.
- `batch.ordered` has two optional fields, and the generated JSON Schema (`schemas/event.json`) shows them.
- The terminal now reads `foedrum.jsonc` for one command, which ADR 0068 waited for before making the routing interval a setting; that interval stays as it is.

## Alternatives considered
- **Only a field on `batch.ordered`, through the engine's `order`:** one command fewer, but the refusals would be checked by the terminal outside the command log's transaction, and the engine's commands would carry a human's name.
- **A new event, `batch.reordered`:** a second event for one fact, which the fold, the state branch and replay would each have to learn, while `batch.ordered` already starts every batch.
- **Release the old claim in the command:** the release is the driver's effects through the ledger under the batch's lease ([ADR 0044](0044-batch-leases-held-by-the-driver-and-one-command-log.md)); a terminal command applying them would be a second writer of effects.
- **Refuse a Brewery issue on tap too:** it holds no claim, and a person ordering it again means it.
- **Check every engine order:** closes the same race for Brewery issues, where it does not arise, and changes what the chaos runs explore.
- **Name the repository instead of its alias (`owner/name#<n>`):** ADR 0050 chose the alias for `foedrum order`, as the batch ids use it.
