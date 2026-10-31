# The test map

> **Partly built.** The map's file, its schema, where it is kept, the effective map, the Stuck reason for a module no confirmed line reaches (#706) and the uncovered-line check (#710) are built.
> Discovery and freshness (#708), the red proof that reads the map (#709), a skip the batch added failing the green check, and `testsUnchanged` (#711) are not: until they land, the red proof works as [the red proof](red-proof.md) says.

A target repository's test map says, for each module, where its code is, where its tests live, and where its test and coverage reports are written ([ADR 0274](../../adr/0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)).
It says where things are and holds no commands: the commands stay in `foedrum.jsonc`, confirmed by a person ([ADR 0023](../../adr/0023-language-independent-recipes.md)).

**The file.** `.foedrum/test-map.jsonc` in the target repository, beside `.foedrum/house-yeast/`, versioned with the code and shared by every Brewery on the repository ([ADR 0018](../../adr/0018-house-yeast-layers.md)).
Its JSON Schema is `schemas/test-map.json`.
`derivedFrom` holds the manifest globs the map was derived from and the paths they matched then.
Each of `modules` has a `name`, its `code` globs, its `tests` (separate `paths` globs, test `projects` by folder, or `inline: true`), its `testReport` (`tap`, `junit` or `trx`, and a file or folder pattern) and its `coverage` (`lcov` or `cobertura` with a path, or `"none"`).
A glob is a path relative to the repository with `/` between folders, read as a sensitive path is; a report path is a file or a folder pattern of at most 256 characters with `*` inside a folder's name as its only wildcard, never `**`, matched without a regular expression, so a batch's map cannot make the match run long.
Every object is closed, so a map that holds a key the schema does not name, such as a `command`, is refused.

**Reading it.** The map is read at a commit of the repository's clone, as committed: `git ls-tree` finds its entry and `git cat-file` reads its blob, at most 1 MiB and 10 s per read.
A map that does not parse, that is a link or a folder, or that git cannot read is read as a reason, never as no map.
The map is repository content, so untrusted input ([ADR 0041](../../adr/0041-untrusted-input-in-per-prompt-nonce-tags.md)).

**The Brewery fallback.** A repository whose owners refuse the file sets `"testMap": "brewery"` in its `foedrum.jsonc` entry (default `"repo"`), and the map is the Brewery's `test-maps/<owner>/<name>.jsonc`, in lower case, read when serve starts.
The Brewery's map is the same at every commit, so a batch can neither add to it nor change it.

**The base's map governs.** The effective map of a step lists the base's modules as the base lists them, then the modules only the batch's map adds.
A module the base lists keeps the base's entry, whatever the batch's map says of it: the batch cannot narrow or remove it, nor set `coverage: none` on it, until a person merges the map.
A path in both a base module's area and an added one's is read by the base's module, and within a module a test area before the code area.
A base module drops out only when the batch deletes every file the base had under its code and test areas, so a deleted project is not read as a module that wrote no report.
Paths are compared in git's case, folding case only where the worktree's file system does not tell case apart.

**Report paths.** A report path or folder pattern is looked for in the worktree segment by segment, each match by its real path; one that leads out of the worktree, or a pattern that matches more than 64 paths, is refused, and when the unreached rule below looks for a module's report that makes the batch Stuck (`environment`), naming why.

**A module no confirmed line reaches.** After a check step's `test` check ran and exited 0, in a red proof or any other check step, the map is read at the base, the base the batch merged before its last check or else where its change starts ([ADR 0164](../../adr/0164-a-batch-merges-its-base-before-its-last-check.md)), and at the step's tip; a module that only the batch's map lists and whose report path holds no report makes the batch Stuck (`environment`).
A run that failed, or did not exit, keeps its own ending: a red proof's verdict stands and a failed check takes its `onFail` route, since a line that runs several suites may stop before a module it reaches ([ADR 0280](../../adr/0280-a-new-module-is-judged-unreached-only-on-a-passing-test-run.md)).
A module no line reaches is caught at the next passing run, such as Nip's `green`.
The reason names the module and the report path, says to make the repository's `"checks"."test"` line in `foedrum.jsonc` also run the module's tests, whatever the tests before them give, and carries the end of the test check's recorded output, cut and read for secrets as every reading's is.
A module the base's map lists is taken as reached, as the base is taken as green.
A base map that cannot be read makes the batch Stuck (`environment`); a batch's map that cannot be read fails the step without a retry, so its `onFail` route sends the batch back to the brewer that broke it.

**Uncovered changed lines.** After a check step's `test` check exited 0, in a step that is not a red proof (Nip's `green`), the lines the batch's change added, from where it starts to the step's tip (`git diff`, so a Refactor's changed lines count and its deleted ones do not), are judged against the union of the coverage reports of every module of the effective map that has a coverage tool (`checks/uncovered.ts`, [ADR 0274](../../adr/0274-the-red-proof-reads-line-coverage-of-the-change-and-a-test-map-not-test-names.md)).
Before the `test` check runs, every coverage report path either map names is cleared, so a report an earlier run left neither stands for this run's nor adds its hits to it.
A line is judged only where a report lists it as executable (LCOV `DA`, Cobertura `line`): it must have run, and where the report has branch data for it (LCOV `BRDA`, coverlet's `condition-coverage`), every branch on it must have been taken.
A changed line in a test area is not judged.
A changed file in a code area that no report holds counts as every changed line at 0 hits for a module whose coverage is Cobertura, whose tools list the files they did not load; for LCOV, whose Node writer leaves them out, it is listed as not loaded by any test and does not fail, so a types-only file no test could run passes.
A changed file outside every code and test area (data, docs, config) is listed and never fails, and a module with `coverage: none` is skipped and listed as not measured.
An uncovered line fails the step without a retry, along its `onFail` route (Nip's `green` → `implement`), with the reason `<n> changed lines no test runs: <file>:<line>, …`, ten lines at most and `and <k> more`, a line whose only untaken part is a branch marked `(branch not taken)`; the Cellarman's next attempt gets the reason ([ADR 0128](../../adr/0128-an-attempt-a-route-schedules-gets-what-sent-it-back.md)) and adds a test that runs the line, or removes the line, and a Refactor over uncovered behaviour fails the same way until a regression test that pins it comes first (#645).
A module's coverage report that cannot be read fails the step the same way.
The lists of what was not measured, ten files of each kind and a count of the rest, are recorded on the step's `step.finished` (`coverage`) and shown in the status comment under the step's line.
Merged reports keep a line's higher branch count, not the union of the branches, as [the red proof](red-proof.md)'s readers say.

**It is a sensitive path.** A change to `.foedrum/test-map.jsonc` gets the status comment's sensitive-path line without the repository naming it in `sensitivePaths` ([ADR 0201](../../adr/0201-a-repository-names-its-sensitive-paths-and-a-batch-that-touches-one-says-so.md)), and the line after it names each module the batch's map adds with `coverage: none`.
A repository whose map the Brewery keeps has no such file to name.
