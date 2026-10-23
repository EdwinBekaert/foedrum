import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  type AttemptPermissions,
  attemptSettings,
  type ConfigDirs,
  configDirsOf,
  toolchainOf,
  writeAttemptSettings,
} from '../../src/brewers/attempt-settings.ts';
import { type AttemptSettings, sandboxCredentials } from '../../src/schemas/attempt-settings.ts';
import { withinCeiling } from '../../src/schemas/primitives.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

// The key the schema does not know yet (ADR 0151), read without a type that has it.
const attributionOf = (settings: AttemptSettings): unknown =>
  (settings as { attribution?: unknown }).attribution;

// The read block (ADR 0160), read the same way.
const readBlockOf = (settings: AttemptSettings): unknown =>
  (settings.permissions as { blockReadsOutsideWorkingDirectories?: unknown })
    .blockReadsOutsideWorkingDirectories;

// The folders re-opened to sandboxed commands (ADR 0162), read the same way.
const allowReadOf = (settings: AttemptSettings): unknown =>
  (settings.sandbox as { filesystem?: { allowRead?: unknown } } | undefined)?.filesystem?.allowRead;

// The npm configuration files hidden inside them (review of #437), read the same way.
const denyReadOf = (settings: AttemptSettings): unknown =>
  (settings.sandbox as { filesystem?: { denyRead?: unknown } } | undefined)?.filesystem?.denyRead;

describe('attemptSettings', () => {
  it("keeps the brewer's rules and always denies AskUserQuestion and git push in each shell", () => {
    const settings = attemptSettings({
      allow: ['Read', 'Bash(npm test)', 'PowerShell(npm test)'],
      deny: ['WebFetch'],
      sandbox: false,
    });
    assert.deepEqual(settings, {
      permissions: {
        allow: ['Read(./**)', 'Bash(npm test)', 'PowerShell(npm test)'],
        deny: ['WebFetch', 'AskUserQuestion', 'Bash(git push *)', 'PowerShell(git push *)'],
      },
      attribution: { commit: '', pr: '', sessionUrl: false },
    });
  });

  // ADR 0151: with `--setting-sources ""` Claude Code's default attribution applies, and a brewer's
  // commits in a target repository would get a Co-Authored-By trailer. The empty-string object is
  // the form every Claude Code version reads; `false` makes an older one skip the whole file.
  it('hides the attribution of commits and pull requests without a sandbox', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: false });
    assert.deepEqual(attributionOf(settings), { commit: '', pr: '', sessionUrl: false });
  });

  it('hides the attribution of commits and pull requests with a sandbox', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: true });
    assert.deepEqual(attributionOf(settings), { commit: '', pr: '', sessionUrl: false });
  });

  it('hides the attribution whatever rules the brewer has', () => {
    const settings = attemptSettings({
      allow: ['Read', 'Edit', 'Bash(git commit *)', 'PowerShell(npm test)'],
      deny: ['WebFetch'],
      sandbox: false,
    });
    assert.deepEqual(attributionOf(settings), { commit: '', pr: '', sessionUrl: false });
  });

  it('hides the attribution when the brewer has no rules', () => {
    const settings = attemptSettings({ allow: [], deny: [], sandbox: false });
    assert.deepEqual(attributionOf(settings), { commit: '', pr: '', sessionUrl: false });
  });

  it('denies git push only in the shells the brewer has, and each rule once', () => {
    const settings = attemptSettings({
      allow: ['Read', 'Bash(npm test)'],
      deny: ['AskUserQuestion'],
      sandbox: false,
    });
    assert.deepEqual(settings.permissions.deny, ['AskUserQuestion', 'Bash(git push *)']);
  });

  // ADR 0042: by default a sandbox that cannot start lets commands run unsandboxed.
  it('requires the sandbox to run when the isolation level relies on it', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: true });
    assert.equal(settings.sandbox?.enabled, true);
    assert.equal(settings.sandbox?.failIfUnavailable, true);
    assert.equal(settings.sandbox?.allowUnsandboxedCommands, false);
  });

  // #234: by default Claude Code runs every sandboxed Bash command without asking, whatever the
  // allow rules say, dontAsk included (ADR 0087).
  it('lets the allow rules decide for sandboxed commands too', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: true });
    assert.equal(settings.sandbox?.autoAllowBashIfSandboxed, false);
  });

  // A sandboxed command reads most of the machine and inherits Claude Code's environment, and
  // Claude Code has no credential deny list of its own (ADR 0087).
  it('hides the credential files and variables from sandboxed commands', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: true });
    assert.deepEqual(settings.sandbox?.credentials, {
      files: [
        '~/.config/gh',
        '~/.git-credentials',
        '~/.config/git/credentials',
        '~/.ssh',
        '~/.aws',
        '~/.npmrc',
        '~/.claude/.credentials.json',
        '~/.config/anthropic',
      ].map((path) => ({ path, mode: 'deny' })),
      envVars: [
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'GH_ENTERPRISE_TOKEN',
        'GITHUB_ENTERPRISE_TOKEN',
        'NPM_TOKEN',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ].map((name) => ({ name, mode: 'deny' })),
    });
  });

  // #247: a sandboxed command reads most of the machine, and a list of credential paths can't be
  // complete. The block denies it the home directory and the other user roots, `/mnt` with the
  // Windows home on WSL2 among them, and re-opens the working directories (ADR 0160).
  it('blocks sandboxed commands from reading outside the working directories', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: true });
    assert.equal(readBlockOf(settings), true);
  });

  // Without a sandbox the file tools' rules are already scoped to the worktree (ADR 0093), and the
  // block would make a shell command the parser can't trace prompt, so be denied.
  it('leaves the read block out without a sandbox', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: false });
    assert.equal(Object.hasOwn(settings.permissions, 'blockReadsOutsideWorkingDirectories'), false);
  });

  // #247: a variable that moves a login moves it out of ADR 0087's `~/` paths, and out of the
  // block too when it points outside the user roots.
  const hiddenFiles = (configDirs: ConfigDirs, sandbox = true): string[] =>
    (
      attemptSettings({ allow: ['Read'], deny: [], sandbox, configDirs }).sandbox?.credentials
        .files ?? []
    ).map(({ path }) => path);
  const defaultFiles = sandboxCredentials.files.map(({ path }) => path);

  it('hides the gh configuration directory GH_CONFIG_DIR names', () => {
    assert.deepEqual(hiddenFiles({ GH_CONFIG_DIR: '/srv/gh' }), [...defaultFiles, '/srv/gh']);
  });

  it("hides gh's directory and git's credential store under XDG_CONFIG_HOME", () => {
    assert.deepEqual(hiddenFiles({ XDG_CONFIG_HOME: '/data/config' }), [
      ...defaultFiles,
      '/data/config/gh',
      '/data/config/git/credentials',
    ]);
  });

  it("hides Claude Code's login under CLAUDE_CONFIG_DIR", () => {
    assert.deepEqual(hiddenFiles({ CLAUDE_CONFIG_DIR: '/data/claude-work' }), [
      ...defaultFiles,
      '/data/claude-work/.credentials.json',
    ]);
  });

  it('hides each moved login once, when the variables name the same place', () => {
    assert.deepEqual(
      hiddenFiles({ GH_CONFIG_DIR: '/data/config/gh', XDG_CONFIG_HOME: '/data/config' }),
      [...defaultFiles, '/data/config/gh', '/data/config/git/credentials'],
    );
  });

  // A relative value resolves against whichever process reads it, so it names no one place; an
  // empty one counts as unset, as gh reads it.
  it('adds nothing for an empty or relative variable', () => {
    assert.deepEqual(
      hiddenFiles({ GH_CONFIG_DIR: '', XDG_CONFIG_HOME: 'config', CLAUDE_CONFIG_DIR: './c' }),
      defaultFiles,
    );
  });

  it('writes no credentials without a sandbox, whatever the variables say', () => {
    assert.deepEqual(hiddenFiles({ GH_CONFIG_DIR: '/srv/gh' }, false), []);
  });

  // #427: the block takes a toolchain under the home from sandboxed commands; `allowRead` from the
  // runner's `--settings` re-opens its folders, never a PATH entry's parent blindly (ADR 0162).
  describe('the toolchain folders it re-opens to sandboxed commands (ADR 0162)', () => {
    const HOME = '/home/brewer';
    const settingsFor = (PATH: string, more: Partial<AttemptPermissions> = {}) =>
      attemptSettings({
        allow: ['Read'],
        deny: [],
        sandbox: true,
        toolchain: { HOME, PATH },
        ...more,
      });
    const reopened = (PATH: string, more: Partial<AttemptPermissions> = {}): unknown =>
      allowReadOf(settingsFor(PATH, more));

    // nvm's bin holds links into ../lib/node_modules (npm, npx, global packages): the version's
    // folder holds both, and nothing else of ~/.nvm.
    it("re-opens the node version nvm put on the PATH, with its lib, and nothing else of nvm's", () => {
      assert.deepEqual(reopened(`${HOME}/.nvm/versions/node/v24.15.0/bin:/usr/bin:/bin`), [
        `${HOME}/.nvm/versions/node/v24.15.0`,
      ]);
    });

    // Volta's shims run the tools it keeps in ~/.volta/tools.
    it("re-opens Volta's folder when its shims are on the PATH", () => {
      assert.deepEqual(reopened(`${HOME}/.volta/bin:/usr/bin`), [`${HOME}/.volta`]);
    });

    // asdf's shims run `asdf exec`, which runs the version under ~/.asdf/installs.
    it("re-opens asdf's folder once, for its shims and its bin", () => {
      assert.deepEqual(reopened(`${HOME}/.asdf/shims:${HOME}/.asdf/bin:/usr/bin`), [
        `${HOME}/.asdf`,
      ]);
    });

    // Homebrew on Linux lives under /home, a user root the block denies whoever's home it is.
    it("re-opens Homebrew's prefix on Linux, under /home, once for its bin and sbin", () => {
      const linuxbrew = '/home/linuxbrew/.linuxbrew';
      assert.deepEqual(reopened(`${linuxbrew}/bin:${linuxbrew}/sbin:/usr/bin`), [linuxbrew]);
    });

    // ~/.local holds ~/.local/share/keyrings, ~/.cargo holds crates.io's credentials.toml, and ~/bin's
    // parent is the home itself.
    it('re-opens any other PATH folder under the home as it is, never its parent', () => {
      assert.deepEqual(reopened(`${HOME}/.local/bin:${HOME}/bin:${HOME}/.cargo/bin`), [
        `${HOME}/.local/bin`,
        `${HOME}/bin`,
        `${HOME}/.cargo/bin`,
      ]);
    });

    it('re-opens each folder once, in PATH order, whatever its spelling', () => {
      assert.deepEqual(
        reopened(`${HOME}/bin:${HOME}/.volta/bin/:${HOME}//bin/:${HOME}/.volta/bin`),
        [`${HOME}/bin`, `${HOME}/.volta`],
      );
    });

    // Outside the user roots the block takes nothing; on WSL2 the Windows folders under /mnt are
    // Windows programs, and another user's home is theirs.
    it('re-opens nothing outside the home but Homebrew on Linux', () => {
      const settings = settingsFor(
        '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/mnt/c/Windows/System32:/home/other/.nvm/versions/node/v24.15.0/bin',
      );
      assert.equal(Object.hasOwn(settings.sandbox ?? {}, 'filesystem'), false);
    });

    // A relative or empty entry resolves against whichever directory a command runs in; a glob
    // character would be read as a wildcard (sandbox path prefixes); `..` leaves the folder named.
    it('re-opens neither the home itself nor an entry that names no one folder under it', () => {
      const entries = [
        HOME,
        `${HOME}/`,
        `${HOME}/.nvm/versions/node/v24.15.0/bin/../../../../..`,
        `${HOME}/../other/bin`,
        'node_modules/.bin',
        '.',
        '',
        `${HOME}/[tools]/bin`,
        `${HOME}/tools*/bin`,
        `${HOME}/tool?/bin`,
      ];
      assert.equal(allowReadOf(settingsFor(entries.join(':'))), undefined);
    });

    // The docs: "When read rules overlap, the rule with the narrower path applies", so an
    // `allowRead` inside a hidden login would re-open it, and one around it would re-open what
    // else lies there.
    it('re-opens no folder at, inside or around a login the sandbox hides', () => {
      const entries = [
        `${HOME}/.config/gh/bin`,
        `${HOME}/.ssh`,
        `${HOME}/.aws/cli/bin`,
        `${HOME}/.config`,
        `${HOME}/.claude`,
        `${HOME}/xdg/gh/bin`,
      ];
      const settings = settingsFor(entries.join(':'), {
        configDirs: { XDG_CONFIG_HOME: `${HOME}/xdg` },
      });
      assert.equal(allowReadOf(settings), undefined);
    });

    // The overlap table: "The deny holds inside a wider allow, so a broad allow can't silently
    // re-expose a secret"; `credentials.files` is the same restriction as `denyRead`.
    it('keeps every hidden login next to the folders it re-opens', () => {
      const settings = settingsFor(`${HOME}/.nvm/versions/node/v24.15.0/bin`);
      assert.deepEqual(
        settings.sandbox?.credentials.files.map(({ path }) => path),
        sandboxCredentials.files.map(({ path }) => path),
      );
    });

    // `~/` in a sandbox path would expand to the HOME of the process that reads it.
    it('re-opens only Homebrew on Linux without an absolute home other than the root', () => {
      const PATH = `/root/.volta/bin:/x/.volta/bin:/home/linuxbrew/.linuxbrew/bin:/.volta/bin`;
      for (const home of [undefined, '', '/', 'brewer']) {
        const settings = attemptSettings({
          allow: ['Read'],
          deny: [],
          sandbox: true,
          toolchain: home === undefined ? { PATH } : { HOME: home, PATH },
        });
        assert.deepEqual(allowReadOf(settings), ['/home/linuxbrew/.linuxbrew'], String(home));
      }
    });

    it('re-opens nothing without a PATH', () => {
      const settings = attemptSettings({
        allow: ['Read'],
        deny: [],
        sandbox: true,
        toolchain: { HOME },
      });
      assert.equal(allowReadOf(settings), undefined);
    });

    it('writes no read paths without a sandbox', () => {
      const settings = settingsFor(`${HOME}/.volta/bin`, { sandbox: false });
      assert.equal(Object.hasOwn(settings, 'sandbox'), false);
    });

    // Review of #437: a folder whose name starts with the home's is not under it.
    it("re-opens nothing in a folder beside the home whose name starts with the home's", () => {
      const settings = settingsFor(`/home/brewer2/bin:/home/brewer.old/.volta/bin`);
      assert.equal(allowReadOf(settings), undefined);
    });

    // Review of #437: a folder whose name starts with a login's is not at, inside or around it.
    it("re-opens a folder beside a hidden login whose name starts with the login's", () => {
      const entries = [`${HOME}/.sshtools/bin`, `${HOME}/.aws-vault/bin`, `${HOME}/.conf/bin`];
      assert.deepEqual(reopened(entries.join(':')), entries);
    });

    // Review of #437: only a layout's own bin goes up to its prefix.
    it("re-opens a folder deeper than a layout's bin as it is", () => {
      assert.deepEqual(reopened(`${HOME}/.volta/bin/sub:${HOME}/.asdf/shims/x`), [
        `${HOME}/.volta/bin/sub`,
        `${HOME}/.asdf/shims/x`,
      ]);
    });

    // Review of #437: a moved login spelled with a trailing slash is the same folder.
    it('re-opens no folder inside a moved login spelled with a trailing slash', () => {
      const settings = settingsFor(`${HOME}/ghc/bin:${HOME}/ghd/bin`, {
        configDirs: { GH_CONFIG_DIR: `${HOME}/ghc/` },
      });
      assert.deepEqual(allowReadOf(settings), [`${HOME}/ghd/bin`]);
    });

    // Review of #437: npm reads its global configuration from `<prefix>/etc/npmrc` and its builtin
    // one from the npm package's own `npmrc`, and either can hold the login ADR 0087 hides as
    // `~/.npmrc`; a deny holds inside a wider allow, a wildcard one too.
    it('hides every npm configuration file inside each folder it re-opens', () => {
      const folders = [
        `${HOME}/.nvm/versions/node/v24.15.0`,
        `${HOME}/.volta`,
        '/home/linuxbrew/.linuxbrew',
        `${HOME}/bin`,
      ];
      const PATH = [
        `${HOME}/.nvm/versions/node/v24.15.0/bin`,
        `${HOME}/.volta/bin`,
        '/home/linuxbrew/.linuxbrew/bin',
        `${HOME}/bin`,
      ].join(':');
      const settings = settingsFor(PATH);
      assert.deepEqual(allowReadOf(settings), folders);
      assert.deepEqual(
        denyReadOf(settings),
        folders.flatMap((folder) => [`${folder}/**/npmrc`, `${folder}/**/.npmrc`]),
      );
    });
  });
  it('refuses a rule claude could not read', () => {
    assert.throws(
      () => attemptSettings({ allow: ['Bash(npm test'], deny: [], sandbox: false }),
      /allow/,
    );
    assert.throws(
      () => attemptSettings({ allow: ['AskUserQuestion'], deny: [], sandbox: false }),
      /AskUserQuestion/,
    );
  });
});

// #135: under dontAsk a bare file-tool rule allows its tool anywhere on disk. Claude Code checks
// file permissions against Edit(path) and Read(path) rules only, and Edit rules apply to every
// tool that edits files, so the worktree is Read(./**) and Edit(./**), never Write(./**) (ADR 0093).
describe('attemptSettings and the file tools', () => {
  for (const tool of ['Read', 'Grep', 'Glob']) {
    it(`scopes a bare ${tool} to the worktree as Read(./**)`, () => {
      const settings = attemptSettings({ allow: [tool], deny: [], sandbox: false });
      assert.deepEqual(settings.permissions.allow, ['Read(./**)']);
    });
  }

  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    it(`scopes a bare ${tool} to the worktree as Edit(./**)`, () => {
      const settings = attemptSettings({ allow: [tool], deny: [], sandbox: false });
      assert.deepEqual(settings.permissions.allow, ['Edit(./**)']);
    });
  }

  it('names each scoped rule once, where the first of its tools stood', () => {
    const settings = attemptSettings({
      allow: ['Bash(npm test)', 'Write', 'Read', 'Edit', 'Grep', 'Glob', 'Read(src/**)'],
      deny: [],
      sandbox: false,
    });
    assert.deepEqual(settings.permissions.allow, [
      'Bash(npm test)',
      'Edit(./**)',
      'Read(./**)',
      'Read(src/**)',
    ]);
  });

  it('keeps Read and Edit path rules, and bare file tools in deny, as they are', () => {
    const settings = attemptSettings({
      allow: ['Read(src/**)', 'Edit(docs/**)'],
      deny: ['Write', 'NotebookEdit', 'Read(.env)'],
      sandbox: false,
    });
    assert.deepEqual(settings.permissions, {
      allow: ['Read(src/**)', 'Edit(docs/**)'],
      deny: ['Write', 'NotebookEdit', 'Read(.env)', 'AskUserQuestion'],
    });
  });

  for (const [rule, instead] of [
    ['Write(brew.md)', 'Edit(brew.md)'],
    ['MultiEdit(src/**)', 'Edit(src/**)'],
    ['NotebookEdit(./**)', 'Edit(./**)'],
    ['Glob(src/**)', 'Read(src/**)'],
  ] as const) {
    it(`refuses ${rule}, which Claude Code never consults, naming ${instead}`, () => {
      for (const permissions of [
        { allow: [rule], deny: [] },
        { allow: [], deny: [rule] },
      ]) {
        assert.throws(
          () => attemptSettings({ ...permissions, sandbox: false }),
          (error: Error) => error.message.includes(instead),
          JSON.stringify(permissions),
        );
      }
    });
  }
});

// #167: claude matches a deny rule against the command as written, so `git -C . push` gets past
// `Bash(git push *)`, and `git p''ush` past any pattern. A push is denied only when no allow rule
// matches it, so the settings never allow git with no fixed subcommand (ADR 0062).
describe('attemptSettings and git with options before the subcommand', () => {
  const pushes = [
    'git -C . push',
    'git -c x=y push origin',
    'git --git-dir=.git push',
    "git p''ush origin",
  ];

  for (const shell of ['Bash', 'PowerShell']) {
    for (const rule of [
      shell,
      `${shell}(*)`,
      `${shell}(g*)`,
      `${shell}(git*)`,
      `${shell}(git *)`,
      `${shell}(git:*)`,
      `${shell}(GIT *)`,
      `${shell}(git.exe *)`,
      `${shell}(git -C *)`,
      `${shell}(git -c *)`,
      `${shell}(git --git-dir=*)`,
      `${shell}(git p*)`,
      `${shell}(git push*)`,
      `${shell}(git -C . push)`,
      `${shell}(git push)`,
      `${shell}(git push *)`,
      `${shell}(git push origin)`,
      `${shell}(git.e*)`,
      // The program word spelt another way, or a wrapper that runs git (review of #170).
      `${shell}(/*)`,
      `${shell}(./*)`,
      `${shell}( git *)`,
      `${shell}(/usr/bin/git *)`,
      `${shell}(/mingw64/bin/git -C . push)`,
      `${shell}(C:\\Git\\cmd\\git.exe *)`,
      `${shell}(\\git *)`,
      `${shell}('git' *)`,
      `${shell}("git" *)`,
      `${shell}(& git *)`,
      `${shell}(GIT_DIR=.git git *)`,
      `${shell}(env git *)`,
      `${shell}(command git *)`,
      `${shell}(xargs *)`,
      `${shell}(env git -C . push)`,
      `${shell}(env /usr/bin/git -C . push)`,
      `${shell}(env git.exe -C . push)`,
      // Subcommands that push, or run commands of their own.
      `${shell}(git send-pack *)`,
      `${shell}(git http-push *)`,
      `${shell}(git subtree *)`,
      `${shell}(git submodule *)`,
      `${shell}(git s*)`,
      // git's own programs and Windows shims (second round of the review).
      `${shell}(git-push *)`,
      `${shell}(/usr/lib/git-core/git-push origin)`,
      `${shell}(git-send-pack *)`,
      `${shell}(git-status *)`,
      `${shell}(git.cmd *)`,
      `${shell}(git.bat *)`,
      `${shell}(C:\\tools\\git.cmd -C . push)`,
      `${shell}(env git.cmd -C . push)`,
      // A backslash quotes in Bash: g\it runs git.
      ...(shell === 'Bash' ? ['Bash(g\\it *)', 'Bash(C:/Program\\ Files/Git/cmd/git.exe *)'] : []),
      // git spelt another way after a wrapper (review of #225).
      `${shell}(env g''it -C . push)`,
      ...(shell === 'Bash' ? ['Bash(env g\\it -C . push)'] : []),
      `${shell}(env /usr/bin/gi? -C . push)`,
      `${shell}(cmd /c g^it -C . push)`,
    ]) {
      it(`refuses to allow ${rule}, which reaches a push`, () => {
        assert.throws(
          () => attemptSettings({ allow: ['Read', rule], deny: [], sandbox: false }),
          /git with no fixed subcommand/,
        );
      });
    }

    // Every wrapper ADR 0062 lists, with a star: each runs `git -C . push` as its argument.
    for (const wrapper of [
      ...['env', 'command', 'exec', 'builtin', 'xargs', 'sudo', 'doas', 'nice', 'nohup', 'time'],
      ...['timeout', 'stdbuf', 'npx', 'eval', 'source', '.', 'iex', 'invoke-expression'],
      ...['start-process', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'pwsh', 'powershell'],
    ]) {
      const rule = `${shell}(${wrapper} *)`;
      it(`refuses to allow ${rule}, a wrapper that runs any command`, () => {
        assert.throws(
          () => attemptSettings({ allow: ['Read', rule], deny: [], sandbox: false }),
          /git with no fixed subcommand/,
        );
      });
    }

    for (const rule of [
      `${shell}(git status)`,
      `${shell}(git status *)`,
      `${shell}(git commit*)`,
      `${shell}(git diff:*)`,
      `${shell}(npm test)`,
      `${shell}(npm run *)`,
      // A complete subcommand that only starts like push.
      `${shell}(git pu)`,
      `${shell}(git pu *)`,
      `${shell}(./gradlew *)`,
      `${shell}(bash ./build.sh)`,
      `${shell}(npx tsc)`,
      `${shell}(git-lfs install)`,
      // In PowerShell a backslash is a path separator, not a quote.
      ...(shell === 'PowerShell' ? ['PowerShell(C:\\tools\\gradlew.bat *)'] : []),
    ]) {
      it(`allows ${rule}, which reaches none of the pushes`, () => {
        const settings = attemptSettings({ allow: [rule], deny: [], sandbox: false });
        for (const push of pushes) {
          assert.equal(withinCeiling(`${shell}(${push})`, settings.permissions.allow), false, push);
        }
      });
    }
  }
});

// #204: gh answers from the maintainer's login in the OS keyring, and a brewer runs as the same
// OS user, so no rule a brewer may have starts gh: only the engine talks to GitHub (ADR 0082).
describe('attemptSettings and gh', () => {
  const ghCalls = ['gh api user', 'gh pr merge 1', 'gh auth token'];

  for (const shell of ['Bash', 'PowerShell']) {
    for (const rule of [
      shell,
      `${shell}(*)`,
      `${shell}(g*)`,
      `${shell}(gh)`,
      `${shell}(gh *)`,
      `${shell}(gh:*)`,
      `${shell}(GH *)`,
      `${shell}( gh *)`,
      `${shell}(gh api user)`,
      `${shell}(gh pr view *)`,
      `${shell}(gh --version)`,
      `${shell}(gh.exe *)`,
      `${shell}(gh.cmd api user)`,
      `${shell}(/usr/bin/gh *)`,
      `${shell}(C:\\Tools\\gh.exe api user)`,
      `${shell}('gh' *)`,
      `${shell}(& gh *)`,
      `${shell}(GH_HOST=github.com gh *)`,
      `${shell}(env gh api user)`,
      `${shell}(command /usr/bin/gh *)`,
      `${shell}(xargs gh)`,
      `${shell}(xargs *)`,
      ...(shell === 'Bash' ? ['Bash(g\\h *)'] : []),
      // gh spelt another way after a wrapper, and git asking gh, its credential helper, for the
      // login (review of #225).
      `${shell}(env g""h auth token)`,
      `${shell}(bash -c "g"h pr merge 1)`,
      `${shell}(env $(echo gh) api user)`,
      ...(shell === 'Bash' ? ['Bash(env g\\h api user)'] : ['PowerShell(env g`h api user)']),
      `${shell}(git credential fill)`,
      `${shell}(git credential-store get)`,
      `${shell}(git c*)`,
      `${shell}(/usr/bin/git credential *)`,
      `${shell}(git-credential-manager get)`,
      // gh by path or with a Windows extension after a wrapper (second review of #225).
      `${shell}(env /usr/bin/gh api user)`,
      `${shell}(env gh.exe api user)`,
      `${shell}(xargs c:/tools/gh.cmd pr merge 1)`,
      // A glob, a brace, cmd's escapes, or a backslash a POSIX shell reads (second review of #225).
      `${shell}(env /usr/bin/g? auth token)`,
      `${shell}(env /usr/bin/g[h] api user)`,
      `${shell}(env {gh,} auth token)`,
      `${shell}(cmd /c g^h auth token)`,
      `${shell}(cmd /c g%pathext:~0,0%h api user)`,
      ...(shell === 'PowerShell' ? ['PowerShell(bash -c g\\h api user)'] : []),
    ]) {
      it(`refuses to allow ${rule}, which starts gh`, () => {
        assert.throws(
          () => attemptSettings({ allow: ['Read', rule], deny: [], sandbox: false }),
          /only the engine talks to GitHub/,
        );
      });
    }

    for (const rule of [
      `${shell}(git status *)`,
      `${shell}(npm test)`,
      `${shell}(npm run *)`,
      `${shell}(npx tsc)`,
      `${shell}(ghc --make Main)`,
      `${shell}(cat gh.txt)`,
      `${shell}(npm run gh)`,
      `${shell}(git-lfs install)`,
      // A wrapper followed by plain words (second review of #225).
      `${shell}(env NODE_ENV=test npm test)`,
      `${shell}(timeout 60 npm test)`,
    ]) {
      it(`allows ${rule}, which starts no gh`, () => {
        const settings = attemptSettings({ allow: [rule], deny: [], sandbox: false });
        for (const call of ghCalls) {
          assert.equal(withinCeiling(`${shell}(${call})`, settings.permissions.allow), false, call);
        }
      });
    }
  }
});

// A valid sandbox block; each refused row below changes one thing in it, so it is refused for
// that reason alone.
const sandboxBlock = {
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: false,
  credentials: sandboxCredentials,
};
const sandboxed = (
  sandbox: object,
  block: object = { blockReadsOutsideWorkingDirectories: true },
) => ({
  permissions: { allow: [], deny: ['AskUserQuestion'], ...block },
  sandbox,
});
const withoutKey = (block: object, key: string) =>
  Object.fromEntries(Object.entries(block).filter(([name]) => name !== key));

describe('writeAttemptSettings', () => {
  let dir: TempDir;
  let file: string;
  beforeEach(() => {
    dir = makeTempDir('attempt-settings');
    file = join(dir.path, 'settings.json');
  });
  afterEach(() => dir.remove());

  it('writes the settings as JSON', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: false });
    writeAttemptSettings(file, settings);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      permissions: { allow: ['Read(./**)'], deny: ['AskUserQuestion'] },
      attribution: { commit: '', pr: '', sessionUrl: false },
    });
  });

  // The schema must read the key, or the whole file is refused and no brewer starts (ADR 0151).
  it('writes the attribution of a sandboxed attempt too', () => {
    const settings = attemptSettings({ allow: ['Read'], deny: [], sandbox: true });
    writeAttemptSettings(file, settings);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).attribution, {
      commit: '',
      pr: '',
      sessionUrl: false,
    });
  });

  // The refused rows below each change one key of this block.
  it("writes a sandboxed attempt's settings", () => {
    writeAttemptSettings(file, sandboxed(sandboxBlock) as AttemptSettings);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), sandboxed(sandboxBlock));
  });

  // claude would drop the whole file silently, deny rules included (ADR 0042).
  for (const [what, settings, reason] of [
    ['an unknown key', { permissions: { allow: [], deny: ['AskUserQuestion'] }, model: 'x' }],
    ['a value of the wrong type', { permissions: { allow: 'Read', deny: ['AskUserQuestion'] } }],
    ['a deny list without AskUserQuestion', { permissions: { allow: ['Read(./**)'], deny: [] } }],
    // #135: a bare file-tool rule allows its tool anywhere on disk (ADR 0093).
    ...(['Read', 'Grep', 'Glob'] as const).map(
      (tool) =>
        [
          `a bare ${tool} rule`,
          { permissions: { allow: [tool], deny: ['AskUserQuestion'] } },
          /Read\(\.\/\*\*\)/,
        ] as const,
    ),
    ...(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const).map(
      (tool) =>
        [
          `a bare ${tool} rule`,
          { permissions: { allow: [tool], deny: ['AskUserQuestion'] } },
          /Edit\(\.\/\*\*\)/,
        ] as const,
    ),
    [
      'a Write path rule, which Claude Code never consults',
      { permissions: { allow: ['Write(./**)'], deny: ['AskUserQuestion'] } },
      /Edit\(\.\/\*\*\)/,
    ],
    [
      'a Glob path rule in deny, which Claude Code never consults',
      { permissions: { allow: [], deny: ['AskUserQuestion', 'Glob(secrets/**)'] } },
      /Read\(secrets\/\*\*\)/,
    ],
    [
      'a shell without its git push deny',
      { permissions: { allow: ['Bash(npm test)'], deny: ['AskUserQuestion'] } },
    ],
    [
      'git with no fixed subcommand',
      { permissions: { allow: ['Bash(git *)'], deny: ['AskUserQuestion', 'Bash(git push *)'] } },
      /git with no fixed subcommand/,
    ],
    [
      'a sandbox that may fall back to running unsandboxed',
      sandboxed({ ...sandboxBlock, failIfUnavailable: false }),
      /failIfUnavailable/,
    ],
    [
      'a sandbox that runs every sandboxed command without the allow rules',
      sandboxed(withoutKey(sandboxBlock, 'autoAllowBashIfSandboxed')),
      /autoAllowBashIfSandboxed/,
    ],
    [
      'a sandbox that leaves a credential variable set',
      sandboxed({
        ...sandboxBlock,
        credentials: {
          ...sandboxCredentials,
          envVars: sandboxCredentials.envVars.filter(({ name }) => name !== 'GH_TOKEN'),
        },
      }),
      /Must hide every credential/,
    ],
    [
      'a sandbox that leaves a credential file readable',
      sandboxed({
        ...sandboxBlock,
        credentials: {
          ...sandboxCredentials,
          files: sandboxCredentials.files.filter(({ path }) => path !== '~/.config/gh'),
        },
      }),
      /Must hide every credential/,
    ],
    [
      'a sandbox without the read block',
      sandboxed(sandboxBlock, {}),
      /blockReadsOutsideWorkingDirectories/,
    ],
    [
      'a read block that is off',
      sandboxed(sandboxBlock, { blockReadsOutsideWorkingDirectories: false }),
      /blockReadsOutsideWorkingDirectories/,
    ],
    [
      'a sandbox that hides no credentials',
      sandboxed(withoutKey(sandboxBlock, 'credentials')),
      /credentials/,
    ],
    [
      'a sandbox that auto-allows sandboxed commands',
      sandboxed({ ...sandboxBlock, autoAllowBashIfSandboxed: true }),
      /autoAllowBashIfSandboxed/,
    ],
    [
      'a credential file masked instead of denied',
      sandboxed({
        ...sandboxBlock,
        credentials: {
          ...sandboxCredentials,
          files: sandboxCredentials.files.map((entry) => ({ ...entry, mode: 'mask' })),
        },
      }),
      /files/,
    ],
    [
      'a credential variable masked instead of denied',
      sandboxed({
        ...sandboxBlock,
        credentials: {
          ...sandboxCredentials,
          envVars: sandboxCredentials.envVars.map((entry) => ({ ...entry, mode: 'mask' })),
        },
      }),
      /envVars/,
    ],
  ] as const) {
    it(`refuses ${what}, and writes nothing`, () => {
      assert.throws(
        () => writeAttemptSettings(file, settings as unknown as AttemptSettings),
        /settings/,
      );
      // A row with its own pattern is refused for that reason, not another one.
      if (reason !== undefined) {
        assert.throws(
          () => writeAttemptSettings(file, settings as unknown as AttemptSettings),
          reason,
        );
      }
      assert.equal(existsSync(file), false);
    });
  }
});

describe('configDirsOf', () => {
  it('keeps only the variables that move a login', () => {
    assert.deepEqual(
      configDirsOf({
        GH_CONFIG_DIR: '/srv/gh',
        XDG_CONFIG_HOME: '/data/config',
        CLAUDE_CONFIG_DIR: '/data/claude',
        HOME: '/home/brewer',
        GH_TOKEN: 'not-a-token',
      }),
      {
        GH_CONFIG_DIR: '/srv/gh',
        XDG_CONFIG_HOME: '/data/config',
        CLAUDE_CONFIG_DIR: '/data/claude',
      },
    );
  });

  it('leaves out the variables that are not set', () => {
    assert.deepEqual(configDirsOf({ XDG_CONFIG_HOME: '/data/config', GH_CONFIG_DIR: undefined }), {
      XDG_CONFIG_HOME: '/data/config',
    });
  });
});

describe('toolchainOf', () => {
  it('keeps only the home and the PATH', () => {
    assert.deepEqual(
      toolchainOf({
        HOME: '/home/brewer',
        PATH: '/usr/bin',
        GH_CONFIG_DIR: '/srv/gh',
        NVM_DIR: '/x',
      }),
      { HOME: '/home/brewer', PATH: '/usr/bin' },
    );
  });

  it('leaves out the variables that are not set', () => {
    assert.deepEqual(toolchainOf({ PATH: '/usr/bin', HOME: undefined }), { PATH: '/usr/bin' });
  });
});
