# 0317. The planners read a system map computed from each repository's manifests, with no model

Date: 2026-11-03 · Status: Accepted · Amends [0234](0234-the-brewmaster-writes-a-plan-on-the-planner-alias-and-mash-runs-it.md) and [0301](0301-a-brewery-order-s-read-only-attempt-reads-every-repository-in-a-checkout-of-each.md) (the `repositories` input carries each repository's lines of the system map under its line)

## Context
The Innkeeper, the Brewmaster and the plan Tasters read the Brewery's repositories as one line each: the name and the base (ADR 0234, ADR 0301).
Nothing said what a repository publishes or which other repository depends on it, so a planner opened every repository on every order to find the one fact a plan across two of them rests on: that the application depends on the library, and how.
A predecessor tool kept that knowledge in a file a model wrote.
It grew to about 28k tokens, and a size cap silently dropped its newest rules.
The maintainer decided on 2026-11-02 and 2026-11-03 (#765) that Foedrum computes the map instead, from the manifests at each repository's base, with npm and .NET first and Cargo and Go after (#808).

## Decision
- **Computed from manifests, never written by a model.**
  For each repository, Foedrum lists its files at its base commit with `git ls-tree` and reads each manifest a reader matches with `git cat-file`: no network, no install, no model.
  A reader is one file per ecosystem in `src/formats/` with the shape `ManifestReader`: which paths it reads, and what a manifest's text says the repository publishes and depends on.
  `npm-manifest.ts` reads `package.json`: its `name`, and each entry of its four dependency fields as a version, a git URL with the ref after its `#`, or a `file:` folder.
  `dotnet-manifest.ts` reads `.csproj`, `.fsproj` and `.vbproj` files (the `PackageId`, else the file's name unless `IsPackable` is false, and each `PackageReference` and `ProjectReference`) and `.sln` files (each project outside the repository).
  Manifests under `node_modules`, `bin` and `obj` are not read.
  The core, `src/engine/system-map.ts`, walks the list `READERS` and knows no ecosystem, so another reader is one more file and one more entry in the list.
- **A recorded entry per repository and base commit.**
  A repository's entry (what it publishes, its dependencies, its test map's module names, each manifest that could not be read, and how much the limits left out) is recorded as a `system.mapped` event with the base commit it was read at, folded to the latest entry per repository.
  The record refuses a second entry of a repository at the commit its latest one was read at, so two writers record it once.
  The map is the Brewery's state, never a file in a target repository, and a replay reads the entry the planner read.
- **Read again when the base moved.**
  When an attempt whose brewer asks for the `repositories` input is planned, the attempt plans resolve each repository's base commit in its clone, as a plan's touches check does (ADR 0233), and read the map again only of a repository whose base commit is not the one its latest entry was read at.
  No tick reads it.
  A base git cannot list is recorded with why, never left out.
- **Repository text is untrusted.**
  Every name, version, URL and path is cut to one line of at most 120 characters, its control characters and line breaks made spaces and a backtick a quote, before it is recorded, and each list to 200 items with the rest counted.
  A manifest that cannot be parsed gives a line that says so, never a silent gap.
- **A link to another repository.**
  A dependency is shown only when it names another repository of the Brewery: a package another repository publishes in the same ecosystem, a git URL whose last two segments are that repository's `owner/name`, or a project path out of the repository whose first folder is its name.
  It says how: `by version`, `by package reference`, `by git ref`, `by git URL` or `by project reference`.
- **The input and its cap.**
  Under each repository's line of the `repositories` input come its description from `foedrum.jsonc`, what it publishes, each link to another repository, its test map's modules and each manifest that could not be read.
  Those lines are held to 1,500 characters; the repositories' own lines are always kept, and a cut ends with a line that says how many lines and characters it left out, and that `foedrum doctor` shows the map whole.
  A Brewery with no manifests and no descriptions gives the lines it gave before.
- **A description per repository.**
  `foedrum.jsonc` gains an optional `description` per repository: one line of at most 200 characters, written by the person who sets the Brewery up.
- **`foedrum doctor` shows the map whole.**
  It reads each repository's clone at `origin/<base>` with the same readers, and shows each repository's line with the commit it read, or why it could not (no clone yet, no such base), followed by its lines, uncut.

## Consequences
- A planner learns from its input which repository publishes what and which depends on it, without opening them.
- The map says only what manifests declare; links through code (an HTTP call, a message topic) or history are not found (#765's research note).
- A dependency on a package no repository of the Brewery publishes is recorded and not shown.
- Doctor reads the clones at their base as they are now, which may be ahead of the entry a planner read; it names the commit so the two can be compared.
- `npm run demo -- ladder`'s scripted Brewmaster plans only when its input maps the application's dependency on the library.
