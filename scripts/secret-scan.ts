// Scans a review summary for secrets before /brew-review posts it.

export interface SecretMatch {
  line: number;
  kind: string;
  excerpt: string;
}

export type IsCommit = (sha: string) => boolean;

export const findSecrets = (_text: string, _isCommit: IsCommit): SecretMatch[] => {
  throw new Error('not implemented');
};

if (import.meta.main) {
  throw new Error('not implemented');
}
