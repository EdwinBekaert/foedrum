# 0320. The system map reads Cargo and Go manifests

Date: 2026-11-05 · Status: Accepted · Amends [0317](0317-the-planners-read-a-system-map-computed-from-each-repository-s-manifests-with-no-model.md) (two more readers in `READERS`)

## Context
ADR 0317's map read npm and .NET manifests, so a repository written in Rust or Go showed only its description and its test map's modules.
The maintainer decided on 2026-11-03 that the map reads all four in M2 (#808).
The two new readers have the shape of the first two: no change to the core beyond their entries in `READERS`, and no change to the event's schema.

## Decision
- **`cargo-manifest.ts` reads each `Cargo.toml`.**
  `[package] name` is the crate it publishes, whether or not it says `publish = false`, as npm's `name` is whatever `private` says.
  Its dependencies are the entries of `dependencies`, `dev-dependencies` and `build-dependencies`, the same three under `[target.<cfg>]`, since a link behind a cfg is still a link, and `[workspace.dependencies]`, in each of TOML's forms: `name = "1.2"`, an inline table, a dotted key and `[dependencies.name]`.
  A dependency's source is its `git` URL with its `tag`, `rev` or `branch` as the ref, else its `path` from the manifest's folder, else a package with its version; `package =` gives the crate's real name.
  `[patch]`, `[replace]` and every other table are not read.
- **A workspace's members read themselves.**
  `git ls-tree` gives every `Cargo.toml` to the reader, so `[workspace] members`, with its globs, is not read, as a `.sln` file's own projects are read from their project files.
  A member's `name = { workspace = true }` names no source and gives no dependency: the root manifest's `[workspace.dependencies]` entry gives the one link.
- **A small reader of TOML's statements, not line by line and not a general parser.**
  `src/formats/toml.ts` gives each key with its table's path and a string's text, and nothing of any other value.
  It walks every string, array and inline table, because a multi-line `description` can hold a line that reads `[dependencies]`, and a `features` array can span lines.
  It has a depth limit and refuses what is not TOML (ADR 0004: no npm package for a format).
- **What the Cargo reader refuses is a line, never a silent gap.**
  Broken TOML, a dependency that is neither a string nor a table, a `name` or a source key that is not a string, and a key of a dependency outside Cargo's reference make the manifest unreadable, with a reason that names the dependency and the key.
- **`go-manifest.ts` reads each `go.mod`, line by line.**
  `module` is what it publishes, and `require` and `replace`, on one line or in a block, are its dependencies; other directives are ignored.
  No `module` line, a malformed `require` or `replace` and an unclosed block make it unreadable.
- **A `replace` says where a required module really comes from.**
  It takes the place of the `require` it names: the one of the same version, else one that names no version; one of another version does not apply.
  One whose module no `require` names is still kept, since the manifest declares the link.
  A replacement with a version is a module: a git dependency, with the version as its ref and its path cut to its first three segments, so `github.com/acme/fork/v2` and `github.com/acme/fork/sub` name the repository `acme/fork`.
  A replacement without one is a folder, from the manifest's folder.
- **Each reader names its own folders.**
  The shared `inBuiltFolder` holds `bin` and `obj`, which are real folders in Rust and Go, and adding to it would change what npm and .NET read.
  Cargo's reader skips `node_modules` and `vendor`, and a `target` folder except for a manifest directly in it, since the map reads only committed files, and a crate at `crates/target/Cargo.toml` is real while `cargo package` writes to `target/package/<name>/Cargo.toml`.
  Go's reader skips `node_modules`, `vendor` and `testdata`, which the go tool ignores too and whose modules are fixtures.
- **The core's link and its words stay as they are.**
  A required module links by the exact name another repository publishes, a crate the same way, and both print `by version`, `by git ref` or `by project reference` as ADR 0317's readers do.
  A crate's `tag`, `rev` and `branch` all print as `by git ref`, since the schema's git dependency has one `ref`.

## Consequences
- A Brewery with Rust or Go repositories gives its planners the same lines as npm and .NET ones, and a Brewery with neither gives the text it gave before.
- A key Cargo adds to a dependency after this reference (2026-11-05) makes that manifest unreadable until the list is extended, losing its links for a while; the line names the key, so a person can see why.
  It is the price of a reader that never drops a source it does not know, and it is one line to fix.
- `require github.com/acme/lib/v2` shows no link once `acme/lib`'s `go.mod` at its base says `/v3`, because a required module links only by the exact name published.
  `github.com/owner/repo/sub` links `owner/repo` when that repository has a `go.mod` publishing it, which is what a required module path means.
- A replacement links by its path's first three segments as a git URL, never by a module another repository publishes, so one on a vanity host (`go.acme.dev/lib`) shows no link.
- `npm run demo -- ladder` prints the Brewmaster's `repositories` input in its first step.

## Alternatives considered
- **Line by line for Cargo:** about 80 lines fewer, and it would read a real manifest's multi-line text as tables and refuse a multi-line array.
- **Skipping unknown Cargo keys:** a manifest keeps its links after Cargo adds a key, but a new source key would give a dependency a wrong source with no line saying so.
- **Adding `tag`, `rev` and `branch` to the schema, to print `by git tag`:** a change to the event and the core for a word; a planner reads the ref's name either way.
