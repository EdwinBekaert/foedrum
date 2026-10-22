# Trackers and code hosts

Foedrum separates three roles that GitHub happens to play all at once in 1.0:

| Role | Interface | 1.0 | Later candidates |
|---|---|---|---|
| Where orders come from and where status is shown | `Tracker`: list orders, read comments/commands, post and edit the status comment, set state markers (labels, statuses) | GitHub Issues | Jira, Linear, GitLab Issues |
| Where code lives and pull requests are opened | `CodeHost`: clone, push, open pull request, read review comments; for now its push is `BranchPush` (git in the clone) and its pull requests `PullRequestHost` ([ADR 0071](../../adr/0071-the-openpullrequest-action-two-effects-of-the-batch.md)) | GitHub | GitLab, Bitbucket, Azure DevOps |
| Where configuration lives | the Brewery: any git repository | GitHub | any git host |

The user chooses a tracker and a code host per Brewery (`foedrum.jsonc`), and they may differ (for example Jira orders, GitHub pull requests).

**Design rule: a tracker is intake and projection only.** The event store is the source of truth; Foedrum reads orders and commands from the tracker and writes status back to it, but never synchronises workflow state two ways.
Tracker-specific concepts (issue types, workflow transitions, re-parenting, key renames) are mapped at the edge, in the adapter, and never leak into the engine.
Two-way tracker synchronisation is the most expensive part of an orchestrator to build and keep correct; this rule keeps adapters small.
The claim on a target-repository issue ([target-repository issues](../intake/target-issues.md)) is no exception: its ref is the one fact Breweries share: the engine creates it, reads only its record to tell its own claim from another's, and deletes it, and never reads workflow state back from it.
