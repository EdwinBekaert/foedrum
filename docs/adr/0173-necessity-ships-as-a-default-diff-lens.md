# 0173. Necessity ships as a default diff lens

Date: 2026-10-24 · Status: Accepted · Amends [0022](0022-five-default-lenses.md) (the list of default lenses)

## Context
[ADR 0022](0022-five-default-lenses.md) ships five default lenses: correctness, security, cross-platform, design conformance and test design.
`/brew-review` tastes Foedrum's own pull requests through every shipped lens (`defaults/lenses/diff/*.md`), so each Foedrum pull request exercises the prompts Foedrum ships ([ADR 0017](0017-test-first-recipes-and-tasting-lenses.md)).
Next to them it ran one lens of its own, **necessity** (`.claude/skills/brew-review/lenses/necessity.md`, #352): every new safeguard needs proof that it is needed and must not duplicate one already in place.
#352 kept it in the skill, like simplify, with no recorded reason.

The lens's questions apply to any repository: proof of need, the layer that already owns the risk, the same work done twice, cost against benefit, and safeguards the issue did not ask for.
Only its references were Foedrum's: `docs/trust-boundaries.md`, `docs/design/security.md` and the local gate.
A Brewery whose brewers add retries, guards and checks gets no review of whether they are needed, although the prompt for it exists and is exercised on every Foedrum pull request.

On 2026-10-24 the maintainer decided that every lens that judges a change ships.
Simplifying is no longer a lens: the Finer applies it before review (#455).

## Decision
- A sixth default lens, **necessity** (`defaults/lenses/diff/necessity.md`), weighs every safeguard a change adds against its proof and against what already covers the same risk. The default lenses are now **correctness, security, cross-platform, design conformance, test design and necessity**. This amends the list in ADR 0022; everything else in it stands.
- The shipped lens names no Foedrum path: it looks for the owner of a risk in "the repository's trust-boundary or security document, when it has one", and for existing layers in the repository's own checks, CI, rules and reviews. Its findings use the severities of every lens (`blocker`, `major`, `minor`).
- Each of the other five lenses names necessity in its "Leave to other lenses" section, and necessity names them in its own, so no two lenses report one gap.
- Foedrum's own rule stays where it is: CLAUDE.md's "a new safeguard needs proof" and `docs/trust-boundaries.md` are the documents the shipped lens finds in this repository.
- `/brew-review` stage 3 tastes through the shipped lenses only (`defaults/lenses/diff/*.md` from the criteria), and its missing-lens check counts the six. `.claude/skills/brew-review/lenses/necessity.md` is removed.
- No default recipe adds the lens to a step: a Brewery's recipe names it as `"lens": "diff/necessity"`, as it names any other.

## Consequences
- `/brew-review` starts as many Tasters as before: it already ran necessity, and now reads it from `defaults/`.
- A change to the lens is a change to a shipped default, and is exercised on the planted-defect sample (`test/fixtures/brew-review/planted-demo`) before it merges, like the other five.
- `foedrum doctor` lists `defaults/lenses/diff/necessity.md` in `Defaults in use`, since it lists every file of `defaults/` the Brewery has no file of the same name for (ADR 0098).
- A Brewery that wants its own version of the rule commits `lenses/diff/necessity.md`, which replaces the default.

## Alternatives considered
- **Keep it in the skill:** no change, but a lens that judges any change stays out of reach of every Brewery, and Foedrum's review runs a prompt that no Brewery can use.
- **Ship it and add it to the default recipes' tasting steps:** every Brewery would pay for one more session per tasting; a recipe that wants it names it, as it names any lens.
- **Ship it with Foedrum's paths:** a Brewery's Taster would look for files its repository does not have.
