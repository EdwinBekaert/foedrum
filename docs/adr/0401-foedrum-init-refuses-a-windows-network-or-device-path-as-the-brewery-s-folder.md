# 0401. `foedrum init` refuses a Windows network or device path as the Brewery's folder

Date: 2026-11-14 · Status: Accepted · Amends [0393](0393-foedrum-init-finds-where-it-is-and-asks-where-the-brewery-goes.md) (a folder answer that is a network or device path on Windows is asked again)

## Context
init's folder question ([ADR 0393](0393-foedrum-init-finds-where-it-is-and-asks-where-the-brewery-goes.md)) reads an answer on Windows with `\` turned into `/`, then through `path.posix`.
`posix.normalize` folds the two slashes that start a network path into one, so `\\server\share\brewery` became `/server/share/brewery`: a folder at the root of the drive init runs on.
init then walked up to that root, found no repository and cloned the Brewery there, not on the share the user typed (#1049, found by the cross-platform lens in the review of #1048).
A device path (`\\?\C:\x`, `\\.\x`) starts with the same two characters and went the same way.

## Decision
- On Windows, a folder answer that starts with two slashes, typed with `\` or `/`, is refused with one line: `<answer> is a network or device path; these are not supported: give a folder on a drive`.
- The refusal comes before anything else reads the answer, so no git runs in it and nothing is created.
- As every folder answer that does not pass (ADR 0393), it is asked again when typed and ends init in 2 when it came as `--folder`.
- On macOS and Linux nothing changes: `//x` is read as `/x`, as the system reads it, and a `\` is part of a name.

### A Brewery's files
Nothing a Brewery holds changes, so an existing Brewery needs no migration.

## Consequences
- A Brewery's clone on Windows is on a drive: a mapped network drive (`Z:`) is still taken, as any drive is.
- The line in ADR 0393 that a network path is not read as one yet is answered by this record.

## Alternatives considered
- **Take the network path,** through the files and git ports: `//server/share` kept through `folderPath`, the walk up to the nearest folder stopped at the share's root as at a drive's, and the `cd` line, about 25 more lines.
  A Brewery there would still meet three walls, each not checked in this change:
  cmd.exe cannot use a network path as its working folder and starts in the Windows folder instead;
  npm runs a package's scripts through cmd.exe, as Foedrum runs a Brewery's check lines on Windows ([ADR 0069](0069-check-steps-run-the-repositorys-commands-in-an-attempt-of-their-own.md));
  and git for Windows refuses a repository on a share another account owns ("dubious ownership") until `safe.directory` names it.
- **Read the answer with `path.win32` on Windows,** which keeps the two slashes: it would change how every Windows answer is read, which ADR 0393 settled, to take paths the three walls above make unusable.
