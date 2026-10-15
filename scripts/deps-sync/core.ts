// Decides whether node_modules still matches package-lock.json, from the text of the two lock
// files (ADR 0021). npm ci records what it installed in node_modules/.package-lock.json.

// Why node_modules is out of date, or undefined when it matches or there is nothing to compare.
export const staleReason = (_lock: string, _installed: string | undefined): string | undefined => {
  throw new Error('not implemented');
};
