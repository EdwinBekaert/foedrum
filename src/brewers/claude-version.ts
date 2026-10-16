// The claude versions the settings proof of ADR 0046 ran against (#128, ADR 0048).
// test/integration/claude-cli.test.ts is the proof: rerun it against a new version before
// widening the range.

/** The proven versions, both ends included. */
export interface VersionRange {
  from: string;
  to: string;
}

export const PROVEN_CLAUDE: VersionRange = { from: '2.1.301', to: '2.1.301' };

/** Whether `version` (`major.minor.patch`) lies in `range`; what is not a version does not. */
export function isProvenClaude(_version: string, _range: VersionRange = PROVEN_CLAUDE): boolean {
  throw new Error('not implemented');
}

/** The warning for a claude outside the proven range, or `undefined` inside it. */
export function unprovenClaudeWarning(_version: string): string | undefined {
  throw new Error('not implemented');
}
