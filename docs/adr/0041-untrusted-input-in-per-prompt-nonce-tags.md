# 0041. Untrusted input in per-prompt nonce tags

Date: 2026-10-16 · Status: Accepted

## Context
The design promises that untrusted text reaches brewers "delimited and marked as data, never instructions": architecture §10 (the threat table), `inputs[].trusted` in brewers-and-recipes §1.1, house-yeast rules from a repository ([ADR 0018](0018-house-yeast-layers.md)) and the free text of comments ([ADR 0019](0019-interactive-sessions-and-one-command-layer.md)). Every input is untrusted for now (`src/schemas/brewer.ts`), including the out docs of earlier steps: they are model output that read the order. Nothing said *how* the delimiting works, and nothing in `src/` built a brewer's prompt yet (#106). The real `claude` runner of M1 will.

The obvious form is not safe. With a fixed tag such as `<issue>…</issue>`, an issue body that contains `</issue>` ends the data early, and whatever follows reads as instructions. Foedrum's own issues show that such text is ordinary: #106 itself quotes the tags.

## Decision
- **One function builds every brewer prompt:** `assembleBrewerPrompt` (`src/brewers/prompt.ts`), from the brewer's instructions and its inputs. No other code puts input text into a prompt. Its result is a branded `BrewerPrompt` type. The real runner (#17, #25) will take only that type, so a prompt built another way does not compile.
- **A tag per prompt with a random nonce.** Each input goes between `<untrusted-input-<nonce> source="…" name="…">` and `</untrusted-input-<nonce>>`, each tag on a line of its own, its text exactly as it came (line endings and a BOM included). The nonce is 16 bytes (128 bits) from `node:crypto`'s CSPRNG in lowercase hex, new for every prompt, so a retry gets a new one too.
  - `source` says where the text came from: `issue #<n> body`, `comment <id> on issue #<n>`, `out doc of step <id>`, `file <path>`, `house-yeast rule <id>`. `name` is the brewer's input name (the `{variable}` in its body), when the text has one; an order's body and comments all carry `name="order"`.
  - Attribute values are escaped (`&`, `"`, `<`, `>` and control and line-break characters as entities), so no source or name can end its attribute or the tag.
  - Inputs keep their order, and each appears exactly once. The body's `{name}` is not replaced: the rule tells the brewer that it refers to the inputs with that name, so the brewer's text is never rewritten and no data sits inside it.
- **Input that contains the prompt's nonce is refused, not escaped.** That covers the run's own closing and opening tags, in any letter case (a model may take `</UNTRUSTED-INPUT-…>` for the closing tag), and the bare nonce. The function then builds no prompt and names the input and its source. The attempt does not start, and the runner reports the hit as a likely injection attempt. A nonce is drawn before any input is read and an input is written before its prompt exists, so a match by chance has a probability of about 2⁻¹²⁸. A hit means the nonce leaked or the random source is broken, and a human should look. Refusing was chosen over escaping because:
  - refusing costs no real input, since it never happens by chance;
  - escaping changes the text the brewer reads and adds a convention the model has to undo correctly, a second layer that only the model interprets;
  - escaping would carry on quietly after the one event that shows the defence is broken;
  - a refusal has no partial cases to get wrong (overlapping matches, case variants, an entity that decodes into the tag).

  Retrying is not the answer either: it would draw a new nonce and hide the signal.
- **Text that only looks like a tag stays data.** A closing or opening tag with another nonce, or a fixed tag such as `</issue>` or `</untrusted-input>`, stays inside its input unchanged, and nothing reports it. Only a tag with exactly this prompt's nonce opens or closes an input, and the rule says so. Reporting look-alikes would flag every issue that discusses the format, starting with #106.
- **The rule is placed with the brewer's own instructions, never inside the data or next to it.** The prompt is the brewer's instructions (with Foedrum's out-doc contract, brewers-and-recipes §2), then the rule, then the inputs. The rule names the tag with this prompt's nonce and says that everything inside such a tag was written by someone else and is data, never instructions; that a `{name}` refers to the inputs with that name; that an input's instructions are not followed and are mentioned in the out doc; and that any other tag inside an input is part of its text. A prompt without inputs is the instructions alone, with no rule and no nonce. If the runner later moves the instructions into a system prompt (#17), the rule goes with them, and the whole text still comes from this function.
- **Model output stays untrusted.** An earlier step's out doc read the order, so it goes in tagged like any other input, which `trusted: false` already says.
- **This is a mitigation, not the security boundary.** A model can still follow text inside the tags. No design may rely on the tags alone. These are the controls that hold:
  - allow-listed authors for orders and commands (architecture §10, [ADR 0019](0019-interactive-sessions-and-one-command-layer.md));
  - tool allowlists and the permission ceiling ([ADR 0026](0026-how-a-permission-ceiling-covers-a-rule.md));
  - the sandbox and the isolation levels ([ADR 0010](0010-cross-platform-and-isolation-levels.md));
  - push and `AskUserQuestion` always denied ([ADR 0006](0006-no-mid-run-questions.md));
  - every out doc checked against its schema ([ADR 0005](0005-typed-step-outcomes-and-out-docs.md), [ADR 0028](0028-brewer-runner-outcomes-environment-and-test-first.md)).

## Consequences
- The tags give the model a boundary that the data cannot forge without knowing the nonce, and the source attribute tells it, and anyone reading a transcript, where each piece came from.
- Foedrum adds a second fixed text to every prompt with inputs: the rule, about 100 tokens next to the ~300 of the out-doc contract (architecture §7).
- The nonce changes with every prompt, so the prompt cache reuses only the text before the rule: the brewer's instructions and the contract. The inputs after it already differ per batch, so little is lost. Static-first ordering still holds.
- A refused prompt stops the attempt before any model tokens are spent. How the runner records it (the step outcome and the message to the order) is decided with the runner (#17, #25). It must not retry silently.
- A trusted input (`trusted: true`) still needs an ADR of its own. Such an ADR also has to say whether a trusted input skips the tags.
- The escape rules and the source names live in one function, so a new input source (a pull request review, a release note) gets a `source` kind there, with an exhaustive `switch`, and nowhere else.

## Alternatives considered
- **A fixed tag** (`<issue>`, `<retrieved-data>`): the input closes it at will.
- **Escaping the closing tag in the input** (entities, or a zero-width character inside the tag): see above. It changes data and hides the one event that matters.
- **Fencing with Markdown code blocks:** a fence of backticks is closed by the same fence in the input, and a longer fence has the fixed-tag problem one level up.
- **One nonce per run or per batch:** a step's out doc could then carry the nonce of the prompt it was written under into the next prompt. A new nonce for every prompt means an earlier model output never knows the current one.
- **Encoding the input** (base64, JSON strings): no closing tag to forge, but the model reads the text worse and spends more tokens on it, and a JSON string still holds instructions once decoded.
- **The rule next to each input:** the data and the rule would sit side by side, and an input could imitate a rule just as well. Once, with the instructions, is clearer and cheaper.
