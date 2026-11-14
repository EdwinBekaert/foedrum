# 0395. The Maltster maps the code an order touches before the Gauger, on the explorer alias

Date: 2026-11-14 · Status: Accepted · Amends [0298](0298-the-maltster-s-survey-ends-without-a-session-for-a-fresh-map-and-its-check-sends-a-disagreement-back-once.md) (the Maltster gets a second step in the test-first recipes, beside its survey) [0153](0153-foedrum-s-defaults-map-their-own-model-aliases.md) (a third default alias, `explorer`) and [0366](0366-deep-brew-builds-a-change-that-can-reach-a-lot-through-every-diff-lens-and-a-blocking-brett-step.md) (Deep-brew's steps from the survey to green, which hold the map step)

## Context
Every brewer reads and searches the code itself, on its own model alias.
Measured on 2026-11-14 over 117 brewer transcripts of the self-brew trial, by the text size of tool results: reading and searching (`Read`, `Grep`, `Glob`) were 70% of the Gauger's tool output (17 sessions, about 77k tokens of context at their end on average), 82% of Cellarman's (14, 53k) and 53% of the Finer's (9, 27k).
The glossary gives the Maltster context gathering; its one file proposed the test map in the `survey` step ([ADR 0298](0298-the-maltster-s-survey-ends-without-a-session-for-a-fresh-map-and-its-check-sends-a-disagreement-back-once.md)).

A search helper inside a brewer's session does not work, as tried on 2026-11-14 with claude 2.1.310 and a brewer's flags.
`--safe-mode`, which every brewer runs with ([ADR 0042](0042-the-claude-command-line-and-stream-contract.md), [ADR 0049](0049-reviewers-read-only-inside-the-checkout.md), kept in [ADR 0381](0381-a-brewer-that-writes-code-runs-the-quick-checks-before-its-end-and-is-sent-back-once.md)), leaves out a subagent passed with `--agents` and a tool server passed with `--mcp-config`.
Without `--safe-mode`, the subagent ran in the background, the stream held two `result` events, and `usage` counted the main session only.
So the search runs as a step of its own, and `--safe-mode` and the claude command line stay as they are.

## Decision
- **A second Maltster file, `defaults/brewers/maltster-map.md`.**
  It is the same Maltster in the glossary, the docs and the status lines, with its own instructions, out doc and tools.
  It reads the order, and a sub-order's plan entry, and searches the code read-only (`access: read`, on the task tree).
  It answers with a map in its out doc's body: one line per place, a path with its lines where they are a part of the file, and why the place matters to the order, under `Code`, `Tests` and `Docs`, 60 places at most.
  It judges nothing and writes no code. Its tools are `Read`, `Grep`, `Glob` and `Edit(map.md)`, as the Brewmaster's are.
  Like every read-only brewer it is still given the repository's commands; its prompt says it runs none, and taking them away is an engine change outside this decision.
- **Its out doc has no schema of its own.**
  Its `output.schema` is `map`, a name no code knows, so the attempt reads it against the contract's schema: status, summary, assumptions and handover.
  Nothing reads the map's lines but the brewers it is passed to, so a schema of its places would check what no code uses.
- **The `explorer` alias**, `haiku` in `defaults/models.jsonc`, beside `builder` and `planner`. `maltster-map` names it, and a Brewery's `models.jsonc` can map it to another model as it can the others.
- **A `map` step in `nip` and `deep-brew`**, after `survey-check` and before `gauge`, with no `when`.
  It runs with test-first off too, since Cellarman then still reads it.
- **The Gauger, Cellarman and the Finer read the map** as an input, `{ "name": "map", "from": "step:map" }`, and their prompts say: start from it, and search further only where it falls short.
  The Finer's search for duplication still covers the whole repository.
  Each raises its `version`.
- **A map that fails, or finds nothing.**
  The map step is a brewer step like any other: an attempt that fails is tried again, and after `maxAttempts` (2) the batch is Stuck.
  It is one more place where a batch can go Stuck, which is accepted until a measure says otherwise.
  A map that finds nothing, as for an order about a file that does not exist yet, still ends `done`, and its body says where it looked and where it expects the new code to go.
- **One map per run.** Every route in `nip` and `deep-brew` goes back to `gauge` or `implement`, both after `map`, so a round back keeps the first map: the input reads the step's latest success.
- **Where it shows.** The status comment, the live line and the Stuck reasons name the step, `map`; `foedrum brewers` lists the file, `maltster-map`.

## Consequences
- A Brewery with its own `nip.jsonc` or `deep-brew.jsonc` gets no map until it adds the `map` step, and one with its own `gauger.md`, `cellarman.md` or `finer.md` reads none until it adds the input.
  A recipe without the step gives the input nothing, so such a Brewery works as before ([#774](https://github.com/EdwinBekaert/foedrum/issues/774)).
  No Brewery needs a migration: there are no users before the first publish (M7).
- Every brewed batch runs one more session, on the cheaper model, before the Gauger. Whether the brewers after it then search less is measured by #1055, not assumed here.
- The demo's own recipe, `nip-parallel`, runs the map step too, as it keeps Nip's steps.
- A Maltster session kept for the whole batch, which brewers ask between their turns, waits until real brews show how often the brewers still search after reading the map.
