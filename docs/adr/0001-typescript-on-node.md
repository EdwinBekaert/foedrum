# 0001. TypeScript, run by Node's built-in type stripping

Date: 2026-10-13 · Status: Accepted

## Context
Foedrum's core is a state machine whose correctness depends on handling every state and every step outcome. The ecosystem around Claude, GitHub and command-line tooling is strongest in TypeScript and Python. We want as few build tools as possible.

## Decision
- Write Foedrum in **TypeScript** with `strict` settings.
- Run it with **Node's built-in type stripping** (stable since Node 24.12). No bundler, no `tsx`, no `esbuild`.
- Use `tsc` only for type checking (and emitting `.js` for the published package, since Node does not strip types under `node_modules`).
- Restrict to erasable syntax: `erasableSyntaxOnly`, `verbatimModuleSyntax`, explicit `.ts` import extensions; no `enum`, no parameter properties, no decorators.
- Minimum runtime: **Node 24.15** (also required by `node:sqlite`, see 0002).

## Consequences
- Discriminated unions plus exhaustive `switch` with `never` turn a forgotten state or outcome into a compile error.
- One schema library (0004) produces types and runtime validation from the same definition.
- Contributors need nothing beyond Node to run the code.

## Alternatives considered
- **Plain JavaScript:** no compile-time exhaustiveness checks; the main stability tool is lost.
- **Python:** strong for evaluation work, weaker for a cross-platform CLI with a live web dashboard; two runtimes for users.
- **tsx / esbuild:** redundant now that Node strips types; both add install scripts and binaries.
