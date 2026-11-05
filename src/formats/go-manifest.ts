// Go's manifest for the system map (ADR 0320): `go.mod`'s `module` is the module a repository
// publishes, each `require` what it depends on by version, and each `replace` where a module comes
// from instead: another module with its version, or a folder.

import {
  type DependencyVia,
  fileName,
  fromRoot,
  inFolderNamed,
  type ManifestDependency,
  type ManifestRead,
  type ManifestReader,
  withoutBom,
} from './manifest-reader.ts';

// A quoted string, a parenthesis, or a word. Each alternative consumes what it scans, and a quote
// that finds no close means no such quote lies later, so a line is read in linear time.
const TOKEN = /"[^"]*"|`[^`]*`|[()]|[^\s()]+/g;

/** A line's tokens without their quotes, up to a comment; undefined when a quote does not close. */
const tokensOf = (line: string): string[] | undefined => {
  const tokens: string[] = [];
  for (const [token] of line.matchAll(TOKEN)) {
    if (token.startsWith('//')) break;
    const quote = token.startsWith('"') ? '"' : token.startsWith('`') ? '`' : undefined;
    if (quote === undefined) tokens.push(token);
    else if (token.length < 2 || !token.endsWith(quote)) return undefined;
    else tokens.push(token.slice(1, -1));
  }
  return tokens;
};

interface Replace {
  module: string;
  version: string | undefined;
  via: DependencyVia;
}

/** A replacement: a folder without a version, else a module, cut to where its repository is. */
const replacementVia = (
  manifest: string,
  to: string,
  version: string | undefined,
): DependencyVia =>
  version === undefined
    ? { kind: 'project', path: fromRoot(manifest, to) }
    : { kind: 'git', url: to.split('/').slice(0, 3).join('/'), ref: version };

const readManifest = (manifest: string, text: string): ManifestRead => {
  let module: string | undefined;
  const requires = new Map<string, string>();
  const replaces: Replace[] = [];

  /** Why a directive cannot be read, or undefined when it can or says nothing to the map. */
  const directive = (verb: string, words: readonly string[]): string | undefined => {
    if (verb === 'module') {
      if (words.length !== 1) return 'a module line is not one module path';
      module = words[0];
    } else if (verb === 'require') {
      const [name, version] = words;
      if (words.length !== 2 || name === undefined || version === undefined) {
        return 'a require line is not a module and a version';
      }
      requires.set(name, version);
    } else if (verb === 'replace') {
      const arrow = words.indexOf('=>');
      const [old, oldVersion] = words.slice(0, arrow);
      const [to, version] = words.slice(arrow + 1);
      if (
        arrow < 1 ||
        arrow > 2 ||
        words.length - arrow - 1 > 2 ||
        old === undefined ||
        to === undefined
      ) {
        return 'a replace line is not old => new';
      }
      replaces.push({
        module: old,
        version: oldVersion,
        via: replacementVia(manifest, to, version),
      });
    }
    return undefined;
  };

  let block: string | undefined;
  for (const line of text.split('\n')) {
    const tokens = tokensOf(line);
    if (tokens === undefined) {
      return { kind: 'unreadable', reason: 'a line has a quote that does not close' };
    }
    const [first, ...rest] = tokens;
    if (first === undefined) continue;
    let why: string | undefined;
    if (block !== undefined) {
      if (first === ')') block = undefined;
      else why = directive(block, tokens);
    } else if (rest[0] === '(') {
      if (rest[1] !== ')') block = first;
    } else {
      why = directive(first, rest);
    }
    if (why !== undefined) return { kind: 'unreadable', reason: why };
  }
  if (block !== undefined) return { kind: 'unreadable', reason: `a ${block} block is not closed` };
  if (module === undefined) return { kind: 'unreadable', reason: 'it names no module' };

  const dependsOn: ManifestDependency[] = [...requires].map(([name, version]) => {
    const own = replaces.filter((each) => each.module === name);
    const replace =
      own.find((each) => each.version === version) ??
      own.find((each) => each.version === undefined);
    return { name, via: replace?.via ?? { kind: 'package', version } };
  });
  for (const { module: name, via } of replaces) {
    if (!requires.has(name)) dependsOn.push({ name, via });
  }
  return { kind: 'read', publishes: [module], dependsOn };
};

export const goManifest: ManifestReader = {
  ecosystem: 'Go',
  // The go tool ignores a `testdata` folder, and `vendor` holds other repositories' modules.
  matches: (path) =>
    fileName(path) === 'go.mod' && !inFolderNamed(path, ['node_modules', 'vendor', 'testdata']),
  read: (path, text) => readManifest(path, withoutBom(text)),
};
