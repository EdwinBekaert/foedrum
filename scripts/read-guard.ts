// Claude Code PreToolUse hook for Read, Grep and Glob: lets a call through only when every path
// it reads resolves inside the checkout, `CLAUDE_PROJECT_DIR` (ADR 0048).
// Wired in the frontmatter of the read-only agents (.claude/agents/taster.md, brett.md) as
// `node "${CLAUDE_PROJECT_DIR}/scripts/read-guard.ts"`, failing closed like the local gate.
// Exit 0 lets the tool call through; exit 2 blocks it and shows stderr to Claude.
// Like scripts/precheck.ts, the module has no static imports: a tool it does not guard exits
// before anything loads, and a guarded one loads node:path, node:os and src/platform/real-path.ts
// only.
//
// A path is resolved as a read would open it: `~` is the home folder, a relative path is relative
// to the working directory, and the deepest existing part goes through the operating system's
// real path (links, junctions, short names, case; src/platform/real-path.ts). On Windows a path
// without a full drive, a network or device path, and a path on another drive than the checkout
// (a mapped network drive) are blocked before they touch the disk. A link inside the checkout
// whose target is a network path is still resolved (ADR 0048).

export interface HookResult {
  exitCode: 0 | 2;
  stderr: string;
}

export interface GuardDeps {
  /** The checkout: `CLAUDE_PROJECT_DIR`, undefined when it is not set. */
  root: string | undefined;
  platform: NodeJS.Platform;
  homedir: string;
  /** The real path of an absolute path; throws when it cannot be resolved. */
  realPath: (path: string) => string;
}

const GUARDED = new Set(['Read', 'Grep', 'Glob']);
// A glob segment from which the pattern no longer names one folder.
const MAGIC = /[*?[\]{}()!+@]/;
// What may lead a glob out after a wildcard: `..`, an alternative that starts at a root or the home
// folder, or a drive.
const REACHES_OUT = /\.\.|[{(,|]\s*[\\/~]|:/;

const PASS: HookResult = { exitCode: 0, stderr: '' };
const blocked = (why: string): HookResult => ({
  exitCode: 2,
  stderr: `${why.replace(/[\r\n]+/g, ' ')}\n`,
});
const UNREADABLE = blocked('The read guard could not read its input, so the call is blocked.');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const quoted = (path: string): string => JSON.stringify(path);

export const readGuard = async (
  input: string,
  loadDeps: () => Promise<GuardDeps>,
): Promise<HookResult> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return UNREADABLE;
  }
  if (!isRecord(parsed) || typeof parsed.tool_name !== 'string') return UNREADABLE;
  const tool = parsed.tool_name;
  if (!GUARDED.has(tool)) return PASS;
  const toolInput = parsed.tool_input;
  if (!isRecord(toolInput)) return UNREADABLE;
  const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : undefined;

  const deps = await loadDeps();
  const [{ posix, win32 }, { windowsPathProblem }] = await Promise.all([
    import('node:path'),
    import('../src/platform/real-path.ts'),
  ]);
  const path = deps.platform === 'win32' ? win32 : posix;
  const separators = deps.platform === 'win32' ? /[\\/]/ : '/';
  const no = (why: string) => blocked(`${tool} is blocked: ${why}`);

  if (deps.root === undefined || !path.isAbsolute(deps.root)) {
    return no(
      'CLAUDE_PROJECT_DIR is not set to an absolute path, so the read guard cannot tell where the checkout is.',
    );
  }
  let root: string;
  try {
    root = path.resolve(deps.realPath(deps.root));
  } catch (error) {
    return no(`could not resolve the checkout ${quoted(deps.root)} (${String(error)}).`);
  }
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  // On Windows, the drives the checkout is on, as given and as resolved (a subst drive).
  const drive = (path: string): string => path.slice(0, 2).toUpperCase();
  const rootDrives = new Set([drive(deps.root), drive(root)]);

  // On Windows, what is not a full drive path, before it touches the disk or the network.
  const notADrivePath = (path: string, name: string): string | undefined => {
    if (deps.platform !== 'win32') return undefined;
    switch (windowsPathProblem(path)) {
      case 'network':
        return `${name} is a network or device path; read files inside the checkout (${root}) by a drive path or a relative path.`;
      case 'no-drive':
        return `${name} has no full drive path; give one such as ${root}\\… or a path relative to the working directory.`;
      case undefined:
        return undefined;
    }
  };

  // Undefined when the path resolves inside the checkout, otherwise why the call is blocked.
  const outside = (given: string): string | undefined => {
    const name = quoted(given);
    let absolute: string;
    const notGiven = notADrivePath(given, name);
    if (notGiven !== undefined) return notGiven;
    if (
      given === '~' ||
      given.startsWith('~/') ||
      (deps.platform === 'win32' && given.startsWith('~\\'))
    ) {
      absolute = deps.homedir + given.slice(1);
    } else if (given.startsWith('~')) {
      return `${name} names another user's home folder, which the read guard cannot resolve.`;
    } else if (path.isAbsolute(given)) {
      absolute = given;
    } else if (cwd !== undefined && path.isAbsolute(cwd)) {
      // Not normalised: the resolver reads `..` the way the operating system does.
      absolute = `${cwd}${path.sep}${given}`;
    } else {
      return `${name} is relative and the working directory is not known.`;
    }
    // A relative path in a working directory on a network share is one too.
    const notResolved = notADrivePath(absolute, quoted(absolute));
    if (notResolved !== undefined) return notResolved;
    // Another drive is outside, and resolving it could reach a mapped network drive.
    if (deps.platform === 'win32' && !rootDrives.has(drive(absolute))) {
      return `${name} is outside the checkout (${root}): it is on drive ${absolute.slice(0, 2)}; reviewers read only files inside it (ADR 0048).`;
    }
    let real: string;
    try {
      real = path.resolve(deps.realPath(absolute));
    } catch (error) {
      return `could not resolve ${name} (${error instanceof Error ? error.message : String(error)}).`;
    }
    if (real === root || real.startsWith(rootPrefix)) return undefined;
    const where =
      real === path.resolve(absolute) ? `${name} is` : `${name} resolves to ${quoted(real)},`;
    return `${where} outside the checkout (${root}); reviewers read only files inside it (ADR 0048).`;
  };

  const reads: string[] = [];
  const base = (): string => {
    const searched = toolInput.path;
    return typeof searched === 'string' && searched !== '' ? searched : (cwd ?? '.');
  };
  switch (tool) {
    case 'Read': {
      const file = toolInput.file_path;
      if (typeof file !== 'string' || file === '') return no('no file_path to check.');
      reads.push(file);
      break;
    }
    case 'Grep':
      reads.push(base());
      break;
    default: {
      const pattern = toolInput.pattern;
      if (typeof pattern !== 'string' || pattern === '') return no('no pattern to check.');
      const segments = pattern.split(separators);
      const magic = segments.findIndex((segment) => MAGIC.test(segment));
      const literal = magic < 0 ? segments : segments.slice(0, magic);
      if (magic >= 0 && REACHES_OUT.test(segments.slice(magic).join('/'))) {
        return no(
          `the pattern ${quoted(pattern)} has .., a root or a drive after a wildcard, so the read guard cannot tell where it reaches; search from a path inside the checkout.`,
        );
      }
      reads.push(base());
      // The folder the wildcards start in, with its separator, so `/*` keeps its root and `D:\*`
      // its drive. It is checked first, so a pattern that names another drive touches nothing.
      if (literal.length > 0) {
        const prefix = literal.join(path.sep) + (magic >= 0 ? path.sep : '');
        // A Windows drive without a folder (`E:x\*`) is not relative to the working directory.
        const fromRoot =
          path.isAbsolute(prefix) ||
          prefix.startsWith('~') ||
          (deps.platform === 'win32' && /^[A-Za-z]:/.test(prefix));
        reads.unshift(fromRoot ? prefix : `${base()}${path.sep}${prefix}`);
      }
    }
  }
  for (const read of reads) {
    const why = outside(read);
    if (why !== undefined) return no(why);
  }
  return PASS;
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

if (import.meta.main) {
  const { exitCode, stderr } = await readGuard(await readStdin(), async () => {
    const [{ homedir }, { realPath }] = await Promise.all([
      import('node:os'),
      import('../src/platform/real-path.ts'),
    ]);
    return {
      root: process.env.CLAUDE_PROJECT_DIR,
      platform: process.platform,
      homedir: homedir(),
      realPath: (path) => realPath(path),
    };
  });
  if (stderr !== '') process.stderr.write(stderr);
  process.exitCode = exitCode;
}
