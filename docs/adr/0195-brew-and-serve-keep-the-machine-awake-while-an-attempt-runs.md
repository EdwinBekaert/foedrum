# 0195. `brew` and `serve` keep the machine awake while an attempt runs

Date: 2026-10-25 · Status: Accepted

## Context
A brew runs for many minutes, and `foedrum serve` for hours (ADR 0063, ADR 0123). Nothing kept the machine awake: when a laptop's idle timer fired, every running attempt stopped with it, claude and the checks too, and the batch picked up only through the supervisor's lost-attempt path (ADR 0027) once the machine woke. That costs the attempt's tokens and its time.

Each platform has a built-in way to hold the machine awake, so no package is needed (ADR 0004). The maintainer settled the details on #476 (2026-10-25).

## Decision

### When
- `foedrum brew` and `foedrum serve` hold the machine awake while at least one attempt of theirs runs, a brewer's or a check step's. The hold starts when the first attempt starts and is let go when the last one ends, so `serve` lets the machine sleep as usual between orders.
- It is let go when the command ends, and when Foedrum is killed: the helper that holds it watches Foedrum's process id and exits when that process is gone.
- Only the idle timer is held off. The display may still turn off, and the operating system still sleeps when the lid closes and on a critical battery.
- It holds on battery too: an attempt cut off by sleep loses more than the battery it would use.
- It is on by default. `"keepAwake": false` in `foedrum.jsonc` turns it off for the Brewery, and in `.foedrum/local.jsonc` for one machine; the local file wins when both say.

### How
One helper process per hold, started through the process runner with an argument array and no shell (ADR 0031), and stopped by its process id with its whole tree (ADR 0035):
- **Windows:** Windows PowerShell by its full path in System32, as the Job Object helper is (ADR 0039), with an encoded command that calls `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` through a P/Invoke method emitted in memory, and then waits on Foedrum's process. The request lasts as long as the helper's thread, so it ends with the helper. `powercfg /requests` lists it under SYSTEM.
- **macOS:** `caffeinate -i -w <pid>`, found on PATH: it holds off idle sleep until the process `<pid>` exits.
- **Linux:** `systemd-inhibit --what=idle:sleep --who=foedrum --why="foedrum brewing" --mode=block tail --pid=<pid> -f /dev/null`, both found on PATH: logind holds the lock while `tail` waits on Foedrum's process. Where systemd is not there, there is no mechanism.
- Elsewhere, or where a program is missing, nothing starts and the machine sleeps as before.
- When the helper ends on its own (it failed to start, or its call was refused), the hold is gone until the next attempt starts, which starts the helper again.

### Doctor
`foedrum doctor` prints one line, `Keep awake:`, with the mechanism this machine has and its program, or `none` with why (no systemd-inhibit or tail on PATH, no caffeinate, a platform without one). It is no problem: a machine that has none runs as before.

## Consequences
- A brew started on a laptop with a short idle timer is still running when its owner comes back.
- A Windows hold costs one PowerShell process, about 0.4 s to start (ADR 0039), once per stretch of attempts, not once per attempt.
- The hold is held by a separate process; a killed Foedrum leaves it for at most the helper's own poll (`tail --pid` reads about once a second; `caffeinate -w` and PowerShell's wait are told by the system).
- A Linux machine without systemd keeps sleeping on its idle timer. A mechanism for it is its own issue, when someone needs one.

## Alternatives considered
- **A setting that is off by default:** rejected by the maintainer. An attempt lost to sleep is the surprise; a machine kept awake while it brews is what someone starting a brew expects.
- **Hold for as long as `serve` runs:** rejected. `serve` runs for days and would keep an idle laptop awake between orders.
- **Let go on battery:** rejected by the maintainer. The operating system still sleeps on a critical battery or a closed lid.
- **A package that wraps each platform's call:** rejected (ADR 0004). Each platform has a built-in program or call.
- **Call `SetThreadExecutionState` from node itself:** node has no foreign function interface without a native addon, which ADR 0004 rules out.
- **Hold the display too (`ES_DISPLAY_REQUIRED`, `caffeinate -d`):** rejected. Nothing on the screen is needed while an attempt runs.
