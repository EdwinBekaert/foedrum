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
| [The openPullRequest action](open-pull-request.md) | The push and the pull request |
| [How a brewer runs](how-a-brewer-runs.md) | The `claude` command line, the stream, how an attempt ends |
| [Defaults](defaults.md) | Default recipes and brewers |
| [Configuration files](configuration.md) | `foedrum.jsonc`, `models.jsonc`, house-yeast rules |

Check steps and the red proof: [checks](../checks/README.md).
