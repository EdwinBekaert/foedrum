# 0142. A macOS check may stat the folders above its worktree in the home folder

Date: 2026-10-22 · Status: Accepted · Amends [0076](0076-check-steps-run-in-an-os-sandbox-with-no-network.md) (what a check can still read on macOS)

## Context
ADR 0076's macOS profile denies `file-read*` in the home folder and allows it again for the worktree and its repository. `file-read*` covers metadata too. node resolves a module's path with `realpathSync`, which calls `lstat` on each folder above the file. So when the worktree is under the home folder, as Foedrum's default work root is, node fails before it runs a test: `EPERM: operation not permitted, lstat '/Users/runner'` (main CI run 39791052897, macOS, #376). Linux is not affected: bwrap mounts an empty home folder and binds the worktree over it, so the folders above the worktree exist in the sandbox.

The profile language, read for this ADR on 2026-10-22 (Apple publishes no manual for it; see ADR 0076):

- [Trail of Bits' Seatbelt guide](https://mintlify.wiki/trailofbits/skills/plugins/seatbelt-sandboxer): `file-read-metadata` covers "stat, lstat, readdir (no contents)" and "doesn't expose file contents", while `file-read-data` covers "Read file contents". Its example profile allows `file-read-metadata` everywhere because path resolution needs it.
- [North Pole Security's sandbox rules](https://northpole.security/docs/workshop/rules/sandbox-rules): `(literal "/path")` matches "Exactly that path", `(subpath "/path")` matches "That directory and everything beneath it", and "Last match wins".

## Decision
- On macOS, `seatbeltArgs` passes each folder from the home folder down to the worktree, and down to the worktree's repository, as a parameter `PARENT_<n>`. These are real paths, each passed once, with the home folder first. A worktree outside the home folder gets none.
- `seatbeltProfile(n)` adds one rule after the deny of the home folder: `(allow file-read-metadata (literal (param "PARENT_0")) …)`. It uses `literal`, not `subpath`, so it covers only those folders and nothing inside them. With no parents the profile is the same as ADR 0076's.
- `file-read-data` in the home folder stays denied. A check cannot read a file there, other than in its worktree and repository. The integration test checks that the planted file stays unreadable and that the home folder can't be listed. The guide lists `readdir` under metadata. If that holds for a literal folder, `ls ~` would list the home folder, so the macOS leg of that test is what settles it.

## Consequences
- ADR 0076's "What a check can still read" gains, on macOS: the metadata (existence, owner, mode, times) of the folders between the home folder and the worktree or its repository. Their names are already in the parameters and the worktree path, so the check learns nothing new about the home folder's other files.
- Checks that load node (and any other tool that resolves real paths) run in a worktree inside the home folder.
- The profile is no longer a constant. It is built for the number of parents, and every path still reaches it only as a `-D` parameter.
