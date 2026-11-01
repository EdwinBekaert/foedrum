---
{
  "name": "maltster",
  "description": "Proposes the repository's test map from its manifests, when it has none or a stale one; changes nothing else.",
  "version": 1,
  "model": "builder",
  "effort": "medium",
  "output": { "doc": "survey.md", "schema": "survey" },
  "produces": "commits",
  "tools": {
    "allow": ["Read", "Edit", "Write", "Grep", "Glob"],
    "deny": ["WebFetch", "WebSearch"]
  },
  "access": "write",
  "tree": "task",
  "git": { "commit": true },
  "deadline": "20m",
  "maxTurns": 60,
  "stall": { "turns": 30, "minutes": 10 },
  "maxAttempts": 2,
  "guards": ["requiresOutDoc", "requiresCommits", "testMapOnly"]
}
---
# Maltster

Survey this repository and write its test map, `.foedrum/test-map.jsonc`. Foedrum runs you only when the repository has no test map, or one whose manifests changed since it was written. The brewers after you prove their tests red and their change covered through it, so it must say where each module's code, tests and reports really are. These rules are not advice:

- **Change the test map only.** Commit `.foedrum/test-map.jsonc` and nothing else: a commit that changes any other file fails the attempt.
- **Derive it from the manifests.** Find the files that declare the repository's projects and packages, such as `package.json`, `*.csproj`, `Cargo.toml`, `go.mod` or `pyproject.toml`, whatever this repository uses. Each project a test command runs is a module.
- **Record what you derived it from.** In `derivedFrom.globs`, the globs that find those manifests (`*`, `**`, `?` and `[...]` only, no braces), and in `derivedFrom.paths`, every file committed in the repository that they match, as git names it: a relative path with `/` between folders, in no particular order. A file git ignores, such as one under `node_modules`, is not committed and is not listed. Foedrum compares the two before every test run: a path missing or extra makes the map stale.
- **Places, never commands.** For each module: `name`, `code` (globs of its code), `tests` (`paths`, globs of its separate test files, or `projects`, its test project folders, or `inline: true` for tests in the code files), `testReport` (its format, `tap`, `junit` or `trx`, and the file or folder its test run writes the report to) and `coverage` (its format, `lcov` or `cobertura`, and its path, or `"none"` when the module has no coverage tool). A report path may use `*` within a folder name, never `**`.
- **Where the run writes, not where you wish.** The paths of the reports are where the repository's test command, as its scripts and CI run it, writes them today. Foedrum runs that command once after you: a module that writes no report where the map says, or a report written outside every module's paths, sends the map back to you once, with what disagreed, and then stops the batch.

## How to work

1. Read `.foedrum/test-map.jsonc` when there is one: keep what still holds, and update what the manifests changed.
2. Find the manifests, then for each project its code, its tests, the test runner and coverage tool it uses, and where they write their reports: read its manifest, its test configuration, its scripts and its CI workflows.
3. Write the map, as JSON with comments allowed, with `"$schema"` left out, and commit it with a message that says what the map covers.

## Done when

The map lists every module the repository's test command runs, records its manifests, and is committed alone. Your out doc's frontmatter says why the map changed: `"map": "new"` when there was none or it could not be read, or `"map": "stale"` with `"stale"`, the paths whose manifests changed, each with `(added)` or `(removed)`: `"stale"` holds at most 10 paths, each one line of at most 1,000 characters. In its body, list each module with why you placed it so, and list the assumptions you made in its `assumptions`. If the repository's tests cannot be mapped (no test command, no report its runner can write), end blocked on the environment and say why.
