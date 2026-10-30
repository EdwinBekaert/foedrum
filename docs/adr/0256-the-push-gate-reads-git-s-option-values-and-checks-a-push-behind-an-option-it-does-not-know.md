# 0256. The push gate reads git's option values and checks a push behind an option it does not know

Date: 2026-10-30 · Status: Accepted · Amends [0045](0045-the-local-gate-reads-commands-as-the-shells-would.md) (git's options before the subcommand), [0104](0104-the-gate-checks-the-tree-a-command-pushes.md) (a `-C` behind an option the gate does not know), [0114](0114-the-gate-blocks-words-on-a-personal-denylist-in-what-leaves-the-machine.md) (a push whose remote the scan cannot tell) and [0246](0246-the-push-gate-reads-option-prefixes-git-s-configuration-branch-names-and-the-starting-directory.md) (the remote behind `-o`)

## Context
The reviews of #635 found two ways the gate reads the words before a push's remote differently from git:
- The gate stepped over git's options before the subcommand one word at a time, except the six it listed as taking the next word as their value (`-C`, `-c`, `--config-env`, `--git-dir`, `--work-tree`, `--namespace`). `--attr-source` takes one too, so in `git --attr-source HEAD push -f origin main` the gate read `HEAD` as the subcommand, found no push, and the force push was neither blocked nor checked (#636). Any other option with a value that the gate does not list, in this git or a later one, does the same.
- `git push -uo ci.skip origin` is `-u`, then `-o` with the value `ci.skip`, and pushes to origin, but the gate skipped `-o`'s value only when the whole word was `-o`. It read `ci.skip` as the remote, so the configured-mirror check and the denylist scan looked at the wrong remote. A push to origin with `remote.origin.mirror=true` got through (#637).

Both are forms the gate's own rules already cover ("force pushes in any form", the remote a push goes to), so reading them is reading the command as git does, not a new safeguard ([docs/trust-boundaries.md](../trust-boundaries.md), "A session skipping the procedure").

## Decision

### git's options before the subcommand
The gate lists git's global options in two sets and matches each whole word, as git does:
- **With a value as the next word:** `-C`, `-c`, `--config-env`, `--git-dir`, `--work-tree`, `--namespace`, `--attr-source`, `--super-prefix`, `--shallow-file`.
- **Without a value:** `-h`, `--help`, `-v`, `--version`, `-p`, `--paginate`, `-P`, `--no-pager`, `--bare`, `--exec-path`, `--html-path`, `--man-path`, `--info-path`, `--no-replace-objects`, `--no-lazy-fetch`, `--no-optional-locks`, `--no-advice`, `--literal-pathspecs`, `--glob-pathspecs`, `--noglob-pathspecs`, `--icase-pathspecs`.

A long option from the first set, `--exec-path` or `--list-cmds` may also give its value after `=` in the same word.
These lists were checked against `git help git` and git's `handle_options`.

Any other option before the subcommand may take the next word, so the gate cannot tell which word is the subcommand. It fails closed and reads the command as a push to check, whatever follows:
- The push runs the check, at the place git's `-C` options give.
- Its remote counts as one the gate cannot tell, like a remote computed at run time. So the configured-mirror check holds it to every remote's settings, and while a denylist is set the scan refuses it.
- Force, delete and mirror options are read over every word after the unknown option, so `git --frobnicate x push -f` is blocked as a force push.
- `git config` or `git remote` anywhere after it counts as configuring git in the same command.
- git's own options may still follow the unknown option's value, so every later `-c` or `--config-env` that sets a push setting counts as configuring git. Every later `-C` makes the push run in a directory the gate cannot tell, which blocks it.

git itself refuses an option it does not know, so such a command rarely runs. The cost of failing closed is one check for a command that would have failed anyway.

Help is unchanged ([ADR 0246](0246-the-push-gate-reads-option-prefixes-git-s-configuration-branch-names-and-the-starting-directory.md)): `-h` and `--help` count as help only as git's first word. After `-c x=y`, `-h` is skipped as an option without a value, and the push behind it is read.

Rejected:
- Adding `--attr-source` to the list alone, which leaves the next option git adds open.
- Matching prefixes of git's global options, which git does not accept.

### `-o` in a group of push flags
In push's arguments before `--`, a single-dash word made of push's short flags without a value (`v`, `q`, `d`, `n`, `f`, `u`, `4`, `6`) and then `o` is read as git's parse-options reads it:
- The rest of the word after `o` is `-o`'s value (`-oci.skip`, `-uoci.skip`).
- When nothing follows `o`, the next word is the value (`-uo ci.skip`, `-qvo ci.skip`).
The remote is the operand after it.

## Consequences
- `git --attr-source HEAD push -f origin main` is blocked as a force push, and `git --attr-source HEAD push origin` is checked against origin.
- A push behind an option the gate does not know is checked, held to every remote's configuration, and refused by the denylist scan while a list is set.
- `git push -uo ci.skip origin` is held to origin's settings and scanned against origin.
- CLAUDE.md's Local gate section should say three things. An option git's lists do not hold, before the subcommand, makes the command a push to check. A `-C` behind such an option blocks the push as a directory the gate cannot tell. A `-c` or `--config-env` behind it that sets a push setting counts as configuring git. That change follows in a docs pull request.
