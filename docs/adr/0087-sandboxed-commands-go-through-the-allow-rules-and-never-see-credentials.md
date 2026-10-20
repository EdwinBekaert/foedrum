# 0087. Sandboxed commands go through the allow rules, and never see the credentials Foedrum names

Date: 2026-10-20 · Status: Accepted · Amends [0042](0042-the-claude-command-line-and-stream-contract.md) (the sandbox settings), [0046](0046-only-the-runners-settings-the-init-check-and-a-line-by-line-stream.md) (the keys of the settings file) and [0085](0085-the-out-doc-contract-names-the-attempts-shell-commands.md) (its line about the sandboxed level)

## Context
On the sandboxed isolation level (macOS, Linux, WSL2; [ADR 0010](0010-cross-platform-and-isolation-levels.md)), the attempt settings write `sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false }` (ADR 0042, ADR 0046). The consultant review of #231 found (#234) that this leaves the brewer's shell open. Claude Code's documentation, read for this ADR on 2026-10-20 ([Sandboxing](https://code.claude.com/docs/en/sandboxing), "Sandbox modes"; [Settings reference](https://code.claude.com/docs/en/settings-reference), `sandbox.autoAllowBashIfSandboxed`), says:

- "Claude Code approves a command automatically, with no prompt, when the command runs inside the sandbox." This is auto-allow mode, and `autoAllowBashIfSandboxed` "Default: `true`".
- "Auto-allow mode works independently of your permission mode setting, with three exceptions: plan mode, an auto mode command that carries per-command allowed domains, and server-side classifier review of sandboxed commands in auto mode." `dontAsk` is not one of them.
- Even in auto-allow mode, a command a `Bash` deny rule matches is still blocked, and content-scoped ask rules still prompt.
- With `false`, "sandboxed commands go through the regular permission flow, so your allow rules and permission mode decide."

So on the sandboxed level a brewer's `tools.allow` did not limit its shell: only the deny rules did. That undid, for every sandboxed brewer, [ADR 0062](0062-brewers-never-allow-git-with-no-fixed-subcommand.md) (which relies on no allow rule reaching a push, because no deny rule covers every spelling), [ADR 0082](0082-brewers-never-allow-gh.md) (no rule that starts `gh` or `git credential`) and [ADR 0085](0085-the-out-doc-contract-names-the-attempts-shell-commands.md)'s line "Your shell runs only: …".

The same pages say what a sandboxed command can reach once it runs:

- Reads: "Most of the machine, including credential files such as `~/.ssh` and `~/.aws/credentials`" (Sandboxing, "What the sandbox restricts"); "read access to the entire computer, except certain denied directories. This default still allows reading credential files" ("Filesystem isolation").
- Environment variables: "Inherited from Claude Code, including any secrets in its environment."
- "There is no built-in credential deny list, so only the files and variables you list are restricted" ("Protect credentials").
- The protected paths of `~/.claude`, `.credentials.json` included, are protected from writes ("Protected paths"); nothing on the page makes them unreadable.

So even with the allow rules deciding, an allowed command that runs code a brewer can edit (`npm test`, ADR 0062's "what it cannot close") could read `~/.config/gh/hosts.yml` or `~/.claude/.credentials.json`.

## Decision

### The allow rules decide on every level
- The sandbox block sets `"autoAllowBashIfSandboxed": false` whenever the attempt settings enable the sandbox. Under `--permission-mode dontAsk` a sandboxed command then runs only when an allow rule matches it, as on the permissions-only level, and the ask rules the docs mention cannot prompt anyone (`dontAsk`, `--permission-prompts none`, ADR 0042).
- The schema (`AttemptSettings`, `src/schemas/attempt-settings.ts`) requires it as the literal `false`, so a file that would auto-allow cannot be written.
- Precedence: the runner passes `--setting-sources ""` (ADR 0046), so the only settings file is `--settings`; managed settings, if a machine has them, can still set the key (the docs: "Set the key in managed settings to keep a repository from changing it"). Foedrum does not get around managed settings (ADR 0046).

### The credentials every sandboxed attempt hides
The sandbox block also has `credentials` (Settings reference, `sandbox.credentials`), every entry `"mode": "deny"`: a file entry is "denied for reads inside the sandbox, the same restriction that `filesystem.denyRead` applies", and a variable "unset before each sandboxed command runs" (Sandboxing, "Protect credentials"). `sandboxCredentials` lists them and the schema requires each one.

| Entry | Why |
|---|---|
| `~/.config/gh` | gh's configuration directory when neither `GH_CONFIG_DIR` nor `XDG_CONFIG_HOME` is set ([gh environment](https://cli.github.com/manual/gh_help_environment)); `hosts.yml` holds the login when gh stores it in a file, the case the docs' own mask example names |
| `~/.git-credentials`, `~/.config/git/credentials` | git's credential store; the docs keep both blocked even where they re-open git's configuration ("Sandboxed commands under the read block") |
| `~/.ssh` | The docs' own example and their advice for managed deployments: "Add `sandbox.credentials` entries for credential directories such as `~/.aws` and `~/.ssh`" |
| `~/.aws` | The same advice; the whole directory, not only `credentials` |
| `~/.npmrc` | npm's user configuration, where a registry token is kept. npm reads it as a file: an unreadable one is recorded and skipped, only `ENOENT` is silent, and npm goes on (`#loadFile` and `#loadObject` in npm's `@npmcli/config`) |
| `~/.claude/.credentials.json` | Claude Code's login on Linux and WSL2, and on macOS when the Keychain refuses the write ([Authentication](https://code.claude.com/docs/en/authentication), "Credential management") |
| `~/.config/anthropic` | Anthropic profiles and federation credentials, which Claude Code also reads (Authentication, "Anthropic profiles and federation credentials") |
| `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` | The variables gh prefers to its own login (gh environment; ADR 0073) |
| `NPM_TOKEN` | The docs' own example |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code's credentials as variables (Authentication, "Authentication precedence"). `brewerBaseEnv` passes `ANTHROPIC_*` to claude on purpose; a sandboxed command does not need them |

- The variables are a second line: `brewerBaseEnv` already leaves the GitHub tokens out (ADR 0063, ADR 0073), but a brewer's own `env` could set one, and the entry unsets it for sandboxed commands whatever set it.
- Paths start with `~/`, which the sandbox resolves "Relative to home directory" (Settings reference, "Sandbox path prefixes"). The `deny` entries from `--settings` apply, as the docs say Claude Code "merges the `deny` entries from every settings scope the session loads".
- `mask` is not used: it needs `network.tlsTerminate` and lets the proxy send the real value to allowed hosts, and a brewer needs none of these logins.

### What stays open, and what the docs do not settle
- **A path elsewhere.** A `GH_CONFIG_DIR`, `XDG_CONFIG_HOME` or `CLAUDE_CONFIG_DIR` that points outside these paths is not covered, nor are credentials of other tools (`~/.docker/config.json`, `~/.kube`, `~/.netrc`, a cloud CLI's). The list names the logins Foedrum's own setup relies on (gh, git, Claude Code) and the docs' examples; a Brewery with others must not run untrusted repositories on this level until they are covered.
- **The Windows home on WSL2** (review of #236). Every entry starts with `~/`, the Linux home. On WSL2, Windows's drives are mounted under `/mnt`, and the sandbox reads "most of the machine", so the Windows user's copies of the same logins (`/mnt/c/Users/<user>/.claude/.credentials.json`, `.ssh`, `.git-credentials`, gh's `AppData/Roaming/GitHub CLI`) stay readable. Listing them needs the Windows user's home, which the attempt settings do not know; a later change can add them from it. Until then, a WSL2 Brewery whose Windows user is logged in to these tools is not covered.
- **The OS keyring.** gh stores its login in the OS keyring (ADR 0073), and on macOS so does Claude Code. The docs say nothing about whether a sandboxed command can ask the macOS Keychain or the Secret Service over D-Bus. They say only that the macOS sandbox looks up the XPC and Mach services it allows, with `allowMachLookup` listing "additional" ones, without naming the default set; and that on Linux and WSL2 "The seccomp filter is optional and adds Unix domain socket blocking". So whether `security find-generic-password` or `secret-tool lookup` run by an allowed command's script reaches the login is **not settled by the docs**, and this ADR does not claim it. What holds: no allow rule may start `gh` or `git credential` (ADR 0082), and those rules now decide on this level too.
- **The network.** A sandboxed command reaches no host outside `allowedDomains`, which start empty and which the attempt settings never set, and in `dontAsk` mode a connection to another host is "Refused" (Sandboxing, "Hosts outside your allowed domains"). A credential read anyway cannot leave the machine that way; it can still be written into a commit or an out doc, which #209 scans for.
- **What is not a sandboxed command.** `sandbox.credentials` "affects sandboxed Bash commands only". The file tools follow permission rules, scoped to the worktree for brewers (ADR 0049), and check steps run outside the sandbox until #190 (ADR 0069).
- **Native Windows** stays permissions-only (ADR 0010, ADR 0042): no sandbox block is written there, and the allow rules already decide.

### Tests
Unit only (`test/unit/attempt-settings.test.ts`): the sandbox block has `autoAllowBashIfSandboxed: false` and the credentials above, and the schema refuses a sandbox block without the key, with `true`, with a file or a variable missing, or with an entry whose mode is not `deny`.

**Unverified against `claude`.** The key names and shapes (`autoAllowBashIfSandboxed`, `credentials.files[].path`, `credentials.envVars[].name`, `mode`) come from the docs above, not from a run. A `claude` that named them differently or ignored them would leave the shell and the credentials open, and nothing in the stream would say so (ADR 0046: the init check sees neither an allow rule nor a variable). An opt-in real-claude case that writes the sandbox block and checks that an unmatched command is denied and a denied variable is unset can only run on macOS, Linux or WSL2; it belongs with the first run of the sandboxed level there (review of #236). No test runs Claude Code's sandbox: it does not start on native Windows (ADR 0042), and what it does with these keys is the docs', not Foedrum's. The opt-in runner settings tests (`test/integration/claude-runner-settings.test.ts`, ADR 0057) write files without a sandbox block, so they show the permissions-only file still loads, not the sandbox block.

## Consequences
- On the sandboxed level, ADR 0062's and ADR 0082's allowlist checks and ADR 0085's "Your shell runs only" line hold again. ADR 0085's sentence that the line holds "only once #234 is fixed" is now met.
- A sandboxed brewer's commands that no allow rule matches are denied, as on the permissions-only level; nothing it ran before by auto-allow alone runs any more. A brewer that relied on that has to name its commands.
- A sandboxed command that needs one of these files or variables (an `npm test` that reads a private registry's token, a test that uses ssh) fails on this level. That is the point; such a Brewery names its own approach before running on it.
- ADR 0082 says the sandboxed level "keep[s] them apart" from gh's login, and doctor advises it as what closes the keyring for brewers. After this ADR, that holds for the hosts file at gh's default path and for the token variables, from the docs; for the OS keyring the docs settle nothing (above). Rewording ADR 0082 and doctor's advice is #229's, whose scope this ADR does not change: it now has the documentation answer for files and variables, and still the open keyring question.
- The settings file of every sandboxed attempt grows by about 1 KB.

## Alternatives considered
- **Deny rules instead of `autoAllowBashIfSandboxed: false`:** deny rules still apply in auto-allow mode, but ADR 0062 showed that no deny rule covers every spelling of a push; only an allowlist does, and auto-allow skips it.
- **`filesystem.denyRead` instead of `credentials.files`:** the same read block (the docs), but `credentials` keeps the variables with the files and says what the entries are for.
- **`permissions.blockReadsOutsideWorkingDirectories`:** denies sandboxed commands the home directory and other user roots and re-opens the working directories (Settings reference, "Sandboxed commands under the read block"), so it covers paths this list misses. It also changes what the file tools may read, its re-opened set (`~/.gitconfig` and the files it names, parts of `~/.claude`) needs a decision of its own, and the docs list cases where it does not reach sandboxed commands. Left for a later decision rather than taken here without one.
- **`mask` entries:** they let tools authenticate without holding the value, which a brewer does not need, and need TLS termination (above).
- **Deny all of `~/.claude`:** broader than the credential, and Claude Code re-opens parts of it that commands need; the credentials file is the secret.
