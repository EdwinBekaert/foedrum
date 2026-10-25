# Keeping the machine awake

`foedrum brew` and `foedrum serve` keep the machine from sleeping on its idle timer while at least one attempt of theirs runs, a brewer's or a check step's ([ADR 0195](../../adr/0195-brew-and-serve-keep-the-machine-awake-while-an-attempt-runs.md)).
The hold starts when the first attempt starts and is let go one minute after the last one ends, unless another attempt starts within it, so the steps of a batch share one hold and `serve` lets the machine sleep as usual between orders (`HOLD_GRACE_MS`); it is let go at once when the command ends.
On all three platforms only the idle timer is held off: the display may still turn off, and the machine still sleeps when the user asks it to, when the lid closes or when the battery is critical; on battery the hold stays.
It is on by default; `"keepAwake": false` in `foedrum.jsonc` turns it off for the Brewery, and in `.foedrum/local.jsonc` for one machine, whose word wins.

A helper process holds it, started through the process runner with no shell and stopped with its whole tree (`keepAwake`, `src/platform/keep-awake.ts`):

| Platform | Helper |
|---|---|
| Windows | Windows PowerShell by its full path in System32, with an encoded command that calls `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` through a P/Invoke method emitted in memory and waits on Foedrum's process; `powercfg /requests` lists it under SYSTEM |
| macOS | `caffeinate -i -w <pid>`, found on PATH |
| Linux | `systemd-inhibit --what=idle --who=foedrum --why="foedrum brewing" --mode=block tail --pid=<pid> -f /dev/null`, both found on PATH, where systemd runs (`/run/systemd/system`) |
| Elsewhere, or a program missing | nothing; the machine sleeps as before |

The helper watches Foedrum's process id, so a killed Foedrum lets the hold go.
A helper that ends on its own is started again by the next attempt.
The driver wiring (`wireDriver`, `src/cli/driver-wiring.ts`) tells the hold of each attempt the runner starts and of its end; `brew` and `serve` let it go when they end.
`foedrum doctor` prints a `Keep awake:` line with the mechanism this machine has and its program, or `none` and why; a machine without one is no problem.
