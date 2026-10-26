# Brewers and recipes

A **brewer** is a reusable agent role.
A **recipe** puts brewers, checks and actions in order, with loops.
Brewers are defined first; recipes compose them.

| Page | What it covers |
|---|---|
| [Brewers](brewers.md) | The brewer file: fields, guards, prompt assembly, an example |
| [The out doc contract](out-doc.md) | How a brewer reports its outcome, and how the engine routes it |
| [Recipes](recipes.md) | The recipe file: steps, kinds, fields, loading |
| [Tasting](tasting.md) | Lenses, parallel groups, Brett |
| [Fining](fining.md) | The Finer: simplifying the change before the checks and reviews |
| [The openPullRequest action](open-pull-request.md) | The push and the pull request |
| [Interactive steps](interactive-steps.md) | A brewer step that runs as a person's session |
| [How a brewer runs](how-a-brewer-runs.md) | The `claude` command line, the stream, how an attempt ends |
| [A session on another machine](sessions-elsewhere.md) | Why a brewer's session is not carried, and what to do instead |
| [Defaults](defaults.md) | Default recipes and brewers |
| [Configuration files](configuration.md) | `foedrum.jsonc`, `models.jsonc`, house-yeast rules |

Check steps and the red proof: [checks](../checks/README.md).
