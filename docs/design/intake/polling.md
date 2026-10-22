# Polling

- **Polling intake** with conditional requests: works on a laptop with zero infrastructure ([ADR 0008](../../adr/0008-polling-intake.md)).
  ADR 0052 sets the polling interval at a minute, which `foedrum serve` applies (`pollEvery`, ADR 0068); every GET carries the ETag of the answer before, so an unchanged poll is a 304 that costs no rate limit, and a list is read along its `Link` pages, 10 items a page, so the longest bodies anyone can write never pass the answer limit.
  A target repository's listing asks GitHub for its filter's labels, and the cache keeps at most 64 MiB of answers, one list at most 32 MiB ([ADR 0068](../../adr/0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)).
  On a rate limit the GitHub client pauses as GitHub's answer says and fails every request until then, never waiting inside a call, so no intake pass or effect overruns its deadline (`createGitHubReads`, `src/github/reads.ts`; `githubTargetTracker`, `githubIssueMarks`; [ADR 0052](../../adr/0052-github-reads-rate-limit-pauses-and-the-polling-interval.md)).
