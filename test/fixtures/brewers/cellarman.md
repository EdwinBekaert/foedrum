---
// The example from docs/brewers-and-recipes.md §1.2.
{
  "name": "cellarman",
  "description": "Makes the Gauger's failing tests pass in one repository.",
  "version": 1,
  "model": "builder",
  "effort": "high",
  "inputs": [
    { "name": "order", "from": "order", "trusted": false },
    { "name": "plan", "from": "step:plan" },
    { "name": "tests", "from": "step:gauge" }
  ],
  "houseYeast": true,
  "output": { "doc": "brew-report.md", "schema": "brewReport" },
  "produces": "commits",
  "context": "repo",
  "tools": {
    "allow": ["Read", "Edit", "Write", "Grep", "Glob", "Bash(git add*)", "Bash(git commit*)", "Bash(git diff*)"],
    "deny": ["AskUserQuestion", "Bash(git push*)", "WebFetch"]
  },
  "access": "write",
  "tree": "task",
  "git": { "commit": true },
  "deadline": "30m",
  "maxTurns": 120,
  "stall": { "turns": 60, "minutes": 20 },
  "maxAttempts": 2,
  "retryMode": "fresh",
  "guards": ["requiresOutDoc", "requiresCommits", "testsNotRemoved", "testsUnchanged", "scope"],
}
---
Implement the plan in {plan} for the order below. The Gauger's failing tests in {tests}
are the specification: make them pass without changing them. If a test is wrong,
report it as a finding instead of editing it.

Done when: every plan step is done, the Gauger's tests and the full test suite pass,
and everything is committed.
