// `foedrum doctor`'s core with plain facts (ADR 0021): which tools are there, the effective
// isolation level (ADR 0010) and what is missing. The report's text is in cli.test.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  credentialHelpersFor,
  type DoctorFacts,
  diagnose,
  formatDiagnosis,
  githubHostOfConfig,
} from '../../src/cli/doctor.ts';
import { INVALID_RECIPES, invalidRecipes } from '../../src/engine/recipe-files.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';
import { linux, loggedIn, macos, ran, windows } from '../helpers/doctor-facts.ts';

const required = (facts: DoctorFacts) =>
  diagnose(facts)
    .problems.filter((problem) => problem.required)
    .map((problem) => problem.what);

describe('diagnose: tools', () => {
  it('reads each version from what the tool printed, and keeps its path', () => {
    assert.deepEqual(diagnose(linux()).tools, [
      { name: 'node', version: '24.20.0', path: undefined },
      { name: 'npm', version: '11.6.2', path: '/usr/bin/npm' },
      { name: 'git', version: '2.47.1', path: '/usr/bin/git' },
      { name: 'gh', version: '2.102.0', path: '/usr/bin/gh' },
      { name: 'claude', version: '2.1.301', path: '/home/brewer/.local/bin/claude' },
      { name: 'bwrap', version: '0.9.0', path: '/usr/bin/bwrap' },
      { name: 'socat', version: '1.7.4.4', path: '/usr/bin/socat' },
    ]);
  });

  it('lists bubblewrap and socat on Linux only', () => {
    assert.deepEqual(
      diagnose(windows).tools.map((tool) => tool.name),
      ['node', 'npm', 'git', 'gh', 'claude'],
    );
    assert.deepEqual(
      diagnose(macos).tools.map((tool) => tool.name),
      ['node', 'npm', 'git', 'gh', 'claude'],
    );
  });

  it('reads the version out of a Windows build string', () => {
    assert.equal(diagnose(windows).tools.find((tool) => tool.name === 'git')?.version, '2.47.1');
  });

  it('has no version for a tool whose version command failed, and keeps its path', () => {
    const facts = linux({ npm: ran('/usr/bin/npm', '11.6.2\n', 1) });
    assert.deepEqual(diagnose(facts).tools[1], {
      name: 'npm',
      version: undefined,
      path: '/usr/bin/npm',
    });
  });

  it('is ok with every required tool there', () => {
    const diagnosis = diagnose(linux());
    assert.equal(diagnosis.ok, true);
    assert.deepEqual(diagnosis.problems, []);
  });
});

// Foedrum reaches GitHub only through gh's own login, for the API and as git's credential
// helper (ADR 0073).
describe('diagnose: gh and its login (ADR 0073)', () => {
  const problems = (facts: DoctorFacts) =>
    diagnose(facts).problems.map(({ required, what, fix }) => ({ required, what, fix }));
  const github = (facts: DoctorFacts) => ({
    ...(facts.github ?? loggedIn()),
  });

  it('is not ok without gh, and says where to get it and to log in', () => {
    assert.deepEqual(problems(linux({ gh: undefined })), [
      {
        required: true,
        what: 'gh not found',
        fix: 'install the GitHub CLI 2.26.0 or later, https://cli.github.com, then run gh auth login',
      },
    ]);
    assert.equal(diagnose(linux({ gh: undefined })).ok, false);
  });

  it('is not ok with a gh older than 2.26.0, which keeps its login in the keyring', () => {
    assert.deepEqual(
      required(linux({ gh: ran('/usr/bin/gh', 'gh version 2.25.1 (2023-03-21)\n') })),
      ['gh 2.25.1 is too old'],
    );
    for (const version of ['2.26.0', '2.26.1', '3.0.0']) {
      const facts = linux({ gh: ran('/usr/bin/gh', `gh version ${version} (2026-01-01)\n`) });
      assert.equal(diagnose(facts).ok, true, version);
    }
  });

  it("is not ok with a git older than 2.31.0, which ignores a brewer's forced configuration (ADR 0109)", () => {
    assert.deepEqual(problems(linux({ git: ran('/usr/bin/git', 'git version 2.30.9\n') })), [
      {
        required: true,
        what: 'git 2.30.9 is too old',
        fix: 'install git 2.31.0 or later, https://git-scm.com/downloads',
      },
    ]);
    for (const version of ['2.31.0', '2.47.1.windows.1', '3.0.0']) {
      const facts = linux({ git: ran('/usr/bin/git', `git version ${version}\n`) });
      assert.equal(diagnose(facts).ok, true, version);
    }
  });

  it('is not ok when gh does not answer its version', () => {
    assert.deepEqual(required(linux({ gh: ran('/usr/bin/gh', 'boom\n', 1) })), [
      'gh at /usr/bin/gh did not report a version',
    ]);
  });

  // gh auth status fails for more than a missing login: a token gh can no longer use, no network.
  it("says what gh said when its login check failed, after the host's own line", () => {
    const facts = linux();
    facts.github = {
      ...loggedIn(),
      login: ran(
        '',
        'github.com\n  X Timeout trying to log in to github.com account brewer (keyring)\n  - Active account: true\n',
        1,
      ),
    };
    assert.deepEqual(problems(facts), [
      {
        required: true,
        what: 'gh is not logged in to github.com (X Timeout trying to log in to github.com account brewer (keyring))',
        fix: 'run gh auth login --hostname github.com',
      },
    ]);
  });

  // A report is pasted into issues: gh's token line, masked or not, never goes into it.
  it("never quotes gh's token line, or a line that holds a token, as what gh said", () => {
    const facts = linux();
    facts.github = {
      ...loggedIn(),
      login: ran(
        '',
        'github.com\n  - Token: gho_************************************\n  - see ghp_abcdefghijklmnopqrstuvwxyz0123456789\n  X Failed to log in to github.com account brewer (keyring)\n',
        1,
      ),
    };
    assert.deepEqual(
      problems(facts).map(({ what }) => what),
      [
        'gh is not logged in to github.com (X Failed to log in to github.com account brewer (keyring))',
      ],
    );
  });

  it('reports a gh auth status that did not answer apart, with what the runner said', () => {
    const facts = linux();
    facts.github = { ...loggedIn(), login: ran('', 'timed out after 10 s\n', null) };
    assert.deepEqual(problems(facts), [
      {
        required: true,
        what: 'gh auth status --hostname github.com did not answer (timed out after 10 s)',
        fix: 'check that gh auth status --hostname github.com works',
      },
    ]);
  });

  it("is not ok when gh has no login for the Brewery's host, and names the login to make", () => {
    const facts = linux();
    facts.github = {
      ...loggedIn('ghe.example'),
      login: ran(
        '',
        'You are not logged into any GitHub hosts. To log in, run: gh auth login\n',
        1,
      ),
    };
    assert.deepEqual(problems(facts), [
      {
        required: true,
        what: 'gh is not logged in to ghe.example',
        fix: 'run gh auth login --hostname ghe.example',
      },
    ]);
  });

  it('advises gh auth setup-git when git asks another helper first, naming it', () => {
    const facts = linux();
    facts.github = {
      ...github(facts),
      credentials: ran(
        '',
        'credential.helper\nmanager\0credential.https://github.com.helper\n!/usr/bin/gh auth git-credential\0',
      ),
    };
    assert.deepEqual(problems(facts), [
      {
        required: false,
        what: 'git asks manager for https://github.com credentials, not gh',
        fix: "run gh auth setup-git --hostname github.com, so git pushes with gh's login",
      },
    ]);
    assert.equal(diagnose(facts).ok, true);
  });

  it('does not take a helper whose name only ends or starts like gh for gh', () => {
    for (const helper of ['!/usr/bin/sigh auth git-credential', '!gh auth git-credential-store']) {
      const facts = linux();
      facts.github = {
        ...loggedIn(),
        credentials: ran('', `credential.https://github.com.helper\n${helper}\0`),
      };
      assert.deepEqual(
        problems(facts).map(({ what }) => what),
        [`git asks ${helper} for https://github.com credentials, not gh`],
        helper,
      );
    }
  });

  // Only git's exit 1 means that no setting matched; anything else is git failing to say.
  it('says git config did not answer, instead of no helper, when it failed or was killed', () => {
    for (const [output, code, because] of [
      ['timed out after 10 s\n', null, ' (timed out after 10 s)'],
      ['', 128, ''],
    ] as const) {
      const facts = linux();
      facts.github = { ...loggedIn(), credentials: ran('', output, code) };
      assert.deepEqual(problems(facts), [
        {
          required: false,
          what: `git config did not list its credential helpers${because}`,
          fix: 'check that git config --get-regexp ^credential\\. works in this folder',
        },
      ]);
    }
  });

  it('advises gh auth setup-git when git has no credential helper for the host', () => {
    const facts = linux();
    // git config --get-regexp exits 1 when nothing matches.
    facts.github = { ...github(facts), credentials: ran('', '', 1) };
    assert.deepEqual(problems(facts), [
      {
        required: false,
        what: 'git has no credential helper for https://github.com',
        fix: "run gh auth setup-git --hostname github.com, so git pushes with gh's login",
      },
    ]);
  });

  it("is content with the helper gh auth setup-git writes, Windows' path included", () => {
    for (const facts of [linux(), windows, macos]) {
      assert.deepEqual(problems(facts), [], facts.platform);
    }
    const facts = linux();
    facts.github = {
      ...github(facts),
      // Git for Windows' system configuration, then the user's, as git 2.56.0 printed it.
      credentials: ran(
        '',
        "credential.helper\nmanager\0credential.https://github.com.helper\n\0credential.https://github.com.helper\n!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential\0credential.https://gist.github.com.helper\n\0",
      ),
    };
    assert.deepEqual(problems(facts), []);
  });

  it('asks nothing of the login and the helpers when it has no facts about them', () => {
    const facts = linux();
    facts.github = { host: 'github.com', login: undefined, credentials: undefined };
    assert.deepEqual(problems(facts), []);
  });
});

describe('credentialHelpersFor', () => {
  const listed = (entries: [string, string][]) =>
    entries.map(([key, value]) => `${key}\n${value}\0`).join('');

  it("lists the helpers in git's order, the general ones and those of a URL that covers the host", () => {
    const config = listed([
      ['credential.helper', 'cache'],
      ['credential.https://github.com.helper', 'gh-one'],
      ['credential.https://github.com/.helper', 'gh-two'],
      ['credential.https://ghe.example.helper', 'other-host'],
      ['credential.http://github.com.helper', 'plain-http'],
      ['credential.https://github.com/acme.helper', 'one-path'],
      ['credential.https://me@github.com.helper', 'one-user'],
      ['credential.https://github.com:8443.helper', 'other-port'],
      ['credential.https://github.com.username', 'me'],
    ]);
    assert.deepEqual(credentialHelpersFor('github.com', config), ['cache', 'gh-one', 'gh-two']);
    assert.deepEqual(credentialHelpersFor('ghe.example', config), ['cache', 'other-host']);
  });

  it('clears the list at an empty value, as git does', () => {
    const config = listed([
      ['credential.helper', 'manager'],
      ['credential.https://github.com.helper', ''],
      ['credential.https://github.com.helper', 'gh'],
    ]);
    assert.deepEqual(credentialHelpersFor('github.com', config), ['gh']);
    assert.deepEqual(credentialHelpersFor('ghe.example', config), ['manager']);
  });

  it('reads a key without a value as empty, and nothing as no helper', () => {
    assert.deepEqual(credentialHelpersFor('github.com', 'credential.helper\0'), []);
    assert.deepEqual(credentialHelpersFor('github.com', ''), []);
  });

  it('compares the host as git does, without regard to case', () => {
    const config = listed([['credential.https://GitHub.com.helper', 'gh']]);
    assert.deepEqual(credentialHelpersFor('github.com', config), ['gh']);
  });
});

describe('githubHostOfConfig', () => {
  it("names the host of foedrum.jsonc's githubApi, else github.com", () => {
    const config = (githubApi?: string) =>
      JSON.stringify({ repositories: {}, ...(githubApi === undefined ? {} : { githubApi }) });
    assert.equal(githubHostOfConfig(undefined), 'github.com');
    assert.equal(githubHostOfConfig(config()), 'github.com');
    assert.equal(githubHostOfConfig(config('https://ghe.example/api/v3')), 'ghe.example');
    assert.equal(githubHostOfConfig(config('http://api.github.localhost')), 'github.localhost');
    assert.equal(githubHostOfConfig('{ not jsonc'), 'github.com');
  });
});

describe('diagnose: required tools', () => {
  it('is not ok without git or claude', () => {
    const facts = linux({ git: undefined, claude: undefined });
    assert.equal(diagnose(facts).ok, false);
    assert.deepEqual(required(facts), ['git not found', 'claude not found']);
  });

  it('is not ok when git or claude is there but does not answer its version command', () => {
    const facts = linux({ claude: ran('/home/brewer/.local/bin/claude', 'segfault', null) });
    assert.equal(diagnose(facts).ok, false);
    assert.deepEqual(required(facts), [
      'claude at /home/brewer/.local/bin/claude did not report a version',
    ]);
  });

  it('says why the version command failed, from the first line it or the runner printed', () => {
    const path = 'C:\\Users\\R&D\\AppData\\Roaming\\npm\\claude.cmd';
    const refused = `the file "${path}" cannot go through the Windows shell: only letters, digits`;
    const facts = {
      ...windows,
      tools: { ...windows.tools, claude: ran(path, `${refused}\n`, null) },
    };
    const [problem] = diagnose(facts).problems;
    assert.equal(problem?.fix, `\`claude --version\` failed: ${refused}`);
  });

  it('asks to check the version command when it failed without a word', () => {
    const facts = linux({ git: ran('/usr/bin/git', '\n', 1) });
    const [problem] = diagnose(facts).problems;
    assert.equal(problem?.fix, 'check that `git --version` works');
  });

  // Brewers run only in a Job Object on Windows; where PowerShell may not create one (Constrained
  // Language Mode), WSL2 is the way to run them (ADR 0039).
  it('is not ok on Windows when no process can be held in a Job Object, and recommends WSL2', () => {
    const said =
      'node.exe: cannot run in a Job Object: PowerShell runs in ConstrainedLanguage mode';
    const facts = { ...windows, jobObject: { exitCode: null, output: `${said}\n` } };
    assert.equal(diagnose(facts).ok, false);
    assert.deepEqual(diagnose(facts).problems, [
      {
        required: true,
        what: `Windows cannot hold a brewer's processes in a Job Object (${said})`,
        fix: 'Foedrum needs PowerShell in Full Language mode to stop every process a brewer starts; where a policy keeps it in Constrained Language Mode, run Foedrum inside WSL2',
      },
    ]);
  });

  it('is ok on Windows when a process held in a Job Object answered', () => {
    assert.equal(diagnose(windows).ok, true);
    assert.deepEqual(diagnose(windows).problems, []);
  });

  it('is not ok on Windows when the Job Object probe failed without a word', () => {
    const facts = { ...windows, jobObject: { exitCode: 1, output: '' } };
    assert.deepEqual(required(facts), ["Windows cannot hold a brewer's processes in a Job Object"]);
  });

  it('is not ok on a Node older than 24.15', () => {
    assert.deepEqual(required({ ...linux(), node: '24.14.9' }), ['node 24.14.9 is too old']);
    assert.deepEqual(required({ ...linux(), node: '22.20.0' }), ['node 22.20.0 is too old']);
    assert.deepEqual(required({ ...linux(), node: '24.15.0' }), []);
    assert.deepEqual(required({ ...linux(), node: '25.0.0' }), []);
  });

  it('reports a missing npm without failing: Foedrum runs without it', () => {
    const diagnosis = diagnose(linux({ npm: undefined }));
    assert.equal(diagnosis.ok, true);
    assert.deepEqual(
      diagnosis.problems.map(({ required, what }) => ({ required, what })),
      [{ required: false, what: 'npm not found' }],
    );
  });
});

describe('diagnose: isolation (ADR 0010)', () => {
  it('is sandboxed on macOS', () => {
    assert.equal(diagnose(macos).isolation.level, 'sandboxed');
  });

  it('is sandboxed on Linux with bubblewrap and socat', () => {
    assert.equal(diagnose(linux()).isolation.level, 'sandboxed');
  });

  it('is sandboxed on WSL2 with bubblewrap and socat', () => {
    const wsl2 = { ...linux(), kernelRelease: '5.15.153.1-microsoft-standard-WSL2' };
    assert.equal(diagnose(wsl2).isolation.level, 'sandboxed');
    assert.deepEqual(
      diagnose(wsl2).advice.filter((line) => /WSL2/.test(line)),
      [],
    );
  });

  it('is sandboxed on a WSL 2 kernel from before the WSL2 suffix', () => {
    const wsl2 = { ...linux(), kernelRelease: '4.19.128-microsoft-standard' };
    assert.equal(diagnose(wsl2).isolation.level, 'sandboxed');
    assert.deepEqual(
      diagnose(wsl2).advice.filter((line) => /WSL2/.test(line)),
      [],
    );
  });

  it('is permissions only on Linux without bubblewrap or socat, which it reports as missing', () => {
    for (const missing of ['bwrap', 'socat'] as const) {
      const diagnosis = diagnose(linux({ [missing]: undefined }));
      assert.equal(diagnosis.isolation.level, 'permissions only');
      assert.equal(diagnosis.ok, true, 'the sandbox is not required');
      assert.equal(diagnosis.problems.length, 1);
      assert.equal(diagnosis.problems[0]?.required, false);
      assert.match(diagnosis.problems[0]?.what ?? '', new RegExp(`\\b${missing}\\b`));
    }
  });

  it('is permissions only on native Windows, and recommends WSL2', () => {
    const diagnosis = diagnose(windows);
    assert.equal(diagnosis.isolation.level, 'permissions only');
    assert.equal(diagnosis.ok, true);
    assert.equal(diagnosis.advice.length, 2, 'WSL2, and what the level leaves open (ADR 0082)');
    assert.match(diagnosis.advice[0] ?? '', /WSL2/);
  });

  it('is permissions only on WSL 1, and recommends WSL2', () => {
    const wsl1 = { ...linux(), kernelRelease: '4.4.0-19041-Microsoft' };
    const diagnosis = diagnose(wsl1);
    assert.equal(diagnosis.isolation.level, 'permissions only');
    assert.match(diagnosis.advice[0] ?? '', /WSL2/);
  });

  it('is permissions only on an operating system without a sandbox', () => {
    const freebsd: DoctorFacts = { ...macos, platform: 'freebsd' };
    assert.equal(diagnose(freebsd).isolation.level, 'permissions only');
  });

  it('names a container runtime, Podman before Docker, as the optional container level', () => {
    assert.equal(diagnose(linux()).container, undefined);
    const docker = ran('/usr/bin/docker', 'Docker version 27.3.1, build ce12230\n');
    const podman = ran('/usr/bin/podman', 'podman version 5.2.0\n');
    assert.deepEqual(diagnose(linux({ docker })).container, {
      name: 'docker',
      version: '27.3.1',
      path: '/usr/bin/docker',
      usable: true,
    });
    assert.deepEqual(diagnose(linux({ docker, podman })).container, {
      name: 'podman',
      version: '5.2.0',
      path: '/usr/bin/podman',
      usable: true,
    });
  });

  it('does not count a container runtime that does not answer its version as available', () => {
    const docker = ran('C:\\Windows\\system32\\docker.exe', 'timed out after 3 s\n', null);
    const { container, ok, problems } = diagnose({
      ...windows,
      tools: { ...windows.tools, docker },
    });
    assert.deepEqual(container, {
      name: 'docker',
      version: undefined,
      path: 'C:\\Windows\\system32\\docker.exe',
      usable: false,
      said: 'timed out after 3 s',
    });
    // The container level is optional: it is no problem, and doctor stays ok.
    assert.equal(ok, true);
    assert.deepEqual(problems, []);
  });

  it('reports Podman as not usable when neither runtime answers its version', () => {
    const podman = ran('/usr/bin/podman', 'timed out after 3 s\n', null);
    const docker = ran('/usr/bin/docker', 'Cannot connect to the Docker daemon\n', 1);
    assert.deepEqual(diagnose(linux({ docker, podman })).container, {
      name: 'podman',
      version: undefined,
      path: '/usr/bin/podman',
      usable: false,
      said: 'timed out after 3 s',
    });
  });

  it('reports a runtime that printed nothing as not answering, without a reason', () => {
    const docker = ran('/usr/bin/docker', '', 1);
    assert.match(
      formatDiagnosis(diagnose(linux({ docker }))),
      /\nContainer: docker at \/usr\/bin\/docker does not answer its version; the container level is not available\n/,
    );
  });

  it('falls through to Docker when Podman does not answer its version', () => {
    const podman = ran('/usr/bin/podman', 'timed out after 3 s\n', null);
    const docker = ran('/usr/bin/docker', 'Docker version 27.3.1, build ce12230\n');
    assert.deepEqual(diagnose(linux({ docker, podman })).container, {
      name: 'docker',
      version: '27.3.1',
      path: '/usr/bin/docker',
      usable: true,
    });
  });

  it('does not count a container runtime whose version command fails or prints no version', () => {
    for (const [output, exitCode] of [
      ['Cannot connect to the Docker daemon\n', 1],
      ['Docker\n', 0],
    ] as const) {
      const docker = ran('/usr/bin/docker', output, exitCode);
      assert.deepEqual(diagnose(linux({ docker })).container, {
        name: 'docker',
        version: undefined,
        path: '/usr/bin/docker',
        usable: false,
        said: output.trim(),
      });
    }
  });
});

// #204: a brewer or a check step runs as the maintainer's OS user, so on the permissions-only level
// it can still read gh's login; the line says what each other level keeps from it (ADR 0082).
// #229: Claude Code's sandbox docs settle the hosts file and the token variables (ADR 0087), not
// the OS keyring, so the sandboxed level never "closes" it; #209 and #235 catch a login read anyway.
describe("diagnose: what each isolation level keeps from gh's login (ADR 0082, #229)", () => {
  const keyring = (facts: DoctorFacts) =>
    diagnose(facts).advice.filter((line) => /keyring/.test(line));
  const wsl1 = { ...linux(), kernelRelease: '4.4.0-19041-Microsoft' };
  const wsl2 = { ...linux(), kernelRelease: '5.15.153.1-microsoft-standard-WSL2' };
  const freebsd = { ...macos, platform: 'freebsd' as const };
  const sandboxed = [macos, linux(), wsl2];
  const permissionsOnly = [windows, wsl1, linux({ bwrap: undefined }), freebsd];

  // What ADR 0087 hides from a sandboxed command, from the docs.
  const hidesFileAndVariables = (line: string) => {
    assert.match(line, /hides gh's hosts file at its default path and the token variables/);
    assert.match(line, /keeps them from reaching GitHub/);
  };
  // The docs say nothing about the Keychain or the Secret Service, so neither does the line.
  const leavesKeyringOpen = (line: string) => {
    assert.match(
      line,
      /Claude Code's docs don't say whether the sandbox stops a read from the OS keyring/,
    );
    assert.doesNotMatch(line, /sandbox(?:ed level)?[^;.]* closes/);
  };

  it('says on every permissions-only level that a brewer or a check step can read the keyring or the hosts file', () => {
    for (const facts of permissionsOnly) {
      const [line, ...more] = keyring(facts);
      assert.deepEqual(more, []);
      assert.match(
        line ?? '',
        /^A brewer or a check step runs as you here, so it can still read gh's login from the OS keyring or its hosts file\./,
      );
    }
  });

  it('says on native Windows and WSL 1 what WSL2 hides and that the container level closes it', () => {
    for (const facts of [windows, wsl1]) {
      const [line = ''] = keyring(facts);
      assert.match(line, /In WSL2, the sandboxed level hides/);
      hidesFileAndVariables(line);
      leavesKeyringOpen(line);
      assert.match(line, /the container level mounts only the worktree, which closes both/);
    }
  });

  it('names bubblewrap and socat for the sandboxed level on Linux without them', () => {
    const [line = ''] = keyring(linux({ bwrap: undefined }));
    assert.match(line, /The sandboxed level \(bubblewrap and socat\) hides/);
    hidesFileAndVariables(line);
    leavesKeyringOpen(line);
    assert.match(line, /the container level mounts only the worktree, which closes both/);
    assert.doesNotMatch(line, /WSL2/);
  });

  it('names only the container level on an operating system without a sandbox', () => {
    const [line = ''] = keyring(freebsd);
    assert.match(line, /The container level mounts only the worktree, which closes both/);
    assert.doesNotMatch(line, /WSL2|sandboxed level/);
  });

  it('says on the sandboxed level what the sandbox hides from a brewer and what it leaves open', () => {
    for (const facts of sandboxed) {
      const [line = '', ...more] = keyring(facts);
      assert.deepEqual(more, []);
      assert.deepEqual(diagnose(facts).advice, [line], 'no other advice on the sandboxed level');
      assert.match(line, /^The sandbox hides gh's hosts file/);
      hidesFileAndVariables(line);
      leavesKeyringOpen(line);
    }
  });

  // ADR 0087's credential entries are Linux `~/` paths, so on WSL2 the Windows user's copies of
  // the same logins under /mnt stay readable (review of #250).
  it("says wherever it advises or runs WSL2 that the sandbox leaves the Windows user's logins readable", () => {
    const wsl2WithoutBwrap = { ...linux({ bwrap: undefined }), kernelRelease: wsl2.kernelRelease };
    for (const facts of [windows, wsl1, wsl2, wsl2WithoutBwrap]) {
      assert.match(
        keyring(facts)[0] ?? '',
        /Under WSL, it doesn't hide the Windows user's logins under \/mnt \(ADR 0087\)\./,
      );
    }
    for (const facts of [macos, linux(), linux({ bwrap: undefined }), freebsd]) {
      assert.doesNotMatch(keyring(facts)[0] ?? '', /\/mnt/);
    }
  });

  // A login a brewer did read can still be written into a commit or an out doc (#229).
  it('names ADR 0079 for a login in a commit and ADR 0088 for one in out doc text on every level', () => {
    for (const facts of [...sandboxed, ...permissionsOnly]) {
      const [line = ''] = keyring(facts);
      assert.match(
        line,
        /A login a brewer did read is stopped at the push \(ADR 0079\) and left out of the pull request and the status comment \(ADR 0088\) when it looks like one\./,
      );
    }
  });

  // Check steps run outside the OS sandbox at every level until #190 (ADR 0069, review of #225).
  // Each level names only what it has (review of #250).
  it('says on every level that check steps keep the login until #190, outside what that level has', () => {
    const outside = (where: string) =>
      new RegExp(
        `Until #190, check steps run outside ${where}, so they can still read gh's login\\.$`,
      );
    for (const facts of sandboxed) {
      assert.match(keyring(facts)[0] ?? '', outside('the sandbox'));
    }
    for (const facts of [windows, wsl1, linux({ bwrap: undefined })]) {
      assert.match(keyring(facts)[0] ?? '', outside('the sandbox and the container'));
    }
    const [line = ''] = keyring(freebsd);
    assert.match(line, outside('the container'));
    assert.doesNotMatch(line, /sandbox/);
  });
});

describe('diagnose: the Brewery config (ADR 0043)', () => {
  const checks = '{ "build": null, "typecheck": null, "lint": null, "format": null, "test": null }';
  const config = (web: string, api: string): string =>
    `// foedrum.jsonc\n{ "repositories": { "acme/web": { "checks": ${checks}, "alias": "${web}" }, "acme/api": { "checks": ${checks}, "alias": "${api}" } } }\n`;

  it('is not ok when foedrum.jsonc gives two repositories one alias, and names both', () => {
    const diagnosis = diagnose({ ...linux(), config: config('app', 'app') });
    assert.equal(diagnosis.ok, false);
    const problem = diagnosis.problems.find(({ what }) => /foedrum\.jsonc/.test(what));
    assert.deepEqual(
      { required: problem?.required, what: problem?.what },
      { required: true, what: 'foedrum.jsonc is not valid' },
    );
    assert.match(problem?.fix ?? '', /The alias app is already the alias of acme\/web/);
    assert.match(problem?.fix ?? '', /repositories\["acme\/api"\]\.alias/);
    assert.doesNotMatch(problem?.fix ?? '', /\n/, 'one line in the report');
  });

  it('is not ok when foedrum.jsonc is no JSONC at all', () => {
    const diagnosis = diagnose({ ...linux(), config: '{ "repositories": ' });
    assert.equal(diagnosis.ok, false);
    assert.ok(diagnosis.problems.some(({ what }) => what === 'foedrum.jsonc is not valid'));
  });

  it('is ok with a valid foedrum.jsonc, and without one', () => {
    for (const facts of [{ ...linux(), config: config('web', 'api') }, linux()]) {
      const diagnosis = diagnose(facts);
      assert.equal(diagnosis.ok, true);
      assert.deepEqual(diagnosis.problems, []);
    }
  });

  it('is not ok when foedrum.jsonc cannot be read, and says why', () => {
    const diagnosis = diagnose({ ...linux(), configUnreadable: 'EACCES: permission denied' });
    assert.equal(diagnosis.ok, false);
    assert.deepEqual(
      diagnosis.problems.find(({ what }) => /foedrum.jsonc/.test(what)),
      { required: true, what: 'foedrum.jsonc cannot be read', fix: 'EACCES: permission denied' },
    );
  });
});

describe("diagnose: the Brewery's recipes (ADR 0053)", () => {
  const brewer = { path: 'brewers/maltster.md', text: brewerText('maltster') };
  const pale = {
    path: 'recipes/pale.jsonc',
    text: recipeText('pale', [
      { brewer: 'maltster' },
      { id: 'approve', gate: 'human', deadline: '1d' },
    ]),
  };

  it('is not ok when a recipe file is not valid, with the line a refused command gives, and ok when they are valid', () => {
    const diagnosis = diagnose({ ...linux(), brewery: { recipes: [pale], brewers: [brewer] } });
    assert.equal(diagnosis.ok, false);
    const problem = diagnosis.problems.find(({ what }) => what === INVALID_RECIPES);
    const line =
      'recipes/pale.jsonc: step "approve" is a gate step, which the engine does not brew yet (ADR 0053)';
    assert.deepEqual(problem, { required: true, what: INVALID_RECIPES, fix: line });
    assert.equal(`${problem?.what}: ${problem?.fix}`, invalidRecipes([line]));
    // Valid recipe files, none, or none read: no problem.
    const valid = { ...pale, text: recipeText('pale', [{ brewer: 'maltster' }]) };
    for (const brewery of [
      { recipes: [valid], brewers: [brewer] },
      { recipes: [], brewers: [] },
    ]) {
      assert.deepEqual(diagnose({ ...linux(), brewery }).problems, []);
    }
    assert.deepEqual(diagnose(linux()).problems, []);
  });
});

describe("formatDiagnosis: the local gate's denylist (ADR 0114)", () => {
  const path = '/home/ada/.config/foedrum/denylist.txt';
  const lines: [DoctorFacts['denylist'], RegExp][] = [
    [
      { kind: 'set', path },
      /\nDenylist: \/home\/ada\/\.config\/foedrum\/denylist\.txt \(the local gate blocks its words in what git push and gh send, ADR 0114, ADR 0132\)\n/,
    ],
    [
      { kind: 'none', path },
      /\nDenylist: none \(optional; the local gate reads FOEDRUM_DENYLIST or \/home\/ada\/\.config\/foedrum\/denylist\.txt, ADR 0114\)\n/,
    ],
    [
      { kind: 'unreadable', path, why: 'EACCES' },
      /\nDenylist: \/home\/ada\/\.config\/foedrum\/denylist\.txt cannot be read \(EACCES\); the local gate blocks every push and every gh text until it can \(ADR 0114, ADR 0132\)\n/,
    ],
  ];
  for (const [denylist, line] of lines) {
    it(`says the denylist is ${denylist?.kind} in one line`, () => {
      const report = formatDiagnosis(diagnose({ ...linux(), denylist }));
      assert.match(report, line);
      assert.equal(report.match(/Denylist/g)?.length, 1);
    });
  }

  it('says nothing of a denylist it did not look for', () => {
    assert.doesNotMatch(formatDiagnosis(diagnose(linux())), /Denylist/);
  });
});

describe("formatDiagnosis: Foedrum's defaults in use (ADR 0098)", () => {
  const lens = { path: 'defaults/lenses/security.md', text: 'Look for secrets.' };
  const replaced = { path: 'defaults/lenses/correctness.md', text: 'Look for bugs.' };

  it('names the defaults the Brewery has no file of its own for', () => {
    const report = formatDiagnosis(
      diagnose({
        ...linux(),
        brewery: {
          recipes: [],
          brewers: [],
          lenses: [{ path: 'lenses/correctness.md', text: 'Our bugs.' }],
          defaults: { lenses: [replaced, lens] },
        },
      }),
    );
    assert.match(
      report,
      /\nDefaults in use: defaults\/lenses\/security\.md \(a Brewery file of the same name replaces one\)\n/,
    );
  });

  it('says none are in use when the Brewery replaces every default, and nothing when it read no Brewery', () => {
    const replacing = formatDiagnosis(
      diagnose({
        ...linux(),
        brewery: {
          recipes: [],
          brewers: [],
          lenses: [{ path: 'lenses/correctness.md', text: 'Our bugs.' }],
          defaults: { lenses: [replaced] },
        },
      }),
    );
    assert.match(replacing, /\nDefaults in use: none\n/);
    assert.doesNotMatch(formatDiagnosis(diagnose(linux())), /Defaults in use/);
  });

  it("says nothing of the defaults when the Brewery's files do not load", () => {
    const diagnosis = diagnose({
      ...linux(),
      brewery: {
        recipes: [{ path: 'recipes/pale.jsonc', text: '{' }],
        brewers: [],
        defaults: { lenses: [lens] },
      },
    });
    assert.ok(diagnosis.problems.some(({ what }) => what === INVALID_RECIPES));
    assert.doesNotMatch(formatDiagnosis(diagnosis), /Defaults in use/);
  });
});
