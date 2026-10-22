// The real npm audit --omit=dev --json against an advisory endpoint on 127.0.0.1, read by
// scripts/npm-audit/core.ts (ADR 0119). The unit tests read npm 11.19.0's recorded output; this
// shows the npm installed today still answers in the shapes they record. No registry is called.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type AuditResult, readAudit } from '../../scripts/npm-audit/core.ts';
import { findNpmCli } from '../../src/platform/executables.ts';
import { execProcess } from '../../src/platform/processes.ts';
import { makeTempDir, type TempDir } from '../helpers/temp-dir.ts';

// A guard against a hang, not a measure.
const NPM_TIMEOUT_MS = 120_000;

// The environment without npm's own variables, so no outer npm run changes what npm reads.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)));

// A project whose lock file has one runtime dependency, zod 4.6.5, and no node_modules.
const writeProject = (dir: string) => {
  const dependencies = { zod: '4.6.5' };
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'audit-fixture', version: '1.0.0', private: true, dependencies }),
  );
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'audit-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'audit-fixture', version: '1.0.0', dependencies },
        'node_modules/zod': {
          version: '4.6.5',
          resolved: 'https://registry.npmjs.org/zod/-/zod-4.6.5.tgz',
          license: 'MIT',
        },
      },
    }),
  );
};

// npm audit in `dir` against an endpoint that answers every request with `listener`.
const audit = async (dir: string, listener: RequestListener): Promise<AuditResult> => {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const npmCli = findNpmCli(process.execPath).path;
    assert.ok(npmCli, 'npm-cli.js next to this node');
    const { exitCode, stdout } = await execProcess(
      process.execPath,
      [
        npmCli,
        'audit',
        '--omit=dev',
        '--json',
        `--registry=http://127.0.0.1:${port}/`,
        '--fetch-retries=0',
        // npm caches what it computed per advisory id: a cache of the test's own.
        `--cache=${join(dir, 'npm-cache')}`,
      ],
      { cwd: dir, env, timeoutMs: NPM_TIMEOUT_MS },
    );
    assert.notEqual(exitCode, null, 'npm audit finished');
    return readAudit(exitCode ?? 1, stdout);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

const answer =
  (status: number, body: string): RequestListener =>
  (request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    });
  };

describe('npm audit --json read by readAudit', () => {
  let project: TempDir;
  before(() => {
    project = makeTempDir('npm-audit');
    writeProject(project.path);
  });
  after(() => project.remove());

  it('reads no advisories as clean', async () => {
    assert.deepEqual(await audit(project.path, answer(200, '{}')), { kind: 'clean' });
  });

  it('reads an advisory as a finding', async () => {
    const advisory = {
      id: 1,
      url: 'https://github.com/advisories/GHSA-test',
      title: 'Test advisory',
      severity: 'high',
      vulnerable_versions: '<5.0.0',
      cwe: [],
      cvss: { score: 0, vectorString: null },
    };
    // npm also asks for zod's packument to see whether a fix exists; none is found here.
    const bulk = answer(200, JSON.stringify({ zod: [advisory] }));
    const packument = answer(404, '{}');
    const result = await audit(project.path, (request, response) =>
      (request.method === 'POST' ? bulk : packument)(request, response),
    );
    assert.equal(result.kind, 'findings');
    assert.deepEqual(result.findings, [
      {
        name: 'zod',
        severity: 'high',
        advisories: ['Test advisory (https://github.com/advisories/GHSA-test)'],
      },
    ]);
  });

  it('reads a 503 as an endpoint error with its status', async () => {
    const result = await audit(project.path, answer(503, 'down'));
    assert.equal(result.kind, 'endpoint-error');
    assert.equal(result.statusCode, 503);
  });

  it('reads a 404 as an endpoint error with its status', async () => {
    const result = await audit(project.path, answer(404, 'not found'));
    assert.equal(result.kind, 'endpoint-error');
    assert.equal(result.statusCode, 404);
  });

  it('reads a dropped connection as an endpoint error without a status', async () => {
    const result = await audit(project.path, (request) => request.socket.destroy());
    assert.equal(result.kind, 'endpoint-error');
    assert.equal(result.statusCode, undefined);
  });
});
