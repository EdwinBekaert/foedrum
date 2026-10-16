// The claude versions the settings proof of ADR 0046 ran against (#128, ADR 0048).
// test/integration/claude-cli.test.ts is the proof: rerun it against a new version before
// widening the range.

/** The proven versions, both ends included. */
export interface VersionRange {
  from: string;
  to: string;
}

export const PROVEN_CLAUDE: VersionRange = { from: '2.1.301', to: '2.1.301' };

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** The three parts of a version, or `undefined` when it is not one. */
const partsOf = (version: string): [number, number, number] | undefined => {
  const match = VERSION.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** Negative, zero or positive as `a` comes before, with or after `b`, part by part. */
const compare = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < 3; i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** Whether `version` (`major.minor.patch`) lies in `range`; what is not a version does not. */
export function isProvenClaude(version: string, range: VersionRange = PROVEN_CLAUDE): boolean {
  const parts = partsOf(version);
  const from = partsOf(range.from);
  const to = partsOf(range.to);
  if (parts === undefined || from === undefined || to === undefined) return false;
  return compare(parts, from) >= 0 && compare(parts, to) <= 0;
}

/** The proven range as people read it. */
export const provenClaudeText = (range: VersionRange = PROVEN_CLAUDE): string =>
  range.from === range.to ? range.from : `${range.from} to ${range.to}`;

/** What doctor and the runner say about a claude outside the proven range. */
export const unprovenClaudeText = (version: string): string =>
  `claude ${version} is not a version Foedrum proved its brewer settings on (${provenClaudeText()})`;

/** The warning for a claude outside the proven range, or `undefined` inside it. */
export function unprovenClaudeWarning(version: string): string | undefined {
  if (isProvenClaude(version)) return undefined;
  return `${unprovenClaudeText(version)}: a permissions.allow or env in your Claude Code user settings may widen what a brewer may do (ADR 0046)`;
}
