# 0207. `foedrum init` creates the Brewery's repository, labels the targets and pushes the files

Date: 2026-10-26 · Status: Accepted · Amends [0199](0199-foedrum-init-writes-a-brewery-s-files-in-its-clone.md) (init runs outside a clone too, and ends with the labels and a push)

## Context
[ADR 0199](0199-foedrum-init-writes-a-brewery-s-files-in-its-clone.md) has `foedrum init` write a Brewery's files in an existing clone and run `foedrum doctor`. The user still creates the repository on GitHub, clones it, creates the intake label ([ADR 0068](0068-the-intake-in-foedrum-serve-brewery-orders-and-routing-by-label.md)) in each target repository, and commits and pushes the files. The maintainer settled the questions and their defaults on #404 (2026-10-25): the Brewery's name defaults to `<login>/foedrum-brewery` and the repository is private by default; the intake label is created in each target repository after asking once per repository, with a description, and a no prints the one gh command to run later. #512 is that part; the `foedrum` shim on the PATH is #529, and `/foedrum:init` is #530.

## Decision

### Outside a clone, init creates the repository and clones it
- In a folder without `.git`, init no longer refuses. It asks the Brewery's name (`owner/name`, default `<login>/foedrum-brewery`, the login gh uses), then `Private or public`, default private.
- A name GitHub already has is refused with one line, which says to run init in its clone: init creates a repository, never takes one over. A folder named after the repository already there is refused too, before anything is created, and so is a name no folder can have on Windows (a device name such as `CON`, `NUL` or `COM1` before any dot, or a trailing dot), on every platform, since the Brewery's other machines clone it too.
- After the remaining questions (the target repositories, as ADR 0199 asks them), it creates the repository through gh's own login ([ADR 0073](0073-github-only-through-gh-s-own-login.md)): `POST /user/repos` when the owner is the login (compared without case), else `POST /orgs/<owner>/repos`, with `private` as answered and nothing in it.
- It clones `https://github.com/<owner>/<name>.git` into the folder `<name>` in the working directory, through the git Foedrum runs ([`gitEnv`](../../src/workspace/git.ts)): no token in the URL, an argument or the environment, and gh answers git as its credential helper, as for every clone and push of Foedrum's.
- The files are then written in that folder, and doctor runs there; init's last lines say which folder the Brewery is in.
- A creation or clone that fails stops init with GitHub's or git's first line, before any file is written.

### Inside a clone, nothing is created
In a folder with `.git`, init works as ADR 0199 says: it asks the name, creates no repository and clones nothing. A name that GitHub already has is the normal case there: the folder is its clone.

### The intake label, after asking once per target repository
- After the files, for each target repository init reads whether it has the label `foedrum:brew`. One that has it is named and left alone, whatever its colour and description.
- For one that has not, it asks `Create the label foedrum:brew in <repo>? [Y/n]`, default yes, since the intake claims nothing without it. A yes creates it with gh's login, with the description `Foedrum brews an issue with this label into a pull request` and the colour Foedrum's marks use; a label made in the meantime counts as made, as for the marks.
- A no prints the one command to run later: `gh label create foedrum:brew --repo <repo> --description "…" --color ededed`.
- A label that cannot be read or created is named with GitHub's line, followed by that command, and init goes on: the label is the target's, not the Brewery's.

### Commit and push, after asking
- Then it lists the Brewery's files that git sees as new or changed (`git status --porcelain` on the four files init writes), then the commits on the branch that no remote has (`git log HEAD --not --remotes`, none on a branch without a commit yet), which the push sends too, and asks `Commit and push these? [Y/n]`, default yes. Nothing listed is said as such, and nothing is asked.
- A yes adds those files, commits only them (`git commit -- <files>`, so nothing else the user staged goes with them) with the message `Set up the Brewery with foedrum init`, and pushes the branch with `git push -u origin HEAD`, through the same git as the clone.
- A no leaves the files written and uncommitted, and prints the three git commands that commit and push them.
- A git call that fails, also one that cannot tell which commits the remotes lack, is named with git's first line and the same three commands, and ends init in 1 after doctor; the files stay written.

### The order
Questions, then the repository and the clone, then the files (ADR 0199), then the labels, then the commit and push, then doctor and the plugin's commands. The repository is created only after every question about the files is answered, so standard input that ends early creates nothing; input that ends at a label or the push question stops init with a line that names the repository it created and the folder it cloned it into.

## Consequences
- On a machine where gh is logged in and set up as git's credential helper, `foedrum init` in an empty folder ends with a pushed private Brewery and the intake label in each target repository the user allowed.
- init now writes to GitHub: a repository, labels and a push, each after a question or a default the user can see.
- Running init again in the clone creates nothing, keeps the labels and lists nothing to commit when nothing changed.
- `init`'s terminal-only reason names `/foedrum:init` (#530).

## Alternatives considered
- **Create the repository right after its name is asked:** standard input that ended at a later question would leave an empty repository behind.
- **Use an existing repository of that name outside a clone:** init would push into a repository it did not make; cloning it first takes one command.
- **Create the label without asking:** labelling another repository is a change to it, and the maintainer settled on asking.
- **Run `gh repo create --clone`:** one call less, but its output and its git calls are gh's, and the clone would not go through the git Foedrum runs.
