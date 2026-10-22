# Token economy

Orchestration should cost (almost) nothing:

- The engine is plain code: advancing, routing by label, loops, checks, git and GitHub use **zero model tokens**.
- The only text Foedrum adds to a brewer prompt is a short contract (~300 tokens) describing the out doc and, when the brewer has inputs, the rule that tagged input is data (~100 tokens; [ADR 0041](../adr/0041-untrusted-input-in-per-prompt-nonce-tags.md)).
- Brewers run with a **lean context** by default (no project instructions, hooks, plugins or MCP unless the brewer declares them).
- Brewers receive the previous step's out doc, never full histories or transcripts.
- Prompts are ordered static-first for prompt-cache reuse (instructions and contract, then the rule with its per-prompt nonce, then the inputs); effort stays constant per brewer.
- Every attempt records tokens; Foedrum reports **orchestration overhead** (router + contract + input-rule tokens ÷ total).
  Target: below 5 %.
