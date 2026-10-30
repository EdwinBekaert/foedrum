// The local gate's pre-filter (ADR 0056, ADR 0252): whether a hook input or a command may need
// the gate, and the quote folding it shares with the lexer in read.ts, so the two never drift.
// scripts/precheck.ts imports it statically, so it imports nothing.

// Case-insensitive because `GIT push` works on Windows; \u because JSON can escape any letter;
// push, merge and ready for a git or gh whose name is computed at run time; pwsh and powershell
// for an encoded command; npx, npm, dlx and bun for a package runner (#175).
const MAY_NEED_THE_GATE = /git|gh|push|merge|ready|pwsh|powershell|npx|npm|dlx|bun|\\u/i;
// A delete (rm, rd, ri, del, erase, Remove-Item) of a path that may hold a variable or a
// substitution ($, %, a backtick or PowerShell's ( ), read before the shells' characters are
// dropped) (#281), or a splat (@, #296).
const MAY_DELETE = /rm|rd|ri|del|erase|remove/i;
const MAY_COMPUTE = /[$%`(@]/;
export const mayNeedTheGate = (text: string): boolean => {
  const plain = normalised(text);
  return MAY_NEED_THE_GATE.test(plain) || (MAY_DELETE.test(plain) && MAY_COMPUTE.test(text));
};

// PowerShell reads typographic quotes as quotes; bash does not.
export const foldQuotes = (text: string): string =>
  text.replace(/[‘’‚‛]/g, "'").replace(/[“”„]/g, '"');

// The raw hook input, or its command, without the quotes and escape characters that bash,
// PowerShell and cmd drop, so a name they split (gi''t, g\it, g`it, g^h) still matches the
// pre-filter. A backslash before u stays, for a JSON escape. A line continuation (\, ` or ^ before
// a newline, also \r\n) goes first (#158).
export const normalised = (input: string): string =>
  foldQuotes(input)
    .replace(/[\\`^]\r?\n/g, '')
    .replace(/["'`^]|\\(?!u)/g, '');

// The raw hook input with JSON's \\, \n and \r escapes decoded, one escape at a time, so the
// pre-filter sees the line breaks of the command and never takes the n of \\npx for one (#158).
const JSON_ESCAPES = new Map([
  ['\\\\', '\\'],
  ['\\n', '\n'],
  ['\\r', '\r'],
]);
export const jsonLineBreaks = (input: string): string =>
  input.replace(/\\[\\nr]/g, (pair) => JSON_ESCAPES.get(pair) ?? pair);
