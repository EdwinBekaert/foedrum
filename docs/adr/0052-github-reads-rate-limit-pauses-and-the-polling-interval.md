# 0052. GitHub reads: conditional requests, rate-limit pauses and the polling interval

Date: 2026-10-16 · Status: Accepted · Amends [0008](0008-polling-intake.md) (how polling stays within the rate limit, and how often it polls) and [0050](0050-the-intake-of-target-repository-issues.md) (the GitHub `TargetTracker` and `IssueMarks` it left as follow-ups)

## Context
[ADR 0050](0050-the-intake-of-target-repository-issues.md) gave the intake two interfaces with no GitHub implementation: `TargetTracker` (the open issues of a target repository, how a pull request stands) and `IssueMarks` (the assignee, label and comments of a claimed issue). [ADR 0008](0008-polling-intake.md) says the intake polls with conditional requests "to stay well within rate limits", but not how, and #103 left two questions open that this layer has to answer:

- **The polling interval.** How often a Brewery polls its repositories.
- **The backoff on rate limits.** What a Brewery does when GitHub refuses a request for its rate limit.

GitHub's REST documentation gives the rules. A conditional request (`If-None-Match` with the ETag of the answer before) that GitHub answers 304 does not count against the primary rate limit when it is made with an `Authorization` header. The primary limit of a personal access token is 5,000 requests an hour; an answer says what is left (`x-ratelimit-remaining`) and when it resets (`x-ratelimit-reset`, epoch seconds). When a request is refused for a limit (403 or 429): wait the seconds `retry-after` names when it is there; else, when `x-ratelimit-remaining` is 0, wait until the reset; else wait at least a minute, and longer each time the secondary limit repeats. A list comes in pages, along the `Link` header's `next` relation.

The intake's pass and the driver's effects each run under a deadline below the batch lease ([ADR 0050](0050-the-intake-of-target-repository-issues.md)), so nothing in this layer may wait out a rate limit inside a call.

## Decision

### Conditional reads
- Every GET of the tracker and the marks goes through `createGitHubReads` (`src/github/reads.ts`). It keeps the last answer with an ETag of each path, sends that ETag as `If-None-Match`, and answers a 304 with the kept answer. Only a 200 with an ETag is kept; the cache holds 256 answers, least recently used out first. A 304 to a request that named no ETag fails.
- A list is read page by page along `Link: <…>; rel="next"`, each page conditional on its own, so an unchanged listing is a run of 304s. A next page that is not on the client's base URL fails the read: the token goes with every request, so it never follows a link off the API. A list of more than 50 pages (5,000 items) fails rather than reading on or stopping short in silence.

### The tracker
- `githubTargetTracker` (`src/github/tracker.ts`) lists the open issues of a repository oldest first, 100 to a page (`state=open&sort=created&direction=asc`), and maps each to a `TargetIssue`: an item with `pull_request` is a pull request, label names come as strings or objects, and an issue whose author's account was deleted has the author `''`, so it is never an allow-listed author's. The filter stays with `isCandidate`; the listing does not ask GitHub to filter by label.
- How a pull request stands comes from `GET /repos/{owner}/{repo}/pulls/{n}`, conditional too: merged when `merged` or `merged_at` says so, else its `state`. The batch records a pull request by its web URL; a URL whose path is not `/<owner>/<name>/pull/<n>` is refused before any request.

### The marks
- `githubIssueMarks` (`src/github/marks.ts`) acts as the Brewery's token, whose login it is given. Assignees and labels come from one conditional read of the issue.
- GitHub drops an assignee without access to the repository and still answers 201, so `assign` fails unless the answer lists the login. Removing a label that is not on the issue (404 "Label does not exist") counts as removed; any other 404 fails.
- `findComment` reads every page of the issue's comments and finds the first one by the Brewery's own login that carries the marker. A comment by anyone else never counts, since the keys are predictable (ADR 0033).
- Every answer is checked against the fields it uses (`src/schemas/github.ts`), and every error names the repository and the issue, never the token.

### Rate limits: the client pauses, and never waits
- `createGitHubClient` keeps one pause for the token. An answer refused for a limit (a 429, or a 403 that is used up, has a `retry-after` or says "rate limit") pauses it: for `retry-after`'s seconds when given, else until the reset of a used-up limit, else for a minute that doubles while secondary limits repeat, up to 15 minutes. An answer that is no limit starts the doubling over. An answer that used the last request (`x-ratelimit-remaining: 0`) pauses until the reset too, and is still returned.
- While paused, every request of the client, REST or GraphQL, fails at once with `GitHubRateLimited` (with its `until`) and never reaches GitHub. A pause never lasts more than an hour, whatever a header says.
- The client never sleeps. A refused effect fails and waits for the driver's next pass, as any failed effect does (ADR 0044). An intake pass reports each repository it could not read and goes on. Nothing holds off the heartbeat.

### The polling interval
- **Recommendation, decided: the intake polls every 60 seconds.** A minute is negligible next to a brewer's run (ADR 0008). An unchanged repository costs one 304 per page and pull request each minute, which does not count against the primary limit. A changed one costs one 200 per page that changed.
- **During a pause, the program skips its polls until `until`** instead of making requests that would fail at once. The program that runs the intake in the driver's tick (#145) does that, and makes the interval a setting of the Brewery there. No further backoff is needed: the pause is GitHub's own answer.

## Consequences
- The intake and the claim marks can run against GitHub. Wiring them into the program, polling the Brewery's own issues, routing and `foedrum order` are #145.
- An idle Brewery polls without spending its rate limit, and one with a busy repository spends a request only on the pages that changed.
- A token that meets its limit stops making requests until GitHub says it may, for the whole client: the claim host, the tracker and the marks share it. A limit met by another program with the same token shows up in the answers and pauses Foedrum too.
- The tests read synthetic answers in the shapes GitHub's REST documentation gives (`test/fixtures/github/`); no test reaches GitHub. The opt-in integration test of ADR 0050 covers only the claim ref.

## Alternatives considered
- **Wait out a rate limit inside the client:** simplest for callers, but a wait of up to an hour would hold an intake pass or an effect past its deadline, and with it the driver's heartbeat.
- **Retry a refused request a few times at once:** GitHub asks for the opposite; repeated requests during a secondary limit can get the token blocked.
- **Ask GitHub to filter the listing by label (`labels=`):** fewer pages for a large repository, but label names with a comma cannot be expressed, and the filter must be applied again anyway, since the listing is untrusted input. A later change can add it as an optimisation.
- **The `since` parameter instead of ETags:** fewer items per poll, but a 200 every time, which counts against the limit, and updated issues still need a full comparison.
- **Poll every 5 or 10 seconds:** faster pickup for nothing a brewer would notice, and a busier token whose secondary limits also guard against frequent requests.
