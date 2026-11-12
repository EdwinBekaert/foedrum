# 0384. The merge brief names, by fixed checks, what to look at before merging

Date: 2026-11-12 · Status: Accepted · Amends [0071](0071-the-openpullrequest-action-two-effects-of-the-batch.md) (the push's ledger result keeps what to look at before merging), [0201](0201-a-repository-names-its-sensitive-paths-and-a-batch-that-touches-one-says-so.md) (the push reads the change's files whatever the repository names, and the brief shows the sensitive paths in the new line) and [0225](0225-a-ready-pull-request-gets-a-merge-brief.md) (the brief's line under its verdict, and its Evidence no longer lists the sensitive paths)

## Context
The merge brief tells the person who merges that a pull request is ready and why ([ADR 0225](0225-a-ready-pull-request-gets-a-merge-brief.md)).
It listed the sensitive paths of the latest push under its evidence ([ADR 0201](0201-a-repository-names-its-sensitive-paths-and-a-batch-that-touches-one-says-so.md)), but only for a repository that names them, and nothing named the kinds of change a person should always look at before merging, such as a new dependency or a changed CI configuration (#992).
The maintainer decided (2026-11-11 and 2026-11-12): the brief gets one line, set by fixed engine checks and never by a model's judgement, from a new or changed dependency read from the manifests the system map reads ([ADR 0317](0317-the-planners-read-a-system-map-computed-from-each-repository-s-manifests-with-no-model.md)), a changed lock file, a changed CI file, a changed file in a `migrations` folder, and the sensitive paths; it sits under "Ready to merge", takes in the sensitive paths so they are not shown twice, is absent when nothing matches, and informs only.
A brewer's assumption that reads as a product decision is left out: only a model could tell one apart.

## Decision
- **Found once, at the push, and recorded on it** (`PushResult.look`, `src/schemas/store.ts`), as the sensitive paths are: the push effect reads the change's files from where it starts to the commit pushed (`touchedFiles`, ADR 0201) for every batch with a recorded start, whatever its repository names, and checks them with `lookOf` (`src/engine/look-before-merging.ts`).
  A failed read fails the push effect as any of its git calls does, and the driver tries it again.
- **A dependency** is a name a manifest's dependencies add, remove or give another version, git URL with its ref, or project path, from the change's start to the commit pushed, read by the system map's reader of that manifest (`READERS`, ADR 0317) from its text at each end.
  The text is read as committed, as the secret scan reads (`BranchPush.fileAt`: `git ls-tree` for the entry and its size, the path read literally and never as a pathspec, since a brewer named it, then `git cat-file blob`), up to 1 MiB.
  Only the files a reader matches count, up to 64 manifests per push, the rest counted, also when the ones read change no dependency: the line then says how many changed manifests it did not read, since they may hold one.
  A manifest absent at one end counts as one with no dependencies, so an added or deleted manifest counts by its dependencies; a change elsewhere in a manifest gives nothing.
  A manifest its reader cannot read at one end, or that git cannot give whole, is recorded with that commit and why, and nothing else is said of it.
  Each name and side is cut to one line, as the map cuts them.
- **A lock file** is named by its file name at any depth, never read: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `go.sum`, `packages.lock.json`.
- **A CI file** is one under `.github/workflows/`, `.github/actions/` or `.circleci/`, or `azure-pipelines.yml` or `Jenkinsfile` at the root: the CI systems that build a GitHub repository, the one host Foedrum pushes to.
- **A migration** is a file in a folder named `migrations`, in any case, at any depth (`inFolderNamed`).
- **The record** keeps how many of each kind and the first 50, as the sensitive paths do.
- **The line**, its own paragraph right under the brief's verdict: `**Look at before merging:**` then, joined with `; `, `a dependency changed:` with each manifest and its changes, `a lock file changed:`, `a CI file changed:`, `a migration changed:` and `sensitive paths:`, each naming ten and counting the rest; a sensitive file the line already names for another kind is not named again (`lookLine`).
  Every name is escaped with `plain`.
  The Evidence's sensitive-paths bullet goes; the status comment's line stays as ADR 0201 says.
- **Never a block.** No lane, route, label, draft mark or tasting reads it; the brief is posted and marks its pull request ready as before ([ADR 0350](0350-a-brewed-pull-request-is-a-draft-until-its-merge-brief-and-the-next-line-follows-the-brief.md)).
- **No setting.** A repository adds paths of its own with `sensitivePaths`.

## Migration
None: Foedrum has no release.

## Consequences
- The person who merges sees, at the top of the brief, every change of these kinds, found the same way on every brief.
- One `git diff` per push of a repository that names no sensitive paths, and two git calls per side of each changed manifest.
- A push recorded before this change has no `look`: its brief's line names only its sensitive paths, when it recorded any.
- Dependencies are what manifests declare: a lock file's resolved versions are not compared, only named.

## Alternatives considered
- **Compute it when the brief is written.** The brief would read git, and a later push by someone else could change what it says of Foedrum's own push (as ADR 0201 found for the sensitive paths).
- **A repository setting for more CI files.** Nothing asks for it, and `sensitivePaths` already names any path.
- **`migrations` only in lower case.** It would miss .NET's `Migrations` folder; `migrate` (Rails) and `migration` (Flyway) are not the folder the decision names.
- **Compare lock files.** Their formats are many and long; a changed lock file is named, and the manifest says which dependency moved.
