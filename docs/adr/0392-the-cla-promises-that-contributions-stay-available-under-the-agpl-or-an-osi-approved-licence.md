# 0392. The CLA promises that contributions stay available under the AGPL or an OSI-approved licence

Date: 2026-11-13 · Status: Accepted · Amends [0391](0391-contributors-sign-a-cla-licence-grant-in-a-signatures-file-and-ci-checks-the-pull-request-s-author.md) (the licence grant carries a promise back to the contributor) and [0009](0009-agpl-and-cla.md) (a relicensing keeps an open-source licence beside it)

## Context
[ADR 0391](0391-contributors-sign-a-cla-licence-grant-in-a-signatures-file-and-ci-checks-the-pull-request-s-author.md) made `CLA.md` a licence grant that lets the maintainer license contributions under any terms, commercial ones included.
It promised the contributor nothing back: a contribution could later be distributed under a closed licence only.
A contributor signs more readily when their work cannot be closed.
The maintainer decided on #1041 (2026-11-13) that the CLA adds an outbound promise, as the Harmony agreements do.

## Decision
- **The promise:** a paragraph at the end of section 2 of `CLA.md`.
  Whenever the maintainer distributes a contribution, alone or as part of Foedrum, it is also available under the GNU Affero General Public License the project uses on the date it was submitted, or under any licence approved by the Open Source Initiative.
  It holds also when the maintainer licenses the contribution under other terms, commercial ones included.
- **The wording:** adapted from section 2.3, "Outbound License", of the Harmony Combined Contributor Agreement Template 1.0 (CC BY 3.0): option five's structure (any licence, with the promise of the project licence as well) and option three's set of licences (the project licence or any OSI-approved licence, permissive or copyleft, even if later disapproved).
  The changes list at the end of `CLA.md` names the template and its licence.
- **The version stays 1.0:** `.github/cla-signatures.md` holds no signature yet, so no one signed the text without the promise.

## Consequences
- The commercial licence ADR 0009 keeps open stays open, beside the AGPL or another open-source licence, never instead of one.
- A relicensing of Foedrum away from the AGPL stays possible, but only to an OSI-approved licence for code that holds contributions.
- The lawyer's reading that ADR 0391 asks for before the first outside pull request covers this paragraph too.
- The CLA check and the signatures format do not change.
- A Brewery needs no migration: nothing a Brewery holds or does changes.

## Alternatives considered
- **Harmony option three as written:** "only under" the project licence or an OSI-approved licence, which would remove the commercial licence that ADR 0009 keeps open.
- **Harmony option five as written:** promises only the project licence on the date of submission, so a later move to another open-source licence would need each contributor again.
- **No promise:** what ADR 0391 had; a contributor's work could be closed.
