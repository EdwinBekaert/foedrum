# Lens: cross-platform

Review the change for code that works on the author's operating system but breaks on Windows, macOS or Linux. Assume all three are supported unless the repository's instructions say otherwise. You are one of several reviewers, each with one lens; stay inside this one.

## Look for

**Paths.**
- Paths must be built with the platform's path functions (`path.join`, `path.resolve` or the equivalent), never by concatenating strings with `/` or `\`.
- No `~`, no hard-coded `/tmp`, `/home/…`, `C:\…`; use the home and temp directory functions.
- `file:` URLs converted with a proper function (`fileURLToPath`), not by taking `.pathname`.
- Comparing paths: case-insensitive file systems (Windows, default macOS), mixed separators, trailing separators, normalisation.
- Paths for git or URLs use `/` on every OS; paths for the file system use the native separator. Mixing the two is a finding.
- Windows limits: reserved names (`CON`, `NUL`, `AUX`, …), characters `<>:"|?*`, trailing dots or spaces, long paths.

**Spawning processes.**
- Programs run with an argument array and no shell. On Windows, `.cmd` and `.bat` files cannot be spawned without a shell; check how the change handles that, and that executable lookup respects `PATHEXT`.
- Signals: `SIGTERM` and `SIGKILL` do not stop a process tree on Windows, and negative process IDs (process groups) do not exist there. Killing a tree needs platform-specific code.
- Shell syntax in scripts and commands: single quotes, `&&`, `VAR=value cmd`, glob expansion and `rm -rf` behave differently or not at all in `cmd.exe` and PowerShell.
- Operating-system-specific behaviour should live in one platform module, not be scattered through the code.

**Line endings and encoding.**
- Text written by the program uses LF unless a format requires otherwise.
- Parsers tolerate CRLF and a UTF-8 byte order mark. Splitting on `\n` leaves `\r` behind; comparing a parsed line with a literal then fails on Windows.
- Test fixtures and expected strings can be rewritten by git's line-ending conversion; check the repository's attributes.

**File system.**
- On Windows, renaming, deleting or overwriting a file that another process (or an antivirus scanner) has open fails with `EBUSY` or `EPERM`; operations that must succeed need a bounded retry.
- Rename over an existing file, atomic writes, file permissions (`chmod` has little effect on Windows), symbolic links (need privileges on Windows), file watching differences, file names that differ only in case.

**Environment.**
- Environment variable names are case-insensitive on Windows (`Path` versus `PATH`); `HOME` is often unset there.
- Locale and time zone: formatting, sorting and parsing that depend on the machine's settings.

**Tests.** Hard-coded separators or absolute paths in expected values, temporary directories not cleaned up (or cleaned up while a handle is still open, which fails on Windows), tests skipped on one OS without a stated reason.

## Leave to other lenses

Shell injection and untrusted input (security); logic errors and missing deadlines (correctness); naming and documented decisions (design conformance). Style is out of scope for every lens.

## Reporting

Report only what you can tie to specific lines of the change. For each finding name the operating system where it breaks and what the user sees there (wrong path, crash, hang, garbled output). If you find nothing, say so; do not invent findings.
