// Decides whether a pre-existing issue draft of /brew-review can be filed as it is (issue #267).
// Stage 6 sends the draft to GitHub with `gh api --input`, and the approval prompt shows only the
// file's path, so a model-written draft with extra keys or a multi-line title would be sent as it
// is. This file imports nothing, so the review skill can run it from its criteria copy.

export type DraftCheck = { ok: true; title: string } | { ok: false; problems: string[] };

// Checks the text of a draft file: one line per problem, or the title it would file.
export const checkDraft = (_text: string): DraftCheck => {
  throw new Error('not implemented');
};
