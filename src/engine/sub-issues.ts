// The Brewery's own issues as an order's sub-orders (#590): opened with their labels, linked under
// their order as sub-issues and to each other as "blocked by", the way GitHub records them
// (docs/design/intake/trackers.md). The target issues' `TargetTracker` stays read-only.

/**
 * A Brewery issue: its number, and the tracker's own handle for it, opaque to the engine, which a
 * link to it names it by (on GitHub, its REST id).
 */
export interface BreweryIssue {
  number: number;
  id: number;
}

/**
 * The Brewery's issues and their links, as its own identity sees and makes them. An add need not
 * be idempotent: a tracker may refuse a repeat, so a caller reads the list to tell a repeat from a
 * failure.
 * Every call stops when `signal` aborts.
 */
export interface SubIssues {
  /** The issue of the Brewery its own identity opened whose body carries `marker`, or undefined. */
  findIssue(marker: string, signal?: AbortSignal): Promise<BreweryIssue | undefined>;
  /** Opens an issue in the Brewery with `labels`. */
  openIssue(
    title: string,
    body: string,
    labels: readonly string[],
    signal?: AbortSignal,
  ): Promise<BreweryIssue>;
  /** The sub-issues of `parent`, in their order. */
  subIssues(parent: number, signal?: AbortSignal): Promise<BreweryIssue[]>;
  /** Adds the issue whose id is `childId` as a sub-issue of `parent`. */
  addSubIssue(parent: number, childId: number, signal?: AbortSignal): Promise<void>;
  /** The issues `issue` is blocked by. */
  blockedBy(issue: number, signal?: AbortSignal): Promise<BreweryIssue[]>;
  /** Records `issue` as blocked by the issue whose id is `blockerId`. */
  addBlockedBy(issue: number, blockerId: number, signal?: AbortSignal): Promise<void>;
}
