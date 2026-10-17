// `foedrum doctor`'s core with plain facts (ADR 0021): which tools are there, the effective
// isolation level (ADR 0010) and what is missing. The report's text is in cli.test.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type DoctorFacts, diagnose, formatDiagnosis } from '../../src/cli/doctor.ts';
import { INVALID_RECIPES, invalidRecipes } from '../../src/engine/recipe-files.ts';
import { brewerText, recipeText } from '../helpers/brewery-files.ts';
import { linux, macos, ran, windows } from '../helpers/doctor-facts.ts';

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
      { name: 'claude', version: '2.1.301', path: '/home/brewer/.local/bin/claude' },
      { name: 'bwrap', version: '0.9.0', path: '/usr/bin/bwrap' },
      { name: 'socat', version: '1.7.4.4', path: '/usr/bin/socat' },
    ]);
  });

  it('lists bubblewrap and socat on Linux only', () => {
    assert.deepEqual(
      diagnose(windows).tools.map((tool) => tool.name),
      ['node', 'npm', 'git', 'claude'],
    );
    assert.deepEqual(
      diagnose(macos).tools.map((tool) => tool.name),
      ['node', 'npm', 'git', 'claude'],
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
    assert.deepEqual(diagnose(wsl2).advice, []);
  });

  it('is sandboxed on a WSL 2 kernel from before the WSL2 suffix', () => {
    const wsl2 = { ...linux(), kernelRelease: '4.19.128-microsoft-standard' };
    assert.equal(diagnose(wsl2).isolation.level, 'sandboxed');
    assert.deepEqual(diagnose(wsl2).advice, []);
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
    assert.equal(diagnosis.advice.length, 1);
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
    text: recipeText('pale', [{ brewer: 'maltster' }, { id: 'green', check: 'test' }]),
  };

  it('is not ok when a recipe file is not valid, with the line a refused command gives, and ok when they are valid', () => {
    const diagnosis = diagnose({ ...linux(), brewery: { recipes: [pale], brewers: [brewer] } });
    assert.equal(diagnosis.ok, false);
    const problem = diagnosis.problems.find(({ what }) => what === INVALID_RECIPES);
    const line =
      'recipes/pale.jsonc: step "green" is a check step, which the engine does not brew yet (ADR 0053)';
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
