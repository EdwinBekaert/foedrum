// The read guard's decisions on the hook input, with the path resolver injected, for both path
// styles on every platform. Real links, junctions and short names are in test/unit/real-path.test.ts
// and test/integration/read-guard.test.ts (ADR 0021).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type GuardDeps, readGuard } from '../../scripts/read-guard.ts';

const root = join(import.meta.dirname, '..', '..');

/** The hook block every read-only agent's frontmatter carries, as written there. */
const READ_GUARD_HOOK = `hooks:
  PreToolUse:
    - matcher: "Read|Grep|Glob"
      hooks:
        - type: command
          command: 'node "\${CLAUDE_PROJECT_DIR}/scripts/read-guard.ts" || { s=$?; [ "$s" = 2 ] || echo "Foedrum read guard could not run (exit $s); read blocked." >&2; exit 2; }'
          shell: bash
          timeout: 30
          onFailure: block`;

const hookInput = (tool: string, toolInput: unknown, cwd: unknown = '/repo/sub'): string =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd });

/** A resolver that follows the given links (path prefix → target) and records each call. */
const fakeRealPath = (links: Record<string, string>, calls: string[]) => (path: string) => {
  calls.push(path);
  for (const [from, to] of Object.entries(links)) {
    if (path === from || path.startsWith(`${from}/`) || path.startsWith(`${from}\\`)) {
      return to + path.slice(from.length);
    }
  }
  return path;
};

interface Setup {
  root?: string | undefined;
  platform?: NodeJS.Platform;
  homedir?: string;
  links?: Record<string, string>;
  realPath?: (path: string) => string;
}

const guard = async (input: string, setup: Setup = {}) => {
  const calls: string[] = [];
  let loaded = false;
  const deps: GuardDeps = {
    root: 'root' in setup ? setup.root : '/repo',
    platform: setup.platform ?? 'linux',
    homedir: setup.homedir ?? '/home/u',
    realPath: setup.realPath ?? fakeRealPath(setup.links ?? {}, calls),
  };
  const result = await readGuard(input, async () => {
    loaded = true;
    return deps;
  });
  return { ...result, calls, loaded };
};

const allows = async (input: string, setup?: Setup) => {
  const { exitCode, stderr } = await guard(input, setup);
  assert.deepEqual({ exitCode, stderr }, { exitCode: 0, stderr: '' });
};

const blocks = async (input: string, why: RegExp, setup?: Setup) => {
  const { exitCode, stderr } = await guard(input, setup);
  assert.equal(exitCode, 2, `not blocked: ${input}`);
  assert.match(stderr, why);
  // One line, so a path with a line break in it cannot add lines of its own.
  assert.equal(stderr.indexOf('\n'), stderr.length - 1, `not one line: ${JSON.stringify(stderr)}`);
};

const OUTSIDE = /outside the checkout/;

describe('readGuard: tools it does not guard', () => {
  for (const tool of ['Bash', 'Edit', 'WebFetch', 'mcp__x__read']) {
    it(`lets ${tool} through without loading anything`, async () => {
      const { exitCode, stderr, loaded } = await guard(hookInput(tool, { file_path: '/etc/x' }));
      assert.deepEqual({ exitCode, stderr, loaded }, { exitCode: 0, stderr: '', loaded: false });
    });
  }
});

describe('readGuard: Read', () => {
  it('allows an absolute path inside the checkout', () =>
    allows(hookInput('Read', { file_path: '/repo/src/a.ts' })));

  it('allows the review bundle under .foedrum/tmp/', () =>
    allows(hookInput('Read', { file_path: '/repo/.foedrum/tmp/31/bundle/diff.patch' })));

  it('allows a path relative to the working directory', () =>
    allows(hookInput('Read', { file_path: 'a.ts' })));

  it('allows a path that stays inside after ..', () =>
    allows(hookInput('Read', { file_path: '/repo/src/../README.md' })));

  it('blocks .. that leaves the checkout', () =>
    blocks(hookInput('Read', { file_path: '../../etc/passwd' }), OUTSIDE));

  it('blocks an absolute path outside the checkout and names it', () =>
    blocks(
      hookInput('Read', { file_path: '/home/u/.config/gh/hosts.yml' }),
      /Read is blocked: "\/home\/u\/.config\/gh\/hosts.yml" is outside the checkout \(\/repo\)/,
    ));

  it('blocks a sibling whose name starts with the checkout', () =>
    blocks(hookInput('Read', { file_path: '/repo-evil/x' }), OUTSIDE));

  it('blocks the parent of the checkout', () =>
    blocks(hookInput('Read', { file_path: '/repo/..' }), OUTSIDE));

  it('allows the checkout itself', () => allows(hookInput('Read', { file_path: '/repo' })));

  it('blocks ~ when the home folder is outside the checkout', () =>
    blocks(hookInput('Read', { file_path: '~/.config/gh/hosts.yml' }), OUTSIDE));

  it('allows ~ when it leads inside the checkout', () =>
    allows(hookInput('Read', { file_path: '~/repo/a.ts' }), { root: '/home/u/repo' }));

  it("blocks another user's ~", () =>
    blocks(hookInput('Read', { file_path: '~root/.ssh/id_ed25519' }), /~root/));

  it('blocks a link inside the checkout that leads outside, and says where it leads', () =>
    blocks(hookInput('Read', { file_path: '/repo/link/hosts.yml' }), /resolves to/, {
      links: { '/repo/link': '/home/u/.config/gh' },
    }));

  it('allows a path inside when the checkout is reached through a link', () =>
    allows(hookInput('Read', { file_path: '/repo/a.ts' }), {
      root: '/link-to-repo',
      links: { '/link-to-repo': '/repo' },
    }));

  // A link the pull request committed, inside: POSIX reads `x/..` from the link's target, a tool
  // that normalises the path first does not, and the two readings land in different places.
  it('blocks .. after a link when either reading of it leaves the checkout', () =>
    blocks(hookInput('Read', { file_path: '/repo/x/../../../etc/passwd' }), OUTSIDE, {
      links: { '/repo/x': '/repo/a/b/c' },
    }));

  it('blocks a path that cannot be resolved, with the reason', () =>
    blocks(
      hookInput('Read', { file_path: '/repo/loop' }),
      /could not resolve "\/repo\/loop".*ELOOP/,
      {
        // The checkout resolves; only the path read does not.
        realPath: (path) => {
          if (path === '/repo') return path;
          throw Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' });
        },
      },
    ));

  it('keeps a path with a line break on one line', () =>
    blocks(hookInput('Read', { file_path: '/etc/x\nok' }), OUTSIDE));

  it('blocks a Read without a file_path', () =>
    blocks(hookInput('Read', { offset: 3 }), /no file_path/));

  it('blocks a relative path when the working directory is not known', () =>
    blocks(hookInput('Read', { file_path: 'a.ts' }, 42), /working directory/));
});

describe('readGuard: Grep and Glob', () => {
  it('allows Grep without a path in a working directory inside', () =>
    allows(hookInput('Grep', { pattern: 'token' })));

  it('blocks Grep without a path in a working directory outside', () =>
    blocks(
      hookInput('Grep', { pattern: 'token' }, '/home/u'),
      /^Grep is blocked: .*outside the checkout/,
    ));

  it('blocks Grep with a path outside', () =>
    blocks(hookInput('Grep', { pattern: 'token', path: '/home/u/.config' }), OUTSIDE));

  it('allows Grep with a path inside', () =>
    allows(hookInput('Grep', { pattern: 'token', path: '../src', glob: '*.ts' })));

  it('allows a relative Glob pattern inside', () =>
    allows(hookInput('Glob', { pattern: 'src/**/*.ts' })));

  it('blocks Glob with a path outside', () =>
    blocks(
      hookInput('Glob', { pattern: '*.yml', path: '/home/u/.config/gh' }),
      /^Glob is blocked: .*outside the checkout/,
    ));

  it('blocks an absolute Glob pattern outside', () =>
    blocks(hookInput('Glob', { pattern: '/home/u/.config/**/*.yml' }), OUTSIDE));

  it('allows an absolute Glob pattern inside', () =>
    allows(hookInput('Glob', { pattern: '/repo/src/**/*.ts' })));

  it('allows an absolute Glob pattern into a checkout whose path has glob characters', async () => {
    const root = '/home/u/c++ (eu)/repo';
    await allows(hookInput('Glob', { pattern: `${root}/src/**/*.ts` }, root), { root });
    await allows(
      hookInput(
        'Glob',
        { pattern: 'C:\\Users\\me\\OneDrive (EU)\\repo\\src\\*.ts' },
        'C:\\Users\\me\\OneDrive (EU)\\repo',
      ),
      {
        root: 'C:\\Users\\me\\OneDrive (EU)\\repo',
        platform: 'win32',
        homedir: 'C:\\Users\\me',
      },
    );
  });

  it('blocks a Glob pattern whose literal part leaves the checkout', () =>
    blocks(hookInput('Glob', { pattern: '../../home/u/*' }), OUTSIDE));

  it('blocks a Glob pattern starting with ~', () =>
    blocks(hookInput('Glob', { pattern: '~/.ssh/*' }), OUTSIDE));

  for (const pattern of [
    'src/**/../../../etc/*',
    '*/{..,x}/*',
    '{/etc,src}/*',
    'src/*,/etc/*',
    '{src,~/.ssh}/*',
    '@(src|/etc)/*',
    '!(x)|~/.ssh/*',
  ]) {
    it(`blocks a Glob pattern that may reach out after a wildcard: ${pattern}`, () =>
      blocks(hookInput('Glob', { pattern }), /after a wildcard/));
  }

  it('blocks a Glob of the root', () => blocks(hookInput('Glob', { pattern: '/*' }), OUTSIDE));

  it('checks a Glob pattern without a wildcard as a path', async () => {
    await blocks(hookInput('Glob', { pattern: '/home/u/.ssh/id_ed25519' }), OUTSIDE);
    await allows(hookInput('Glob', { pattern: 'src/a.ts' }));
  });

  it('blocks Glob without a pattern', () =>
    blocks(hookInput('Glob', { path: '/repo' }), /no pattern/));
});

describe('readGuard: Windows paths', () => {
  const win = { root: 'D:\\repo', platform: 'win32' as const, homedir: 'C:\\Users\\u' };
  const winInput = (tool: string, toolInput: unknown) =>
    hookInput(tool, toolInput, 'D:\\repo\\sub');

  it('allows a drive path inside', () =>
    allows(winInput('Read', { file_path: 'D:\\repo\\src\\a.ts' }), win));

  it('allows forward slashes and a relative path inside', async () => {
    await allows(winInput('Read', { file_path: 'D:/repo/src/a.ts' }), win);
    await allows(winInput('Read', { file_path: '..\\src\\a.ts' }), win);
  });

  it('blocks .. out of the checkout', () =>
    blocks(
      winInput('Read', { file_path: '..\\..\\Users\\u\\.config\\gh\\hosts.yml' }),
      OUTSIDE,
      win,
    ));

  it('blocks another drive', () =>
    blocks(winInput('Read', { file_path: 'C:\\Users\\u\\.ssh\\id_ed25519' }), OUTSIDE, win));

  for (const file_path of [
    '\\\\server\\share\\x',
    '//server/share/x',
    '\\\\?\\D:\\repo\\a.ts',
    '\\\\.\\PhysicalDrive0',
  ]) {
    it(`blocks a network or device path without touching it: ${file_path}`, async () => {
      const { exitCode, stderr, calls } = await guard(winInput('Read', { file_path }), win);
      assert.equal(exitCode, 2);
      assert.match(stderr, /network or device path/);
      // Only the checkout itself is resolved.
      assert.deepEqual(calls, ['D:\\repo']);
    });
  }

  for (const file_path of ['\\repo\\a.ts', '/d/repo/a.ts', 'D:repo\\a.ts']) {
    it(`blocks a path without a full drive: ${file_path}`, () =>
      blocks(winInput('Read', { file_path }), /drive/, win));
  }

  it('blocks a relative path in a working directory on a network share, without touching it', async () => {
    const input = hookInput('Grep', { pattern: 'x', path: 'src' }, '\\\\server\\share\\repo');
    const { exitCode, stderr, calls } = await guard(input, win);
    assert.equal(exitCode, 2);
    assert.match(stderr, /network or device path/);
    assert.deepEqual(calls, ['D:\\repo']);
  });

  it('blocks a Glob pattern that starts at a drive without a folder, without touching it', async () => {
    const { exitCode, stderr, calls } = await guard(
      winInput('Glob', { pattern: 'E:secrets\\*' }),
      win,
    );
    assert.equal(exitCode, 2);
    assert.match(stderr, /no full drive path/);
    assert.deepEqual(calls, ['D:\\repo']);
  });

  // A mapped network drive, or a disconnected one, would be opened by the resolver.
  it('blocks a path on another drive than the checkout, without touching it', async () => {
    const { exitCode, stderr, calls } = await guard(
      winInput('Read', { file_path: 'Z:\\x.txt' }),
      win,
    );
    assert.equal(exitCode, 2);
    assert.match(stderr, /"Z:\\\\x.txt" is outside the checkout \(D:\\repo\): it is on drive Z:/);
    assert.deepEqual(calls, ['D:\\repo']);
  });

  it('blocks a Glob pattern with backslashes that leaves the checkout', () =>
    blocks(winInput('Glob', { pattern: '..\\..\\Users\\*' }), OUTSIDE, win));

  it('blocks a Glob pattern with a drive after a wildcard', () =>
    blocks(winInput('Glob', { pattern: '{src,C:/Users/u}/*' }), /after a wildcard/, win));

  it('allows ~\\ when the home folder holds the checkout', () =>
    allows(winInput('Read', { file_path: '~\\repo\\a.ts' }), {
      ...win,
      root: 'C:\\Users\\u\\repo',
    }));

  // A session opened through a subst drive: both the drive as given and the real one are the
  // checkout's.
  it('allows both drives of a checkout reached through a subst drive', async () => {
    const subst = { ...win, root: 'S:\\foedrum', links: { 'S:\\foedrum': 'D:\\code\\foedrum' } };
    await allows(winInput('Read', { file_path: 'S:\\foedrum\\a.ts' }), subst);
    await allows(winInput('Read', { file_path: 'D:\\code\\foedrum\\a.ts' }), subst);
  });

  it('blocks a link inside that leads to another drive', () =>
    blocks(winInput('Read', { file_path: 'D:\\repo\\junction\\hosts.yml' }), /resolves to/, {
      ...win,
      links: { 'D:\\repo\\junction': 'C:\\Users\\u\\.config\\gh' },
    }));
});

describe('readGuard: what it cannot check', () => {
  it('blocks when CLAUDE_PROJECT_DIR is not set', () =>
    blocks(hookInput('Read', { file_path: '/repo/a.ts' }), /CLAUDE_PROJECT_DIR/, {
      root: undefined,
    }));

  it('blocks when CLAUDE_PROJECT_DIR is relative', () =>
    blocks(hookInput('Read', { file_path: '/repo/a.ts' }), /CLAUDE_PROJECT_DIR/, {
      root: 'repo',
    }));

  it('blocks when the checkout cannot be resolved', () =>
    blocks(hookInput('Read', { file_path: '/repo/a.ts' }), /could not resolve the checkout/, {
      realPath: () => {
        throw new Error('EACCES: permission denied');
      },
    }));

  it('blocks input that is not JSON', () => blocks('not json', /could not read its input/));

  it('blocks a tool_input that is not an object', () =>
    blocks(hookInput('Read', 'x'), /could not read its input/));
});

// Every agent that can only read gets the guard: for those the guard is the boundary (ADR 0048).
describe('the read-only agents', () => {
  const agents = join(root, '.claude', 'agents');
  const all = readdirSync(agents)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({
      name,
      text: readFileSync(join(agents, name), 'utf8').replace(/\r\n/g, '\n'),
    }));
  const readOnly = all.filter(({ text }) => {
    const tools =
      /^tools:(.*)$/m
        .exec(text)?.[1]
        ?.split(',')
        .map((tool) => tool.trim()) ?? [];
    return tools.length > 0 && tools.every((tool) => ['Read', 'Grep', 'Glob'].includes(tool));
  });

  // Otherwise a read-only agent whose tools are a YAML list would not be found above.
  it('all name their tools on the tools: line itself, when they name them', () => {
    for (const { name, text } of all) {
      const frontmatter = text.split('\n---\n')[0] ?? '';
      const line = /^tools:(.*)$/m.exec(frontmatter);
      if (line !== null) assert.notEqual(line[1]?.trim(), '', `${name}: tools: is empty`);
    }
  });

  it('are taster and brett, and each runs the read guard before Read, Grep and Glob', () => {
    assert.deepEqual(readOnly.map(({ name }) => name).sort(), ['brett.md', 'taster.md']);
    for (const { name, text } of readOnly) {
      const frontmatter = text.split('\n---\n')[0] ?? '';
      assert.ok(frontmatter.includes(READ_GUARD_HOOK), `${name} frontmatter:\n${frontmatter}`);
    }
  });
});
