# Token economy

Orchestration should cost (almost) nothing:

- The engine is plain code: advancing, routing by label, loops, checks, git and GitHub use **zero model tokens**.
- The only text Foedrum adds to a brewer prompt is a short contract (~350 tokens, [ADR 0308](../adr/0308-a-taster-reads-the-checks-that-ran-on-its-head-and-an-out-doc-claims-only-what-its-session-did.md)) describing the out doc and, when the brewer has inputs, the rule that tagged input is data (~100 tokens; [ADR 0041](../adr/0041-untrusted-input-in-per-prompt-nonce-tags.md)).
- Brewers run with a **lean context** by default (no project instructions, hooks, plugins or MCP unless the brewer declares them).
  A Taster whose lens asks for the repository's rules, such as design conformance, spends tokens to read them itself: that is a cost of its prompt, read per session, the whole instruction file and then what it or the changed code names for the files the change touches, not a cost of what loads ([ADR 0331](../adr/0331-a-taster-on-a-diff-reads-the-repository-s-rules-as-its-standard.md), [ADR 0352](../adr/0352-nip-s-correctness-acceptance-and-security-tasters-run-at-high-effort-without-the-rules-read.md)).
- Brewers receive the previous step's out doc, never full histories or transcripts.
- Prompts are ordered static-first for prompt-cache reuse (instructions and contract, then the rule with its per-prompt nonce, then the inputs); effort stays constant per step: its brewer's, or the step's own.
- Every attempt records tokens; Foedrum reports **orchestration overhead** (router + contract + input-rule tokens ÷ total).
  Target: below 5 %.
- `foedrum status <order>` shows what an order's **planning** took (the attempts scheduled under `mash`, `decoction` or `mash-in`) apart from its **brewing** (every other attempt of the order and its sub-orders), in tokens, never a cost ([ADR 0295](../adr/0295-foedrum-status-order-shows-planning-tokens-apart-from-brewing-tokens.md)).
