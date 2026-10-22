# Extensibility

1. **Files in the Brewery** — add or override brewers and recipes by committing files; review and evaluate them like code.
2. **Packs** (later) — declarative bundles of brewers, recipes and checks; no code.
   Installed from a git repository pinned to a commit SHA, with a checksum and a **permission ceiling** set by the Brewery, which covers a rule as [ADR 0026](../adr/0026-how-a-permission-ceiling-covers-a-rule.md) decides.
   Every pack ships evaluation samples.
3. **Visual** — recipes rendered as Mermaid early; a drag-and-drop recipe editor in the dashboard later, saving as a pull request to the Brewery.
