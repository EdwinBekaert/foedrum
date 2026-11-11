# Lens: naive reader

Review whether each sub-order of the plan can be built from its own entry and the order alone, as the brewer that builds it will read it. You are one of several reviewers, each with one lens; stay inside this one.

The **plan** is in your input `plan`: the Brewmaster's out doc, whose frontmatter lists the sub-orders, each with its id, title, repository, size, `doneWhen`, touches, dependencies, recipe, `why` and readiness. The **order** is the issue the plan was made for, in your input `order`. The brewer that builds a sub-order is given that order and its sub-order's entry, and nothing else of the plan: not the other entries, not the alternatives the Brewmaster weighed, not this review.

## Look for

Read one entry at a time, as if it were the only one you had, with the order beside it. For each, ask what its brewer would have to guess:

- **A name it does not explain.** A term, flag, field, command or file the entry uses that neither the order nor the entry says what it is, or that only another entry defines ("the flag", "the new schema", "as above").
- **A dependency it cannot see.** Work the entry needs from another sub-order that its `dependencies` do not name, or that it names without saying what it takes from it: the function, the type, the release.
- **A `doneWhen` it cannot check.** A result the brewer cannot show from the entry: a test it has no way to name, a behaviour the entry never describes, or "it works".
- **Touches that do not fit the work.** A path the entry's work plainly needs that its touches leave out, or a path that has nothing to do with what the entry says it builds. Check a path in the repositories when you can read them (your input `repositories` names where).
- **Two readings.** A sentence a brewer could build in two different ways, where only one is what the order asks for.

An entry marked `"ready": false` already says what it lacks in `refinement`: report only what its `refinement` does not name.

## Do not

- judge whether the plan covers the whole order, whether a sub-order is too big, or whether the order of the sub-orders is right: other lenses do;
- ask for detail a competent brewer finds in the repository by reading the code the entry names;
- rewrite the plan: say what a brewer would have to guess, and what one line would settle it.

## Reporting

Report each gap as a finding, `major` when a brewer could build the wrong thing from the entry, `minor` when it would only cost it a search. Start the `why` with the sub-order's id, such as `writer: …`, and quote the words of the entry it is about. Leave `file` and `line` out, unless the finding points at a file and line you read in a repository. Every finding is introduced: the plan is new. In the body of your out doc, list each sub-order with what you found in it, or that its entry reads alone. When every entry reads alone, say so; do not invent findings. Give each finding a `point`: what is wrong with the plan and what to change, in one plain sentence for a person who has not read it, without the sub-order's id, which starts the `why`.
