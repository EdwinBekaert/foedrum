# 0411. A brewer's netrc is the null device

Date: 2026-11-16 · Status: Accepted · Amends [0063](0063-foedrum-serve-its-configuration-and-wiring.md) (the variables the runner forces) and [0109](0109-a-brewer-s-git-holds-no-push-credential.md) (its forced variables and its netrc line under Not covered)

## Context
[ADR 0109](0109-a-brewer-s-git-holds-no-push-credential.md) leaves a brewer's git, and a check step's, no credential helper, askpass program, cookie or terminal, but not a netrc file (`~/.netrc`, or `_netrc` on Windows) in the user's home: git's http transport sends its login when the server asks for one, before any helper, and no git setting turns that off. It left the fix to a home of the brewer's own.

Where the netrc is reachable today:
- **The sandboxed level** hides the home from a brewer's commands (`blockReadsOutsideWorkingDirectories`, [ADR 0160](0160-sandboxed-commands-read-only-inside-the-working-directories.md), which names `~/.netrc`) and keeps them off the network. A check step's sandbox hides the home too: bwrap mounts an empty tmpfs over it, and on macOS `HOME` is the check's own empty temporary folder ([ADR 0076](0076-check-steps-run-in-an-os-sandbox-with-no-network.md)).
- **The permissions-only level**, native Windows and a Linux or macOS without the sandbox's tools ([ADR 0010](0010-cross-platform-and-isolation-levels.md)), hides nothing, and check steps on native Windows run unsandboxed: there a brewer's git sends the netrc login.

A home of the attempt's own does not fit `claude`. Claude Code keeps its login under `~/.claude` on Linux and Windows and in the macOS Keychain, and `~/.claude.json` in the home ([Authentication](https://code.claude.com/docs/en/authentication), "Credential management"; [The .claude directory](https://code.claude.com/docs/en/claude-directory)). `CLAUDE_CONFIG_DIR` moves them, but "keys the macOS Keychain entry to that directory too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different entry" (Authentication, "Credential management"): a claude given another home logs out on macOS, whatever `CLAUDE_CONFIG_DIR` names. A home only for the commands claude runs loses the user's global git configuration, the identity a brewer's commits need among it, and every toolchain that keeps its files in the home (`~/.cargo`, `~/go`).

libcurl, which git's http transport uses, reads the file `NETRC` names before it looks in the home: "If the NETRC environment variable is set, that filename is used as the netrc file", added in curl 8.16.0 ([CURLOPT_NETRC](https://sources.debian.org/src/curl/8.19.0-3/docs/libcurl/opts/CURLOPT_NETRC.md), the Debian copy of curl's 8.19.0 docs). Go's `GOAUTH` reads the same variable ([go command](https://pkg.go.dev/cmd/go), `GOAUTH`).

## Decision
`brewerForcedEnv` (`src/engine/brewer-env.ts`) forces `NETRC` to the platform's null device, `os.devNull` (`/dev/null`, or `\\.\nul` on Windows). Like ADR 0109's variables, it goes last, so neither the base nor a brewer's `env` replaces it (a brewer's `env` may name `NETRC`, as it may `DISABLE_AUTOUPDATER`, and the forced value replaces it), and it reaches every process those variables reach: brewers, interactive and resumed sessions, setups and check steps.

- **The null device, never an empty value.** An empty `NETRC` sends libcurl back to the home (Verification).
- **`HOME` and `USERPROFILE` stay the user's.** claude keeps its login, git its configuration, and the toolchains their folders.

### Not covered
- **A git whose libcurl is older than 8.16.0** ignores `NETRC` and reads the home's netrc. On the sandboxed level the sandbox still hides it; on the permissions-only level outside native Windows, a Linux or macOS whose git links an older system libcurl, the netrc login still reaches a brewer's git. `git version --build-options` names the libcurl (`libcurl:`). Git for Windows ships its own libcurl (8.22.0 with git 2.56.0). The macOS 26 image's git 2.56.1 ignores `NETRC` (CI, 2026-11-16), so a brewer there on the permissions-only level still sends the netrc login; on the sandboxed level the sandbox hides the home folder there (ADR 0160).
- **A process that clears or replaces `NETRC`**, as ADR 0109 says of its own variables.
- **Other tools' logins in the home** (`~/.npmrc` and the rest) on the permissions-only level, as ADR 0109 already says.

## Consequences
- A brewer's git, or a check step's, with libcurl 8.16.0 or later no longer sends a netrc login: a private https fetch that worked only through it now fails, as ADR 0109's Consequences already say of private repositories. The same holds for curl 8.16.0 or later and Go run by a brewer or a check step.
- A Brewery changes nothing: no file and no setting holds the variable.
- `test/unit/brewer-env.test.ts` checks the value and that neither the base nor a brewer's `env` replaces it. `test/integration/brewer-git-credentials.test.ts` checks that a child started as the runners start one, through the Job Object and the platform shell, sees `NETRC` at the null device. Whether git's libcurl reads it is the machine's, so no test checks that: a test never checks what a tool does (Verification).

## Verification
On 2026-11-16, with git 2.56.0.windows.2 (`libcurl: 8.22.0`), ADR 0109's forced pairs, a made-up netrc and `_netrc` for `127.0.0.1`, and a local server that asked for a login, `git ls-remote` sent the netrc login with `HOME` at the netrc's folder, and none with `USERPROFILE` alone at it. With `NETRC` at a missing file, an empty file, `NUL` or `\\.\nul`, it sent none, with the netrc in both homes. With `NETRC` empty it sent the home's, and with `NETRC` at the netrc's own path and both homes empty it sent that login, so git's libcurl reads the variable.

On CI, the same check as a test, a push with the forced variables and a made-up netrc in `HOME` and `USERPROFILE`, sent no login on the `windows-2025-vs2026`, `ubuntu-26.04` and `macos-26-arm64` `20261102.0473` images (git 2.56.0 on macOS); on `macos-26-arm64` `20261112.0504`, whose git is 2.56.1 and whose software list names curl 8.7.1, it sent the login with `NETRC=/dev/null` (run 43966227854). Which libcurl that git links was not read.

## Alternatives considered
- **A home of the attempt's own for claude**, with `CLAUDE_CONFIG_DIR` at the user's config folder: logs claude out on macOS (Context).
- **A home of the attempt's own for claude's commands and the check steps** (through `CLAUDE_ENV_FILE` for the Bash tool, and directly for a check): needs `GIT_CONFIG_GLOBAL` at the user's file to keep the identity, breaks toolchains under the home, and is not checked under `--safe-mode`; what it adds over `NETRC`, a git that ignores `NETRC` such as the macOS 26 image's (Verification), is left uncovered on the permissions-only level for that cost.
- **Doctor names a libcurl older than 8.16.0** on the permissions-only level: left to the security page's list of what the rules don't cover ([security](../design/security.md)), which already says that on that level nothing stops a push that gets a login.
