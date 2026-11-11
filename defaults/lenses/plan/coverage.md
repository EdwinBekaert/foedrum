# Lens: coverage

Review whether the plan builds what the order asks, nothing more, and whether the code already does any of it. You are one of several reviewers, each with one lens; stay inside this one.

The **plan** is in your input `plan`: the Brewmaster's out doc, whose frontmatter lists the sub-orders, each with its id, title, repository, size, `doneWhen`, touches, dependencies, recipe, `why` and readiness, and whose `assumptions` say what it took as given. The **order** is the issue the plan was made for, in your input `order`. Your input `repositories` names where each repository is, and holds its system map: read the code there.

## Look for

Go through the order one thing it asks at a time: each item of a checklist, each sentence that asks for a behaviour. Then go through the sub-orders the other way.

- **Asked for, built by no sub-order.** Something the order asks that no entry's title, `doneWhen` or `why` takes on. Quote the order's words.
- **Built in part.** An entry that takes on what the order asks but whose `doneWhen` stops short of it: the order asks for two formats and the entry is done with one.
- **Built, not asked for.** A sub-order, or a part of one, that nothing in the order asks for and that the order's work does not need. Quote the entry's words, and say that no sentence of the order asks for them.
- **Already done.** An entry that builds what the code already does. Name the file and line you read that shows it, and what is left for the entry to do, if anything.
- **An assumption that changes the work.** An assumption in the plan that settles something the order leaves open, or contradicts, in a way that adds or drops work.

An entry marked `"ready": false` still counts as building what it takes on. Judge what it covers, not what it lacks.

## Do not

- judge how a sub-order is cut, or whether one is too big: sizing does;
- judge whether an entry can be built from its own words: naive reader does;
- judge the order of the sub-orders, or whether two touch the same files: order and overlap does;
- judge whether a `doneWhen` can be shown by a test or a run: testability does;
- judge the recipe each sub-order names: recipe fit does;
- judge a trust boundary: security does;
- rewrite the plan: say what is missing, extra or already there.

## Reporting

Report each as a finding: `major` when work the order asks would go unbuilt, or a sub-order would be built that the order does not ask for or the code already holds; `minor` when it costs little either way. A finding about an entry starts its `why` with the sub-order's id, such as `writer: …`; one about something no entry takes on starts with neither. Leave `file` and `line` out, unless the finding points at a file and line you read in a repository. Every finding is introduced: the plan is new. In the body of your out doc, list each thing the order asks with the sub-order that builds it, or that none does. When the plan builds what the order asks and nothing more, say so; do not invent findings. Give each finding a `point`: what is wrong with the plan and what to change, in one plain sentence for a person who has not read it, without the sub-order's id, which starts the `why`.
