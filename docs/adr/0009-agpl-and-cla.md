# 0009. AGPL-3.0 with a Contributor License Agreement

Date: 2026-10-13 · Status: Accepted

## Context
Foedrum should be genuine open source — usable by individuals and inside companies — while preventing closed commercial resale, in particular offering a modified Foedrum as a hosted service without sharing the changes.

## Decision
- Code is licensed under **GNU AGPL-3.0**.
- Contributions require a **Contributor License Agreement**, so the project can later relicense or offer a commercial licence alongside the AGPL.
- The **name, logo and mascot** are not covered by the code licence; a trademark policy will govern their use.

## Consequences
- Anyone may use, modify and run Foedrum, including commercially; whoever offers a modified version to others, including over a network, must publish their source under the AGPL.
- Some companies avoid AGPL components in their own products; internal use of an unmodified or privately modified Foedrum is unaffected.
- Runtime dependency `zod` (MIT) is compatible. The `claude` CLI is installed by the user and not distributed with Foedrum.
- The CLA adds a small step for contributors; it must be in place before external contributions are accepted.

## Alternatives considered
- **MIT / Apache-2.0:** maximum adoption, no protection against closed resale.
- **Functional Source License, Elastic License 2.0, PolyForm Shield:** stronger non-compete protection, but not open source by the OSI definition, which reduces community trust.
- **PolyForm Noncommercial:** forbids use at work, which would block adoption by the engineers Foedrum is built for.
