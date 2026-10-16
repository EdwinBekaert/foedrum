---
name: brew-sheet
description: Explain a part of Foedrum (a module, a flow, an ADR, an issue or a pull request) with one verified visual instead of prose. Use on "explain", "how does X work", "what does this do", "I don't get it", and for the "How it works" section of a pull request or issue.
argument-hint: "[topic, file, symbol, #issue or #pr; blank = the topic under discussion] [--mermaid]"
allowed-tools: Read, Grep, Glob, Bash
---

# Brew sheet

A brew sheet is the one page a brewer keeps for a brew. This skill writes one for a part of
Foedrum: the smallest picture that lets a person understand it quickly. It is not a complete
description. No preamble, and never announce the picture.

The topic is in `$ARGUMENTS`. When it is blank, explain what is being discussed. `--mermaid` is a
render flag, not part of the topic.

## Read first, then draw

Everything in the picture comes from files read in this session.

- Anchor real code with `file:line` the first time it appears: `src/engine/decide.ts:164`. No
  anchor means it was not read.
- Never infer structure from a file name, a test name or an earlier picture.
- A step you could not verify is left out, or marked `? unverified`.
- A picture of code that does not exist yet starts with `PROPOSED`.
- When the topic is decided in an ADR, read the ADR and the ADRs that amend it (the status line
  names them) before drawing; the newest one wins.

## One line before the picture

One sentence that gives the reader a handle. It does three things:

- **Premise first.** Say what the part is in Foedrum and why it exists, then how it works. For an
  issue or pull request, first name the part of Foedrum it touches and what that part is, then
  what the issue asks or the pull request changes.

  > ✘ #98 adds a routing deadline to `batch.ordered`.
  >
  > ✔ Every waiting batch has a deadline, so none can sit silently (invariant I1); an Ordered batch
  > had none, and #98 gives it one.
- **One altitude.** System, module or function: pick one from the reader's words and keep to it.
- **Bridge the words.** Map the reader's word to Foedrum's once ("the queue" is the Ordered lane,
  "the agent" is a brewer), then use Foedrum's. The glossary (`docs/glossary.md`) has the terms.

State Foedrum's own facts plainly, each once, with its anchor. Do not explain general concepts
(git, event sourcing, OAuth, JSON Schema): the reader knows them. Before sending, list every
Foedrum-specific fact the picture depends on; each must be said in a sentence, in the line above
or as a note in the picture. A name in a diagram does not tell the reader what it means.

## Pick one form

| The question sounds like                  | Form                                  |
|-------------------------------------------|---------------------------------------|
| what does this do                         | pseudocode or a trimmed code block    |
| what runs when X                          | call tree with `file:line`            |
| who calls whom, where does data go        | sequence or flow                      |
| when does X happen, which case wins       | decision table                        |
| what state is a batch in after each event | state-at-each-step table              |
| where does this live, where do I add X    | file tree                             |
| what changes if we do X, what a PR changes | diff over the existing shape         |
| where does it break                       | divergence tree, `<-- HERE` on the step |

Prefer a decision table over a flowchart whenever the question is "when".

## Foedrum's shapes

These are what makes a Foedrum picture right or wrong:

- **Events are the truth.** State is a fold of the event log (`src/engine/fold.ts`); a picture
  of how state changes shows the events, not mutations.
- **Decide, then append.** `decide` takes the state and one command and returns events or a
  refusal; the guard (`admit`) checks every event before it is stored. Draw a command's path
  through both.
- **Pure core, thin shell.** Decisions live in pure functions; files, git and processes sit in a
  shell around them (ADR 0021). Show the boundary when the question crosses it.
- **Platforms differ.** Process starts, kills and paths go through `src/platform/`; say which
  platform a picture holds for when Windows and POSIX differ.

## Render

ASCII by default: it reads the same in a terminal, an editor and the web. Use mermaid only with
`--mermaid` or when asked in words ("for the PR", "as mermaid"), for text that goes to GitHub, where
it renders.

## Budget

- One picture; two only when they show two genuinely different layers.
- At most 25 lines and 90 columns. Over budget, leave nodes out; never shrink to a summary.
- At most two sentences before the picture (three when one states the premise), and nothing after
  it unless a caption earns its line.
- When the reader says they are lost, go one altitude up with fewer nodes; never redraw the same
  detail in another form.
- When the answer fits in one sentence, write the sentence.

## In a pull request or an issue

The "How it works" section of a pull request or issue is a brew sheet in mermaid: the premise line,
then one picture of the change (a new flow, a state change, a new module layout), or no picture
when the change has no shape. It explains; the summary of what changed, the tests and the review
stay where they are.

## Close

One line, or nothing: the ADR or issue to read next when an obvious one exists.
