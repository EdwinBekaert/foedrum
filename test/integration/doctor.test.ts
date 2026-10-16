// `foedrum doctor` on the real machine (ADR 0021): the program starts, finds the tools through
// PATH and reads their versions through the process runner (npm.cmd through cmd.exe on Windows).
// What a machine has differs, so this checks the report's structure only; the report itself is
// in test/unit/cli.test.ts.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execProcess } from '../../src/platform/processes.ts';

const main = join(import.meta.dirname, '..', '..', 'src', 'cli', 'main.ts');
const VERSION = String.raw`\d+(?:\.\d+)+`;

describe('foedrum doctor on this machine', () => {
  it('reports each tool, the isolation level and an exit code that matches', async () => {
    const { exitCode, stdout, stderr } = await execProcess(process.execPath, [main, 'doctor'], {
      cwd: import.meta.dirname,
      timeoutMs: 60_000,
    });
    assert.equal(stderr, '');
    const lines = stdout.split('\n');
    assert.equal(lines[0], 'Foedrum doctor');
    const row = (name: string): string | undefined =>
      lines.find((line) => line.startsWith(`  ${name} `));
    assert.match(row('node') ?? '', new RegExp(`^  node +${VERSION}$`));
    // CI has npm and git everywhere; npm is npm.cmd on Windows.
    assert.match(row('npm') ?? '', new RegExp(`^  npm +${VERSION} +\\S`));
    assert.match(row('git') ?? '', new RegExp(`^  git +${VERSION} +\\S`));
    assert.match(row('claude') ?? '', new RegExp(`^  claude +(?:missing|${VERSION} +\\S.*)$`));
    const linux = process.platform === 'linux';
    assert.equal(row('bwrap') !== undefined, linux);
    assert.equal(row('socat') !== undefined, linux);
    // Where the machine has them, the parser reads a version from what they really print.
    for (const name of ['bwrap', 'socat']) {
      const line = row(name);
      if (line !== undefined && !/ missing$/.test(line)) {
        assert.match(line, new RegExp(`^  ${name} +${VERSION} +\\S`));
      }
    }
    const container = lines.find((line) => line.startsWith('Container: '));
    // A container runtime may be there without answering (docker.exe on the Windows runner, #99),
    // but one that printed a version must have it read.
    if (container !== undefined && !container.startsWith('Container: no ')) {
      assert.match(
        container,
        new RegExp(
          `^Container: (?:podman|docker) (?:${VERSION} at \\S.*; the container level is available|at \\S.* does not answer its version.*; the container level is not available)$`,
        ),
      );
      if (container.includes(' does not answer its version')) {
        assert.doesNotMatch(container, new RegExp(`its version \\(.*${VERSION}`));
      }
    }
    const isolation = lines.find((line) => line.startsWith('Isolation: '));
    const expected = { win32: 'permissions only', darwin: 'sandboxed' }[process.platform as string];
    assert.match(isolation ?? '', /^Isolation: (?:sandboxed|permissions only) \(.+\)$/);
    if (expected !== undefined) assert.ok(isolation?.startsWith(`Isolation: ${expected} (`));
    assert.ok(lines.some((line) => line.startsWith('Container: ')));
    const required = lines.some((line) => / \(required\): /.test(line));
    assert.equal(exitCode, required ? 1 : 0);
  });
});
