# 0402. tasting-compare --real tastes with a Taster setup built from settings

Date: 2026-11-16 · Status: Accepted · Amends [0394](0394-tasting-compare-real-runs-a-real-cellarman-on-a-model-and-effort-it-is-given.md) (`--brewer` takes `taster` too)

## Context
Each Taster setup of `--real` is a fixed profile: a new model, effort or Taster text meant a new profile in the code (#879, ADR 0344, ADR 0347, ADR 0348).
ADR 0394 gave Cellarman runs settings instead; #937 asks the same for the Tasters, so a new model is measured with no change to the script.

## Decision
- `--real --brewer taster --model <level or id> --effort <effort> --lenses apart|together --rules reads|bare` tastes the three heads with a setup built from these four settings.
- All four are required, with no default. `--lenses` and `--rules` are refused without `--brewer taster`, beside `--brewer cellarman` too; `--map`, `--order-text` and `--setups` are refused with it.
- The model is a level, which every Taster step names, or a model id, which the run's `models.jsonc` maps `strong` to, as ADR 0394 does for Cellarman; no other step moves. The effort is one of Foedrum's four (ADR 0397).
- The lenses are `real-nip`'s three, correctness, acceptance and security, a Taster each or one Taster for all. Design conformance is left out: #879's key and the records of the bare and together setups are on these three.
- `reads` is the fixture Taster that reads the rules (ADR 0352); `bare` is ADR 0347's cut of it, not the shipped `taster.md`.
- The setup's name is the order and all four settings, such as `855-taster-claude-opus-5-5-full-together-bare`, and each record keeps them in its `taster` field.
- A run stops the comparison on a model its settings did not ask for: a level asks for the family `defaults/models.jsonc` maps it to, an id for itself or a dated snapshot of it (ADR 0344, ADR 0394).
- Its records go in the same folder as the fixed setups', and the same lists score its runs. The lists name no setting; `codes.md` keeps its ten columns, its Setup cell naming the settings and its Model cell the model each transcript names. The table lists its rows after every fixed setup's.
- Every fixed `--setups` profile runs as before.

### A Brewery's files
None: this is a script of Foedrum's own repository, and no Brewery file changes, so no Brewery needs a migration.

## Consequences
- A new model or effort is tasted with a command line, not a new profile.
- A settings run and a fixed profile with the same settings are two setups with two names, each with runs of its own.
