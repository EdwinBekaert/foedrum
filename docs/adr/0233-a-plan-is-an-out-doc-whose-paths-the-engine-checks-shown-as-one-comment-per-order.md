# 0233. A plan is an out doc whose paths the engine checks, shown as one comment per order

Date: 2026-10-27 · Status: Accepted · Narrows #388 (its schema, `touches` check, `alternatives` and posting items) · Amends [0154](0154-lane-labels-on-the-order-s-issue-and-the-status-comment-s-path-line.md) (the plan comment is another source of the driver's effects)

## Context
An order too big for one pull request is broken into sub-orders, one repository each ([ADR 0013](0013-single-repo-sub-orders-bottles-and-releases.md)), and the ready set starts them from `order.decomposed` ([ADR 0211](0211-the-intake-starts-ready-sub-orders-at-their-order-s-rank-once-their-blockers-merged.md), [ADR 0216](0216-a-release-blocker-is-done-once-its-repository-is-released-after-its-merge.md)).
Nothing writes or reads that breakdown: no out doc schema carries one (`attemptLimits` knows `tasting`, `pullRequest`, `fining` and `gauge`), and nothing posts one.
#373 was split into #584 to #592 (2026-10-26); this record is #585's: the plan's shape, a check of its paths, and where a person sees it.
The Brewmaster that writes a plan is #586, the lenses that review it #587, the gate that signs it off #588, and the sub-issues a signed-off plan becomes #590.

Four facts shaped it.
An out doc's frontmatter is read against its brewer's named schema, and an invalid one fails the attempt retryably with zod's reason, which names the field's path ([ADR 0005](0005-typed-step-outcomes-and-out-docs.md), [ADR 0161](0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md)).
A model can name a file that does not exist, and a plan built on it misleads every step after it; checking that needs git, not judgement, as the secret scan after a `done` does ([ADR 0187](0187-a-committing-brewer-s-attempt-is-scanned-for-secrets-when-it-ends-done.md)).
An attempt's managed clone is bare and blob-less (`--filter=blob:none`): a read that asks for a blob fetches it from the remote, and `git cat-file --batch-check` does even for `%(objectname)` (tried on git 2.56), while `git ls-tree` reads trees only.
And an effect is found by its marker on the Brewery's own comment, so a kill between an edit and its ledger entry edits once ([ADR 0033](0033-chaos-tests-effects-found-by-key-and-leases-at-start.md), [ADR 0072](0072-the-status-comment-edits-as-revisions-in-the-ledger.md)).

## Decision

### The schema
- **`plan`** (`output.schema: "plan"`), in `src/schemas/plan.ts`: `PLAN` and `PlanOutDoc`, built on `outDocFrontmatter`.
  Its fields are optional on every status and required on `done` by a refinement, as `TastingOutDoc` does, so a `needs_input` plan reads without sub-orders.
  `attemptLimits` gets one branch for it.
- **Per sub-order** (`subOrders`, 1 to 100 on `done`):
  - `id`: the plan's own name for it, lower-case letters, digits and `-`, at most 40, unique in the plan; dependencies and the graph name it, since no issue exists yet;
  - `title`: one line, what it builds (the table's row, and the sub-issue's title in #590); decided by the consultant;
  - `repo`: one of the Brewery's repositories, `owner/name`;
  - `size`: `lines`, an estimate, a positive whole number, and `mechanism`, one line; no cap in the schema, since the sizing lens and the gate judge it (#587, #588);
  - `doneWhen`: one line, a test or an observable result;
  - `touches`: 1 to 20, each a `path` as `RelativePath` reads one (relative, forward slashes, no `.` or `..`, no glob character), to a file or a folder, with `new: true` when it does not exist yet;
  - `dependencies`: each `on` another id of this plan, once, and a `kind`, `code` or `release`, as `Dependency` has them; none on itself, none twice, no cycle, at most 1,000 in the plan; `hasCycle` is exported from `src/schemas/events.ts` and reused for any key;
  - `recipe`, a recipe's name, and `why`, one line;
  - `testFirst: false` only with `testFirstOff`, the reason (#219's field); left out, the recipe's own holds;
  - `ready: true`, or `ready: false` with `refinement`, the reason it needs refining.
- **`alternatives`**, optional: `considered`, 1 to 10 other cuts, each a `cut` and `whyNot`, one line each; and `whyThis`, one line.
- **Every text has a length** (a title 120, a path 300, any other line 300), so the comment stays within GitHub's.
- **A missing or wrong field fails the attempt retryably** through `settleAttempt`'s invalid out doc, its reason naming the field's path (`subOrders.1.doneWhen`).

Rejected: a Markdown plan the engine parses (no field can be checked); recording the plan as `order.decomposed` now (sub-orders become issues only once signed off, #588 and #590); the sub-orders' issue numbers as their ids (none exist yet).

### The `touches` check
- **After `settleAttempt` gives a `succeeded` plan, in both runners**, as `scannedIfDone` scans commits: an injected read of paths at a commit in a repository's clone, with no model.
  A `repo` the Brewery does not list fails the attempt retryably, naming the sub-order and the repository.
  Every path not marked new must exist; one that does not fails the attempt retryably, naming the sub-order, the path, the repository and the commit checked (12 hex digits), at most three, with a count of the rest.
  A path marked new that already exists passes: the sub-order may replace it, and the lenses judge that (#587).
  A read that fails blocks the attempt on its environment, as an unscanned commit does.
- **The commit the plan was written against**: in the attempt's own repository, the commit its worktree started at; in another repository of the Brewery, its base (`origin/<base>`) as its clone has it, resolved to a commit when the attempt is planned. Decided by the consultant.
  A base ref the clone has is not refreshed; one it has no ref of yet, as a managed clone before any attempt in that repository fetched, is fetched once through that repository's worktree manager, one fetch at a time with its own (decided by the consultant, after the review of #607 found that every plan attempt was otherwise unstartable).
  A base that still cannot be read, or whose fetch fails, does not stop the attempt from starting: it is carried with why, and blocks the attempt on its environment only when a sub-order reads a path in that repository, naming the repository and that its base could not be fetched.
- **One git call per repository**: `git ls-tree -t --name-only -z <commit> -- <paths>`, with `GIT_LITERAL_PATHSPECS=1`, in the clone with no hook ([ADR 0137](0137-the-push-its-lookup-and-the-worktree-fetch-run-in-the-clone-again.md)): trees only, so a blob-less clone fetches nothing; a path exists when git lists it. The commit must be a full sha, every path a `RelativePath`; paths past 24,000 characters of arguments go in a second call, so the command line stays below Windows' limit. Decided by the consultant.

Rejected: the check in the fold or `decide` (they are pure and run no git); a model or a lens (#587 judges, this measures); `git cat-file --batch-check`, which reads paths from stdin with no limit on their number, but asks for each blob even for `%(objectname)` alone, so in the blob-less clone it fetches from the promisor remote, and fails when that remote cannot be reached.

### The plan comment
- **One per order**, on the order's issue (`breweryIssueOf`: a Brewery issue's own, a claimed order's Brewery issue), from the latest succeeded plan of its batch in the order its attempts started, read leniently (`planOf`, as `tastingOf` reads a Taster's).
- **Revisions through the ledger**, `[batchId, "plan.<n>"]` from 1, each recording a `StatusRevision` (the comment and the digest of its text, never the text), found by its marker at the end of its body, edited in place, made again when deleted by hand, and due only when the text's digest changed: `statusEffects`' pattern, in `src/engine/plan-comment.ts`, through the same `StatusComments` host, wired beside the status comment in `driver-wiring.ts`.
- **A later batch of the same order edits the order's comment**: its first revision's previous one is the latest revision of the order's batch before it, so an order never shows two plans. Decided by the consultant.
- **No once-a-minute limit**: a plan changes only when a plan step succeeds. Decided by the consultant.
- **Its text**: `### Foedrum · plan of batch <id>`; a table of the sub-orders (id, title, repository, size, done when, touches with the new ones marked, depends on, recipe and why, with test-first's reason when off, ready or why not); a Mermaid flowchart of their order, with each id replaced by a node id of the engine's (`s1`, `s2`, …), every label quoted as `quoted` does (exported from `pull-request.ts`), edges labelled `code` or `release` ([ADR 0180](0180-a-brewed-pull-request-quotes-its-mermaid-labels-or-leaves-the-diagram-out.md)); the `alternatives` when present; and a **Review** and a **Gate** section that say none yet, which #587 and #588 fill.
- **Every model text** is one line through `plain`, and left out for a fixed line through `withoutSecrets` when it looks like a secret ([ADR 0088](0088-out-doc-text-that-looks-like-a-secret-is-left-out-of-the-pull-request-and-the-status-comment.md)), the ids and the recipe too, whose characters can still spell a long hexadecimal key (review of #607).
  A text past GitHub's limit leaves the graph out first, with a line that says so, and is cut to whole lines below the limit, as `renderStatus` cuts, only when it is still too long.
  A cell shows at most what `plain` shows, 200 characters, with `…` where it cuts: the out doc keeps the whole text.

Rejected: a section of the status comment (it is per batch and rewritten every minute, and a plan is reviewed as a whole); a new comment each round (the issue).

### What this is not
No brewer writes a plan yet and no recipe runs one (#586); no lens reviews it (#587); nothing signs it off (#588); nothing creates sub-issues or records `order.decomposed` (#590).

## Consequences
- A brewer whose schema is `plan` has its plan read, its fields and paths checked, and shown on the order's issue as one comment edited each round.
- One ledger entry per revision; no new event, no change to the fold or the admission.
- A plan attempt runs one git call per repository it names after its `done`, a second past 24,000 characters of paths, and resolves every other repository's base when it is planned, fetching once a base its clone has no ref of.
- The cost of that fetch is one fetch per never-fetched repository of the Brewery, ever: the plan is data the runner reads, so the fetch runs when the attempt is planned, before anyone knows which repositories the plan names, and the ref exists afterwards (decided by the consultant).
- A plan naming a repository's base sees that base as the clone last fetched it, which may be behind the remote; the line names the commit, so a person can tell.
