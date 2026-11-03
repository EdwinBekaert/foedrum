# The system map

The system map says what each repository of the Brewery publishes and which other repository of it each one depends on, so the planners (the Innkeeper, the Brewmaster and the plan Tasters) learn it from their `repositories` input instead of opening every repository on every order ([ADR 0317](../../adr/0317-the-planners-read-a-system-map-computed-from-each-repository-s-manifests-with-no-model.md)).
Foedrum computes it from manifests, with git and no model, and never writes it into a target repository.

## What it reads

- Each repository's files at its base commit, listed with `git ls-tree` in its clone; each manifest a reader matches is read with `git cat-file`, at most 64 per repository and 1 MiB each.
- One reader per ecosystem in `src/formats/`, each a `ManifestReader`: the paths it reads, and what a manifest says the repository publishes and depends on.
  The core (`src/engine/system-map.ts`) walks the list `READERS` and knows no ecosystem.
  - npm (`npm-manifest.ts`): `package.json`'s `name`, and each entry of `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies` as a version, a git URL with the ref after its `#`, or a `file:` folder, read from the manifest's own folder with `/` between its folders.
  - .NET (`dotnet-manifest.ts`): a `.csproj`, `.fsproj` or `.vbproj` file's `PackageId` (else its file name when `IsPackable` or `GeneratePackageOnBuild` is true), its `PackageReference`s and its `ProjectReference`s, and a `.sln` file's projects outside the repository.
  - Manifests under `node_modules`, `bin` and `obj` are not read.
- The repository's test map at the same commit, for its module names ([test map](../checks/test-map.md)).

Every name, version, URL and path is untrusted repository text: it is cut to one line of at most 120 characters, its control characters and line breaks made spaces and a backtick a quote, and each list to 200 items with the rest counted.
A manifest that cannot be parsed, or that git cannot read, is kept as a line saying why.

## Where it is kept, and when it is read again

- A repository's entry is a `system.mapped` event with the base commit it was read at ([events](../engine/events.md)); the fold keeps the latest per repository, and the record refuses a second one at the same commit.
- When an attempt that reads the `repositories` input is planned (its brewer names it, or its lenses review a plan, [ADR 0312](../../adr/0312-a-taster-on-a-plan-lens-step-reads-the-batch-s-latest-plan-and-ties-each-finding-to-a-sub-order.md)), each repository's base commit is resolved in its clone, and only a repository whose base moved since its entry is read again.
  No tick reads it.
- A base git cannot list, or was stopped or timed out on, is not recorded: the driver says why, and the next such attempt reads it again.

## What the planners read

Under each repository's line of the `repositories` input ([brewers](../recipes/brewers.md)) come, indented:

- its `description` from `foedrum.jsonc` ([configuration files](../recipes/configuration.md));
- its manifests, each with its ecosystem;
- each package it publishes, with its ecosystem;
- each dependency on another repository of the Brewery: a package that repository publishes in the same ecosystem, in any case, a git URL whose last two segments name it, or a project path out of the repository whose first folder is its name, with how (`by version`, `by package reference`, `by git ref`, `by git URL`, `by project reference`);
- its test map's modules;
- each manifest that could not be read, and how much the limits left out.

For example:

```text
- acme/ladderlib, base origin/main
  the greet library; tags a release on every merge
  manifests: package.json (npm)
  publishes `@demo/greet` (npm)
- acme/ladderapp, base origin/main
  manifests: package.json (npm)
  publishes `web` (npm)
  depends on `@demo/greet` from acme/ladderlib by git ref `v1.1.0` (npm)
```

A dependency on a package no repository of the Brewery publishes is recorded and not shown.
The indented lines are held to 1,500 characters; each repository's own line is always kept, and a cut ends with a line that says how many lines and characters it left out and that `foedrum doctor` shows the map whole.

## In `foedrum doctor`

`foedrum doctor` reads each repository's clone at `origin/<base>` with the same readers and prints the map whole under `System map`, each repository's line with the commit it read, or why it could not (no clone yet, no such base) ([isolation levels](../platform/isolation.md)).
It reads the clones as they are now, which may be ahead of the entry a planner read: the commit lets a person compare them.

## Not found

Links that no manifest declares, such as an HTTP call to another service, a message topic or a shared table, are not in the map.
