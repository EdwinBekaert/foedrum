// Decides whether node_modules still matches package-lock.json, from the text of the two lock
// files (ADR 0021). npm ci records what it installed in node_modules/.package-lock.json.

interface Entry {
  version?: unknown;
  integrity?: unknown;
  optional?: unknown;
  peer?: unknown;
}

const INSTALLED = 'node_modules/.package-lock.json';

// The `packages` entries without the root entry (""), which the installed record never has;
// undefined when the text is not a lock file.
const packagesOf = (text: string): Map<string, Entry> | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undefined;
  }
  const packages = (parsed as { packages?: unknown } | null)?.packages;
  if (typeof packages !== 'object' || packages === null) return undefined;
  return new Map(Object.entries(packages as Record<string, Entry>).filter(([path]) => path !== ''));
};

// Why node_modules is out of date, or undefined when it matches or there is nothing to compare.
export const staleReason = (lock: string, installed: string | undefined): string | undefined => {
  const wanted = packagesOf(lock);
  // An unreadable package-lock.json (a merge conflict, say) is for npm to report, not this.
  if (wanted === undefined) return undefined;
  if (installed === undefined) return `${INSTALLED} is missing`;
  const have = packagesOf(installed);
  if (have === undefined) return `${INSTALLED} cannot be parsed`;

  for (const [path, entry] of wanted) {
    const got = have.get(path);
    if (got === undefined) {
      // npm ci skips optional packages for other platforms, and peers under omit=peer.
      if (entry.optional === true || entry.peer === true) continue;
      return `${path} ${String(entry.version)} is not installed`;
    }
    if (got.version !== entry.version) {
      return `${path} ${String(got.version)} is installed, package-lock.json has ${String(entry.version)}`;
    }
    if (got.integrity !== entry.integrity) {
      return `${path} ${String(got.version)} differs from package-lock.json (integrity)`;
    }
  }
  for (const path of have.keys()) {
    if (!wanted.has(path)) return `${path} is installed but no longer in package-lock.json`;
  }
  return undefined;
};
