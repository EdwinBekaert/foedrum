# 0346. The live line runs from a brew's first second to its last, with `gh`'s moving mark

Date: 2026-11-07 · Status: Accepted · Amends [0174](0174-foedrum-brew-keeps-a-live-line-on-a-terminal.md) (the live line also runs while no attempt runs, a parallel group shares it by giving up parts together, the mark may be braille and turns on its own timer, the plain lines name attempts that ended before a line was said, and `foedrum serve` says it is alive), [0179](0179-the-live-line-redraws-in-place-and-leads-with-the-batch-s-time.md) (a redraw comes more often than once a second, only the first column changes between two seconds, and a group gives up parts before the cut from the end), [0326](0326-the-live-line-says-what-its-first-time-measures.md) (`brew started` also holds before the batch is known) and [0123](0123-foedrum-brew-drives-one-batch-under-an-owner-of-its-own.md) (what `foedrum brew`'s lines name)

## Context
The self-brew trial (#374) and the real brew of #905 showed `foedrum brew` and `foedrum mash` looking idle while they work. Nothing showed for routing, setup and the status comment until the first attempt: ADR 0174 draws the attempts that run, so a line with none was cleared. Three attempts of a parallel group did not fit the line, which ADR 0174 cuts from the end, and the last Taster's wait, opening the pull request and the cleanup showed nothing. The plain lines lost a group too: a line is said after a tick, by which time two of three Tasters had ended. `foedrum serve` printed nothing between passes.

The maintainer asked for the moving mark `gh` shows while it waits, on every wait in the brew. ADR 0174 rejected a braille spinner on #442, in line with the ASCII of `foedrum status`, and redraws `| / - \` once a second.

`gh` (read in its source, `pkg/iostreams/iostreams.go`) uses the `briandowns/spinner` library's character set 11, `⣾⣽⣻⢿⡿⣟⣯⣷`, at 120 ms a frame, and writes its whole line each frame: a carriage return, an erase on a terminal that reads it, then the text. On Windows it draws the same frames in any console.

## Decision

### What the line says when no attempt runs
- The live line is drawn from the command's first call to its last, and says what the command does in place of the attempts: `starting`, `routing`, `claiming <issue>`, `opening the Brewery issue`, `writing the status comment`, `opening the pull request`, `cleaning up the worktrees of the batch`, `reading its pull requests`, `reading its labels`, or, for any other effect, `applying <effect>`.
- With nothing to name and no attempt running it says `between steps`.
- Before the batch is known the batch's time says `brew started` (ADR 0326).
- While a call takes time, the line is redrawn each second beside it (`lively` in `src/cli/brew.ts`); a call that takes no time reaches no wait.
- The words stand in for the attempts until that tick ends, also while attempts run: for those seconds the line says what the command does.
- The line is for display. A redraw that throws, wherever it comes from (beside a call, a lasting line, a resize, the mark's timer), is dropped: it changes no call, no exit code and no effect. A failing store still fails the brew's own read, which says so.

### What the driver tells it
- `DriverOptions.doing` and `WiringOptions.doing`, optional, take a `Doing`: `{ kind: 'effect', key }` or `{ kind: 'clean' }`. The driver calls it before it applies an effect or cleans a batch.
- It is a report for display: it changes no state, appends no event and decides nothing, and a throw from it is dropped, as one from `report` is. A driver without it behaves the same, so `foedrum serve` passes none.

### A parallel group on one line
Attempts side by side give up their last parts together, so a turn and a tool go before any attempt's name, and the cut from the end of ADR 0174 applies only when even the names do not fit.

### The mark
- On a terminal that shows them, the mark is `gh`'s eight frames, `⣾⣽⣻⢿⡿⣟⣯⣷`, turning every 120 ms. This replaces ADR 0174's rejection of a braille spinner for the mark alone, since the maintainer asked for it and a terminal that cannot show it keeps the ASCII frames.
- Only the mark changes. The rest of the line stays ASCII, by ADR 0174's rule, and a frame a model wrote into a tool's name shows as `\u28fe`.
- It is written in place of the line's first column, after the line is fitted, so it takes one column of the width less one. A braille frame is one column wide.
- Off a terminal nothing changes: no mark, no timer, the plain lines.

### Which terminal shows it
`marksOf` in `src/cli/live-terminal.ts` decides, from the environment, as `noSessionsOf` in `src/cli/brew-main.ts` does: it only chooses text, so it is not platform behaviour for `src/platform/`:
- **Windows:** braille only where the terminal says what it is: `WT_SESSION` (Windows Terminal) or `TERM_PROGRAM=vscode`. Any other console keeps `| / - \`. Node writes to a console in UTF-16 whatever the code page, so it is the font that decides, and a console's font is not a thing Node can ask. On the machine this was checked on, Consolas, Lucida Console and Courier New hold none of the eight frames and Segoe UI Symbol holds all of them (read from the font files).
- **macOS and Linux:** braille when the first of `LC_ALL`, `LC_CTYPE` and `LANG` that is set and not empty says UTF-8, and `TERM` is not `linux`. In another locale a frame would show as three characters and wrap a full line, and the Linux console's font has none.

This differs from `gh`, which draws braille in every console and shows a box where a font lacks the frame.

### What a turn costs
- The mark turns on a timer of its own, which writes the line last fitted with the next frame. It reads no state and no attempt's progress: those stay at once a second, as does the fit to the terminal's width (and at once on a resize).
- The driver's tick does not move: the brew's own loop keeps its five waits of a second, and the mark's timer shares no wait with it. A timer that fires late only makes the mark late.
- A turn is what a redraw of ADR 0179 is: `cursorTo(0)`, the text, `clearLine(1)`, so it never shows blank. At 120 columns that is about 1 KiB a second to the terminal, the same as `gh` writes for a line of that width.
- The foreground gate of ADR 0222 holds it as it holds every rewrite while `claude` has the terminal.

### What the plain lines name
A run names, as `<step> #<n> started`, every attempt that started since it began, even one that ended before a line was said, on a terminal or not. An attempt that started before this run, seen after a `retry`, a takeover or a brew of an on-tap batch, is not named: it did not just start.

### `foedrum serve`
After 60 s with no line of its own, `foedrum serve` prints `foedrum serve: still running for <brewery>`, at most once in those 60 s. The words hold whether a batch brews or none does. It keeps its plain lines and touches no terminal (ADR 0174).

## Consequences
- A brew on a terminal shows that it lives in every wait, from its first second to its last.
- A terminal gains `marks`, so a new `LiveTerminal` says which frames it shows.
- A person in a Windows console other than Windows Terminal or VS Code's sees the ASCII mark; there is no way to ask for braille there. A terminal that shows braille but says nothing of itself (another terminal on Windows, or a Unix locale that is not UTF-8) gets ASCII too. That is a mark less pretty, never a broken line. The other way round, a console opened from Windows Terminal or VS Code's terminal inherits their variable and gets braille, which its font may show as boxes: the line keeps its layout, as in `gh`.
- **Migration:** none. Nothing here is read from a Brewery's files or recorded in the events, so an existing Brewery does nothing. A log that greps `foedrum serve`'s lines sees one more line a minute on a quiet Cellar.

## Alternatives considered
- **Redraw the whole line eight times a second, reading the state each time:** rejected. A reading of the store and of each attempt's progress buys nothing a person can see between two seconds.
- **Count faster redraws towards the tick:** rejected. The tick's five waits would become about forty-two, and each real timer's lateness (up to about 15 ms on Windows) would add to it, so the tick would move with the mark.
- **Write only the mark's cell:** rejected. It leaves the cursor in the line's first column or needs a second move back, and a whole line each frame is what `gh` writes.
- **Braille on every terminal, as `gh` does:** rejected. In a console whose font lacks them each frame is a box that does not move in any way a person can read, which is the idle look this change exists to end.
- **A live line in `foedrum serve`:** rejected, as in ADR 0174: a service's output is mostly read as a log.
- **`still brewing for <brewery>`:** rejected. It is false while nothing brews.
