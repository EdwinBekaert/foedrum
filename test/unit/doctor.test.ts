// `foedrum doctor`'s core with plain facts (ADR 0021): which tools are there, the effective
// isolation level (ADR 0010) and what is missing. The report's text is in cli.test.ts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type DoctorFacts, diagnose } from '../../src/cli/doctor.ts';
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
      { name: 'claude', version: '2.1.300', path: '/home/brewer/.local/bin/claude' },
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
    });
    assert.deepEqual(diagnose(linux({ docker, podman })).container, {
      name: 'podman',
      version: '5.2.0',
      path: '/usr/bin/podman',
    });
  });
});
