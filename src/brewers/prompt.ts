// Brewer prompt assembly (ADR 0041): the one place where input text enters a brewer's prompt.
// Every input goes between tags with a fresh random nonce, after the brewer's instructions and the
// rule that says the tagged text is data. A mitigation, not the security boundary.

import { randomBytes } from 'node:crypto';

/** Where an input's text came from; named in the tag's `source` attribute. */
export type InputSource =
  | { kind: 'issue-body'; issue: number }
  | { kind: 'comment'; issue: number; comment: number }
  | { kind: 'out-doc'; step: string }
  | { kind: 'file'; path: string }
  | { kind: 'house-yeast'; rule: string };

export interface PromptInput {
  /** The brewer's input name (`inputs[].name`, the `{variable}` in its body), when it has one. */
  name?: string;
  source: InputSource;
  text: string;
}

declare const assembled: unique symbol;
/** A prompt built by `assembleBrewerPrompt`; the brewer runner takes no other. */
export type BrewerPrompt = string & { readonly [assembled]: true };

export type PromptAssembly =
  | { kind: 'assembled'; prompt: BrewerPrompt; nonce: string }
  /** An input contains this prompt's nonce: by chance that never happens, so a likely injection. */
  | { kind: 'refused'; reason: 'nonce_in_input'; input: { name?: string; source: string } };

/** Random bytes from a CSPRNG; injected so tests can fix the nonce. */
export type RandomBytes = (size: number) => Uint8Array;

/**
 * Builds a brewer's prompt: its own instructions, the rule about tagged input, then every input
 * once, in order, between `<untrusted-input-<nonce> …>` tags with a new nonce for this prompt.
 */
export function assembleBrewerPrompt(
  _instructions: string,
  _inputs: readonly PromptInput[],
  _random: RandomBytes = randomBytes,
): PromptAssembly {
  throw new Error('not implemented');
}
