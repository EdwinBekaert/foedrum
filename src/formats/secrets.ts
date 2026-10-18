// What looks like a secret in text: tokens, keys, credential assignments and long random strings,
// one match per line. Pure. scripts/secret-scan.ts uses it before /brew-review posts a summary, and
// a gravity reading before a check's output reaches the event log (ADR 0069).

export interface SecretMatch {
  line: number;
  kind: string;
  excerpt: string;
}

export type IsCommit = (sha: string) => boolean;

interface Pattern {
  kind: string;
  regex: RegExp;
}

// Specific patterns first: a match covers its text, so the generic ones below never report it twice.
const PATTERNS: Pattern[] = [
  { kind: 'GitHub token', regex: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g },
  { kind: 'GitHub fine-grained token', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'npm token', regex: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: 'API key', regex: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'AWS access key id', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'npm auth token', regex: /_authToken\s*=\S*/g },
  { kind: 'credential assignment', regex: /\b(?:password|passwd|token|secret)\s*[=:]\s*\S+/gi },
  { kind: 'long hexadecimal string', regex: /\b[0-9a-f]{32,}\b/gi },
  { kind: 'long base64 string', regex: /[A-Za-z0-9+/]{40,}={0,2}/g },
];

const COMMIT_HASH_LENGTH = 40;

// Long runs of letters only, or of lower-case letters and digits, are words and paths, not keys.
const looksRandom = (text: string): boolean =>
  /[a-z]/.test(text) && /[A-Z]/.test(text) && /[0-9]/.test(text);

const isSkipped = (kind: string, text: string, isCommit: IsCommit): boolean => {
  switch (kind) {
    case 'long hexadecimal string':
      return text.length === COMMIT_HASH_LENGTH && isCommit(text);
    case 'long base64 string':
      return !looksRandom(text);
    default:
      return false;
  }
};

const excerpt = (text: string): string => `${text.slice(0, 4)}… (${text.length} characters)`;

export const findSecrets = (text: string, isCommit: IsCommit): SecretMatch[] => {
  const found: SecretMatch[] = [];
  text.split(/\r?\n/).forEach((lineText, index) => {
    const covered: Array<[number, number]> = [];
    const overlaps = (start: number, end: number): boolean =>
      covered.some(([from, to]) => start < to && from < end);
    for (const { kind, regex } of PATTERNS) {
      for (const match of lineText.matchAll(regex)) {
        const start = match.index;
        const end = start + match[0].length;
        if (overlaps(start, end)) continue;
        covered.push([start, end]);
        if (isSkipped(kind, match[0], isCommit)) continue;
        found.push({ line: index + 1, kind, excerpt: excerpt(match[0]) });
      }
    }
  });
  return found;
};
