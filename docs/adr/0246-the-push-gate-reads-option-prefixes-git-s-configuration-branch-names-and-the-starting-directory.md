# 0246. The push gate reads option prefixes, git's configuration, branch names and the directory a push starts in

Date: 2026-10-28 · Status: Accepted · Amends [0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) (push's long options by prefix, `--prune`, git's configuration), [0104](0104-the-gate-checks-the-tree-a-command-pushes.md) (the starting directory) and [0114](0114-the-gate-blocks-words-on-a-personal-denylist-in-what-leaves-the-machine.md) (branch names and refspec destinations)

## Context
The audit of `b01300bb` ([ADR 0245](0245-brew-audit-a-read-only-audit-of-the-code-at-every-last-call.md)) and its review found five ways a `git push` gets past what the gate says it blocks (#613):
- git takes any unique prefix of a long option, so `git push --del origin x`, `--mirr` and `--forc` pass a gate that matches whole words;
- `--prune` is not read at all, and `git push --prune origin 'refs/heads/*:refs/heads/*'` from a worktree that holds two branches deletes every other branch on the remote, every other session's pull request branch with them;
- a delete, force or mirror can come from git's configuration instead of an option: `git -c remote.origin.mirror=true push origin`, or a plain `git push` after `git config remote.origin.push :refs/heads/x`;
- the denylist scan reads what the commits hold, never the name of the branch a push creates on the remote, which shows on the pull request page and in notification emails;
- ADR 0104 puts a directory a command changes into to the project test, but never the directory the command starts in: Claude Code keeps a session's directory between commands, so after `cd .foedrum/tmp/review-701` a plain `git push` runs that scratch clone's check script before anyone approves the command.

Each is a form the gate's own rules cover ("force pushes in any form", "pushes that delete or mirror remote refs", "a listed word stays on the machine", "the tree a command pushes"), so reading it is reading the command as git does, not a new safeguard.

## Decision

### Push's long options by prefix
A long option of `git push`, its name before any `=`, counts as `--delete`, `--mirror`, `--prune`, `--force`, `--force-with-lease` or `--force-if-includes` when it is that option or a prefix of it, three characters or more with the dashes: `--del`, `--mirr`, `--pru`, `--forc`, `--force-w`.
A prefix that two options share (`--d` for `--delete` and `--dry-run`, `--pr` for `--prune` and `--progress`) blocks too: git would refuse it as ambiguous, and the gate never counts on git's own refusal.
The gate keeps no copy of git's option list: no harmless push option is exactly a prefix of one of those six, so "a prefix of a blocked option" is the same test as "a unique or ambiguous prefix that may expand to it", and there is no list to drift from git's.
Checked against `git push -h` of git 2.56: `--all`, `--atomic`, `--branches`, `--delete`, `--dry-run`, `--exec`, `--follow-tags`, `--force`, `--force-if-includes`, `--force-with-lease`, `--ipv4`, `--ipv6`, `--mirror`, `--porcelain`, `--progress`, `--prune`, `--push-option`, `--quiet`, `--receive-pack`, `--recurse-submodules`, `--repo`, `--set-upstream`, `--signed`, `--tags`, `--thin`, `--verbose`, `--verify`, each with its `--no-` form.
Rejected: matching the whole words and adding the common abbreviations, which leaves the next one open.

### Push's help is no push
`git push --help` (git turns it into `git help push`), `git push -h` as the one argument beside the shell's redirections, and `git -h` or `git --help` before the subcommand print help and push nothing, so the gate runs no check and no scan for them; `git help push` never was a push.
A help call ran a full `npm run check` during another session's quiet window, the observed failure behind this.
`-h` beside any other argument is still read as a push, failing closed.

### `--prune`
`--prune`, in any form above, blocks with the delete line, with or without a refspec: a session never needs it, and a maintainer deletes remote branches.

### git's configuration
The gate reads where a push's configuration can come from, and blocks a push that git's configuration makes delete, force or mirror:
- **On the command line.** A `git … push` whose git options set `remote.*` or `push.*` (`-c remote.origin.mirror=true`, `-c push.default=matching`, `--config-env=…`, the key's case ignored, as git ignores it) blocks, and so does a `-c` or `--config-env` whose value is computed at run time. `--config-env` takes its value after `=` or as the next word, as git reads it; today `git --config-env k=V push` was not even read as a push.
- **In the environment.** A pushing command that mentions `GIT_CONFIG` anywhere (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, …) blocks, as `GH_REPO` does for `gh pr ready`: these route configuration in by the same path as `-c`, and the gate's own git calls would not see them.
- **Written in the same command.** A pushing command that also runs `git config` or `git remote` blocks: the gate reads the configuration before the command runs, so it would read the old one. Run them in commands of their own.
- **In the configuration files.** Before the push, in the tree it pushes, the gate runs one `git config -z --get-regexp '^remote\..*\.(push|mirror)$'`, which reads every scope (system, global, the repository's, includes), with the same 10 s deadline as the HEAD check and at the same time as it, so the hook's 600 s budget is unchanged. A `remote.<r>.mirror` that is not false, or a `remote.<r>.push` that starts with `+` or `:`, blocks, for the remote the push names, or for every configured remote when it names none or one computed at run time: finding the push remote of the branch would take another git call, and reading every remote is the stricter answer. A read that fails or is killed blocks; exit 1 (nothing matched) is no configuration.
  This read is the gate's own, beside the HEAD check, not the denylist scan's, so the rule holds without a denylist set.

Rejected: leaving the configuration to git's own refusals (there are none: a mirror push is what the setting asks for); reading only `-c`, which leaves `git config remote.origin.push` one command earlier.

### Branch names and refspec destinations on the denylist
While a denylist is set, the scan also reads the current branch's name and the destination of every refspec the push names (the part after `:`, or the whole refspec without one, a leading `+` dropped), each against the list as any other line; a hit refuses with the place `branch name`, never the word.
The scan learns the branch name from the call that already finds the push remote (`git for-each-ref` with `%(refname:lstrip=2)` beside `%(push:remotename)`), which now runs for every push, so the scan still makes at most three git calls within its budget; when it fails, the push blocks, since the gate cannot tell which name it sends.
A refspec computed at run time blocks while a list is set, as a remote computed at run time does: the gate cannot tell which name it creates.

### The directory a push starts in
A `git push` that changes no directory runs in the hook's working directory, and that directory now takes the same test as one it changes into (`projectHolds`): outside `CLAUDE_PROJECT_DIR` by real path, or in a review's scratch folder under `.foedrum/tmp/`, the push blocks with the same line, before anything runs there.
Without `CLAUDE_PROJECT_DIR` every push blocks, as every change of directory already did; Claude Code always sets it for a hook.
`gh pr create` is unchanged, though the issue named it beside the push: it runs no tree code ([ADR 0135](0135-the-gate-drops-the-check-on-gh-pr-create-the-graphql-readers-and-the-alias-rule.md)), and the rule exists because the gate would run a tree's code.
`gh pr ready` is unchanged for the same reason; its lookup already blocks without a number where it cannot tell the directory.

## Consequences
- `git push --del`, `--mirr`, `--forc`, `--prune` in any form, a mirror or a deleting or forcing push refspec from configuration, and a push from a scratch clone all block with one line; `git push -u origin <branch>`, `--dry-run`, `--set-upstream` and `--follow-tags` pass as before.
- Every push costs one more local git call, run beside the HEAD check, and the denylist scan one more when the push names its remote.
- A person with a mirror remote configured beside origin names the remote they push to (`git push origin`), or the push blocks.
- The precheck integration tests set `CLAUDE_PROJECT_DIR` to the folder they push from, which is under `.foedrum/tmp/tests/`.
- CLAUDE.md's gate section follows in the consultant's documentation pull request after the merge.
