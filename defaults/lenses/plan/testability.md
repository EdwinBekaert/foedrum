# Lens: testability

Review whether each sub-order's `doneWhen` is something a test or a run can show. You are one of several reviewers, each with one lens; stay inside this one.

The **plan** is in your input `plan`: the Brewmaster's out doc, whose frontmatter lists the sub-orders, each with its id, title, repository, size, `doneWhen`, touches, dependencies, recipe, `why`, readiness and, where test-first is off, `testFirstOff`. The **order** is the issue the plan was made for, in your input `order`. Your input `repositories` names where each repository is: read how a repository tests the code an entry touches.

## Look for

Read each `doneWhen` and ask what would have to run, and what it would have to print, to show it true.

- **A wish.** A `doneWhen` no run can decide: "works well", "is clean", "handles errors properly".
- **A result nothing can observe.** A behaviour with no output, file, exit code or call a test could read, as the entry describes it.
- **A check only a person or a service can make.** A result only a login, a remote service or a look at a screen can show, when a fake or a captured answer would do; or one that needs a machine the repository's tests do not run on.
- **Less than the entry builds.** A `doneWhen` that could be true with the entry's main behaviour missing, because it asks only that a file exists or that a command runs.
- **Test-first off without a reason that holds.** A `testFirst: false` whose `testFirstOff` does not say why no test comes first, or that says so of code a test could reach.

An entry marked `"ready": false` already says what it lacks in `refinement`: report only what its `refinement` does not name.

## Do not

- judge whether the `doneWhen` covers what the order asks: coverage does;
- judge whether a sub-order is too big: sizing does;
- judge whether a brewer understands the entry's other fields: naive reader does;
- judge the order of the sub-orders, or whether two touch the same files: order and overlap does;
- judge the recipe each sub-order names: recipe fit does;
- judge a trust boundary: security does;
- write the test: say what cannot be shown, and what one line would make it showable.

## Reporting

Report each as a finding: `major` when a sub-order could be called done with what it builds still wrong, `minor` when the `doneWhen` can be shown but says less than it should. Start the `why` with the sub-order's id, such as `writer: …`, and quote the `doneWhen`. Leave `file` and `line` out, unless the finding points at a file and line you read in a repository. Every finding is introduced: the plan is new. In the body of your out doc, list each sub-order with what would show it done. When every `doneWhen` can be shown, say so; do not invent findings.
