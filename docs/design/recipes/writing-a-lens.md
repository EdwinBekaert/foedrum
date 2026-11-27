# Writing a lens

A **lens** is one Markdown file that tells a Taster what to look for in a review, and only that.
This page is for a person who wants a lens of their own: it starts from a copy of a default lens, as [ADR 0440](../../adr/0440-a-person-writes-a-lens-from-a-copy-of-a-default-lens.md) decides, so Foedrum ships no separate example.
How the engine runs a lens step is [tasting](tasting.md)'s.

## The two folders

A Brewery keeps its lenses in two folders, by what they review ([ADR 0143](../../adr/0143-lenses-in-two-folders-diff-and-plan.md)):

- `lenses/diff/<name>.md` reviews a diff, the code a batch changed;
- `lenses/plan/<name>.md` reviews a plan, an order's breakdown into sub-orders.

A lens is named by its folder and file name, `diff/necessity` or `plan/coverage`.
A file with the name of a default replaces that default whole; a file with a name no default has adds a lens ([ADR 0098](../../adr/0098-foedrum-s-defaults-load-under-the-brewery-s-files-and-a-brewer-input-can-name-a-lens.md)).
A lens file directly in `lenses/` fails the load.

## What a lens file holds

The default lenses in [`defaults/lenses/diff/`](../../../defaults/lenses/diff/) and [`defaults/lenses/plan/`](../../../defaults/lenses/plan/) share one shape, and a lens of your own does well to keep it:

- a title, `# Lens: <name>`, and an opening paragraph that says what the lens reviews and to stay inside it;
- **Look for**: the defects it asks the Taster to find, each with what counts as one;
- **Do not**: what the Taster must leave alone, such as arguing against what it should not weigh;
- **Leave to other lenses**: what the other lenses report, so two lenses do not report one defect;
- **Reporting**: what each finding of this lens names.

A lens holds no severity, no verdict and no `introduced` mark.
Those come from the Taster's prompt, [`defaults/brewers/taster.md`](../../../defaults/brewers/taster.md), and its out doc ([out doc](out-doc.md)); read them there.

## Where a lens is named

A lens does nothing until something names it, in one of three places:

- **A recipe step** with a Taster: `"lens": "diff/<name>"`, or `"lenses": ["diff/a", "diff/b"]` for one Taster that reviews through several together ([lenses together](tasting.md#lenses-together), [ADR 0220](../../adr/0220-a-taster-s-step-can-run-several-lenses-together.md)). A step that reviews a diff names `diff/` lenses and a plan step `plan/` lenses; a lens no file holds fails the load, naming the step.
- **A brewer's input**: `{ "name": "style", "from": "lens:diff/<name>" }` puts the lens's text in that brewer's prompt, for a brewer that is no Taster.
- **A house-yeast rule's scope**: `"scope": { "lens": "<name>" }`, a bare name or `diff/<name>`, gives the rule to the Taster that reviews through that lens ([configuration files](configuration.md), [ADR 0169](../../adr/0169-house-yeast-rules-reach-a-batch-s-brewers-by-scope-and-lens.md)).

`foedrum doctor` gives a notice for a Brewery lens that no recipe step or brewer names ([ADR 0141](../../adr/0141-doctor-reports-prompt-sizes-unused-files-and-what-a-brewery-file-drops-from-its-default.md)).

## An example: a copy of `necessity`

1. Run `foedrum doctor`. Its `Defaults in use:` line lists `defaults/lenses/diff/necessity.md`, the default lens to start from.
2. Copy that file to your Brewery as `lenses/diff/<your-name>.md`, under a name no default has, and change what it looks for: its title, its opening paragraph and its "Look for" section first.
3. A Brewery recipe replaces the default recipe of its name whole ([recipes](recipes.md)). So copy the recipe you brew with, such as [`defaults/recipes/nip.jsonc`](../../../defaults/recipes/nip.jsonc), to `recipes/nip.jsonc` in your Brewery, and add a Taster step to its `taste` group:

```jsonc
{
  "id": "<your-name>",
  "brewer": "taster",
  "model": "standard",
  "effort": "moderate",
  "lens": "diff/<your-name>"
}
```

The step takes the group's `onFindings` route, and the next `foedrum doctor` no longer reports the lens as unnamed.

## How its findings go back

Every finding of a Taster's step goes back along one `onFindings` route, the group's or the step's own, to the brewer that route names; that brewer fixes or dismisses each finding, and after the route's rounds the batch is Stuck with the findings still open ([ADR 0354](../../adr/0354-every-finding-of-a-taster-goes-back-along-one-on-findings-route.md)).
This replaced the rule of [ADR 0161](../../adr/0161-lens-steps-run-a-taster-whose-findings-are-advisory-unless-the-step-blocks.md) that a lens step's findings only advise unless the step blocks: a Taster's step with `blocking` fails the load.
A lens that finds little costs its tokens and sends nothing back; a lens that finds a lot sends the batch back often, so write "Look for" as narrowly as the defect you mean.

## What a lens costs

`foedrum lenses` prints each lens with its file, then the rounds its steps took, its findings by severity, how they ended (fixed, dismissed, pre-existing, open) and the tokens its steps used, from the batches that ran it ([ADR 0221](../../adr/0221-foedrum-lenses-reports-each-lens-s-findings-their-ends-and-its-tokens.md)).
