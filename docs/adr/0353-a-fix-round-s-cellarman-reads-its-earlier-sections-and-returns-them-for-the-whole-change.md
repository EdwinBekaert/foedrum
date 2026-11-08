# 0353. A fix round's Cellarman reads its earlier sections and returns them for the whole change

Date: 2026-11-08 · Status: Accepted · Amends [0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md) (the sections are the Cellarman's for the batch's whole change) and [0227](0227-a-later-round-renders-the-pull-request-s-body-again-unless-someone-edited-it.md) (the body rendered again describes the whole change, not the latest round's)

## Context
The pull request's How it works, Before and after and See it come from the sections the Cellarman wrote in its latest attempt that succeeded (`stepReports` and `pullRequestText`, `src/engine/pull-request.ts`), and a later round renders the body again ([ADR 0227](0227-a-later-round-renders-the-pull-request-s-body-again-unless-someone-edited-it.md)).
A fix round's Cellarman, sent back by a Taster's findings or a failed check, wrote sections about what it did in that round.
Those replaced the earlier ones, so the body described the fix and no longer the change as a whole (#928).
The prompt asked for "what the change does", without saying whose change, and a fix round had no way to see what its earlier attempt had written.

## Decision
- **A brewer input source `earlier-sections`**: `{ "name": "earlierSections", "from": "earlier-sections" }`, the sections of the latest earlier attempt of the same step that succeeded and wrote any (`earlierSectionsInput`, `src/engine/earlier-sections.ts`).
  An attempt that failed or wrote none is read past, as the body's own lookup now does (below).
  The text is How it works, See it and the rows of Before and after, each under its heading, and it is model text between the prompt's nonce tags like every input ([ADR 0041](0041-untrusted-input-in-per-prompt-nonce-tags.md)).
  The first attempt of a step has none, so the input is left out of its prompt.
- **The default Cellarman asks for it, and its prompt says its sections describe the batch's whole change**, from the commit the batch started at, and that a later round returns the earlier ones updated: what still holds kept, what its round made stale changed, what it added added. Its `version` is 13.
- **The engine renders the sections of the step's latest attempt that succeeded and wrote any** (`latestSections`, shared with the input), not those of its latest attempt that succeeded: a round that wrote none no longer leaves the body without How it works. The engine merges nothing; the round that returns the sections for the whole change is the one it renders.

## Consequences
- After any number of fix rounds, the body's sections describe the whole change as the last round's Cellarman saw it.
- A fix round that writes no sections leaves the body with the sections of the latest round that wrote some, where before it left the body without How it works.
- **Migration**: a Brewery with its own `cellarman.md` keeps its prompt, and with it the old behaviour, until it copies the new lines: the `earlierSections` input of its frontmatter and the paragraph that opens "The pull request's sections". Nothing else in a Brewery changes.

## Alternatives considered
- **The engine keeps the first round's sections and merges the fix's into them**: it cannot tell which parts of the first round's text a fix made stale, and it would merge Markdown and a table. The Cellarman sees its earlier text and the whole change, and returns one description.
- **The engine renders the first round's sections and the fix's side by side**: the body would then tell the story of the rounds, not describe the change a reviewer merges.
- **Only a prompt change**: without the earlier text a fix round would have to rebuild the sections from the diff and the order alone, and would lose what the first round knew.
