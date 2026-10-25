# 0180. A brewed pull request quotes its Mermaid labels, or leaves the diagram out

Date: 2026-10-25 · Status: Accepted · Amends [0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md) (what the layout does with a Mermaid block in `howItWorks`)

## Context
A brewed pull request's `How it works` is Markdown the Cellarman wrote ([ADR 0167](0167-a-brewed-pull-request-follows-one-layout-and-opens-as-a-draft-unless-every-taster-approves.md)), often with a Mermaid picture.
ADR 0167 keeps a line in a fence as written, and `closedBlocks` makes sure a fence closes, not that GitHub can parse what it holds.
On the fifth brew (#479) the Cellarman wrote the diamond `B{name( at a place not after a letter, digit, _ or .}`, and GitHub showed `Parse error on line 2: … got 'PS'` instead of the picture.
An unquoted label with `(`, `;` or `#` has broken diagrams in session-written descriptions too.
GitHub offers no way to check Mermaid from outside, and the parser is an npm package with a large dependency tree, which [ADR 0004](0004-built-in-first-dependency-policy.md) rules out.
A label in double quotes is accepted whatever it holds, once a `"` in it is written as Mermaid's `#quot;`.

## Decision
- **Each ```` ```mermaid ```` block of `howItWorks` goes through one function (`quotedDiagrams`, `src/engine/pull-request.ts`) after its fences are paired (`closedBlocks`)**, and before its room is checked, so a block that quoting grows past 12,000 characters leaves the section out as before. A block is a top-level fence whose info string's first word is `mermaid`, in any case, with backticks or tildes; the other fences and the text outside them stay as they are.
- **It knows two kinds**, by the first line that is neither blank nor a `%%` comment:
  - `flowchart` or `graph`, with an optional direction. Every node label (`A[x]`, `A(x)`, `A{x}`, `A((x))`, `A(((x)))`, `A([x])`, `A[[x]]`, `A[(x)]`, `A{{x}}`, `A>x]`, `A[/x/]`, `A[\x\]`) and every edge label (`-->|x|`, and `-- x -->`, `== x ==>`, `-. x .->`, written as `-->|"x"|` and the like) that is not quoted yet is quoted, its `"` written as `#quot;`. An unquoted label ends at the first closer of its shape. A quoted label stays as it is. A line is a statement of nodes joined by links and `&`, with an optional `:::class` and a closing `;`, or `subgraph` with an id, a quoted title or an id and a `[title]`, `end`, `direction`, or `classDef`, `class`, `style` and `linkStyle` with only names, numbers and CSS values.
  - `sequenceDiagram`. The text of a message (after its `:`), of a note, of a block (`loop`, `alt`, `else`, `opt`, `par`, `and`, `critical`, `option`, `break`) and of a participant's alias (after `as`) has each `;` and `#` written as `#59;` and `#35;`, since Mermaid ends a statement at `;` and reads a `#` as the start of an entity. A line is one of those, `participant` or `actor`, `activate`, `deactivate`, `autonumber` or `end`.
- **A block of another kind, or with a line it cannot read as one of these forms, is left out whole, fence lines included, with one line in its place: `[left out: a diagram Foedrum could not check]`**, as the layout leaves out a fence it cannot pair. A `%%{` directive, front matter, `click` and the newer `A@{ … }` shapes are among the lines it cannot read.
- It reads each line once from left to right, each label up to its closer, so it is linear in the block, which is model output. No Mermaid package (ADR 0004).

## Consequences
- #479's picture renders: its diamond comes out as `B{"name( at a place not after a letter, digit, _ or ."}`.
- A diagram the Cellarman draws in a kind Foedrum does not read (a class, state or entity-relationship diagram, a pie chart) never renders in a brewed pull request; the rest of How it works stays.
- A label with a closer of its own shape inside it (`A(f(x))`), unquoted, makes the line unreadable and the diagram is left out. The Cellarman's prompt is unchanged: the engine quotes for it.
- A node id or a word Mermaid reserves (`end` as an id) is not checked, and may still break a picture.
- A `#` in a sequence label that the model meant as an entity (`#quot;`) shows as written.

## Alternatives considered
- **Leave it to the Cellarman's prompt.** It was told to draw a picture, and #479 shows a model writes an unquoted label; a prompt asks, the frame makes sure.
- **The Mermaid parser, or a grammar of our own for every kind.** A dependency ADR 0004 rules out, or a parser as large as Mermaid's; two kinds cover the pictures the Cellarman draws, and the rest fail closed.
- **Fence the picture as `text` when it cannot be checked.** The reader would see the source, which is longer and says less than the rest of How it works.
- **Quote only labels that hold a risky character.** Which characters are risky depends on the shape and the version of Mermaid; a quoted label is accepted whatever it holds.
