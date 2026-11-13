# 0393. `foedrum init` finds where it is and asks where the Brewery goes

Date: 2026-11-13 · Status: Accepted · Amends [0199](0199-foedrum-init-writes-a-brewery-s-files-in-its-clone.md) (init writes a Brewery's files only in a Brewery, found from any depth, or in a folder it chose) and [0207](0207-foedrum-init-creates-the-brewery-s-repository-labels-the-targets-and-pushes.md) (init asks whether and where to create a Brewery, and clones a name GitHub has after a yes instead of refusing it) and [0212](0212-foedrum-init-takes-every-answer-as-an-option-and-foedrum-init-asks-them-in-a-session.md) (three more options; a Brewery GitHub has no longer ends init, a folder that is there is refused as an answer, exit 2 for `--folder`, and after `--existing y` the clone is made before every question is answered, which a refusal names)

## Context
Before this record, init decided with one check: whether the working folder has a `.git` ([ADR 0207](0207-foedrum-init-creates-the-brewery-s-repository-labels-the-targets-and-pushes.md)).
With one, the folder was taken to be the Brewery's clone, whatever repository it was, so `npx foedrum init` in an application's repository wrote Foedrum's files there and offered to push them to that repository's `origin`.
Without one, init created a repository and cloned it into a subfolder, also inside a subfolder of another repository.
#1033 asks init to find out where it is; the maintainer settled the scope on the issue (2026-11-13).

## Decision

### Where init is
- init asks git where the working folder is: `git rev-parse --show-cdup`, which prints the repository's top as a path from that folder (`''` or `../../`), the form init's file port already takes, where `--show-toplevel` prints a full path. git's `not a git repository` means none; any other failure stops init with git's first line. init runs its git with `LC_ALL=C`, so git says that line in English whatever the machine's language.
- A repository with `foedrum.jsonc` at its top is a Brewery. Inside one, from any depth, init works on that Brewery at its top: the files it reads and writes, git's status, commit and push, and doctor. It says so, reads the Brewery's name from `foedrum.jsonc` instead of asking it (and asks it, as before, only when the file names none), and goes on as in a clone before: the targets, then each file that would change after asking.
- Inside a repository that is not a Brewery, init says that a Brewery is a repository of its own and that it writes nothing there.

### Not in a Brewery
1. `Create a Brewery? [Y/n]` (`--create y|n`). A no ends init in 0 with one line, creating nothing.
2. `Folder for the Brewery` (`--folder <path>`), a path from the working folder or a full one, a drive on its own (`D:`) read as its root. The default is `.` outside any repository and `foedrum-brewery` beside the repository's top inside one. The answer is one of:
   - **a Brewery's clone**, anywhere in it: init uses its top, reads its name, and updates it; init's own earlier clone of a Brewery is one already;
   - **the top of a repository that holds nothing but `.git`**: init's own earlier clone of an empty repository, after an end of input or a `--no-input` refusal. It is taken, and not cloned again, only when its origin is `https://github.com/<name>.git` (owner and name compared without case, as GitHub does) for the name then answered, which GitHub has and the user takes as the Brewery; any other repository there stops init in 1, so the plugin's next run goes on where the last one stopped;
   - **a folder in another repository**, or a missing one whose nearest existing folder is in one: init says why and asks again, since it never writes into another project;
   - **an existing folder in no repository**: used when empty, asked again when it holds files or is a file;
   - **a missing folder**: used; the clone creates it.

   An answer asked again is refused with exit 2 when it came as `--folder`, as ADR 0212 has for every option.
3. `Brewery repository (owner/name)` (`--brewery`), as before, with the same check of a name no folder can have on Windows.
4. A name GitHub does not have: `Private or public`, then every other question, then the repository is created and cloned into the folder, as ADR 0207 does.
5. A name GitHub has: `<name> is on GitHub already. Is it the Brewery you mean? [y/N]` (`--existing y|n`).
   - A yes clones it into the folder at once, so init reads its `foedrum.jsonc` from disk; it is the one step init takes before every question is answered, and it creates nothing on GitHub. A clone that holds `foedrum.jsonc` is updated as a Brewery; one that holds nothing but `.git` gets the files. One that holds files but no `foedrum.jsonc` stops init in 1 with one line that names it, since it is another project. A refusal or end of input after the clone names the folder it is in.
   - A no asks the name again. Given as `--brewery`, a no is refused with exit 2, since the option cannot answer twice.

### At the end
A command cannot change the folder of the terminal that started it, so when the Brewery is not the working folder init ends with `The Brewery is in the folder <folder>` and the `cd <folder>` line to type next, the folder double-quoted when it holds a space. A folder whose name holds anything else but letters, digits and `_ . / : \ -` gets no `cd` line, since a shell would read more of the line than the name; the line before names the folder.

### Options
`--create`, `--folder` and `--existing` join init's options (ADR 0212): `--no-input` refuses each when it is asked and not given, and `/foedrum:init` asks it.

### A Brewery's files
Nothing changes in the files init writes, so an existing Brewery needs no migration.

## Consequences
- `foedrum init` in an application's repository creates the Brewery beside it, not inside it, and says where.
- A clone of an empty repository is no longer a Brewery: init run in it suggests a folder beside it. To use an empty repository made by hand, answer its name and a yes to `Is it the Brewery you mean?`, from outside it.
- A first Brewery outside any repository takes two more questions, both with a default; `/foedrum:init` runs init up to three more times.
- The README's steps no longer start with a repository created by hand.

## Alternatives considered
- **Read the clone's files through GitHub's contents API before cloning,** so disk stays untouched until every question is answered: a new port and about 40 more lines for four files, while the clone of a repository that already exists creates nothing on GitHub.
- **Write the files into a cloned repository that holds files but no `foedrum.jsonc`:** that is the bug #1033 reports, an application's repository given Foedrum's files.
- **Allow a new folder inside another repository:** the Brewery would be a nested clone inside that project, shown as untracked there.
- **Keep the `.git` check and only compare the Brewery's name with `origin`:** a URL to parse in every form git takes, and it still says nothing about a subfolder.
