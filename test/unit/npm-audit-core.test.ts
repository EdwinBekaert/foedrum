// What CI's advisory audit reads from npm audit --omit=dev --json and does next (ADR 0119). The
// fixtures are npm 11.19.0's own output: a clean tree, a tree with findings, the endpoint answering
// 503 and 404, and no answer at all; the registry is never called here.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type AuditResult, nextStep, readAudit } from '../../scripts/npm-audit/core.ts';

interface Recorded {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const recorded = (name: string): Recorded =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'fixtures', 'npm-audit', `${name}.json`), 'utf8'),
  );

const read = (name: string): AuditResult => {
  const { exitCode, stdout } = recorded(name);
  return readAudit(exitCode, stdout);
};

describe('readAudit', () => {
  it('reads a clean report', () => {
    assert.deepEqual(read('clean'), { kind: 'clean' });
  });

  it('reads each vulnerable package with its severity and advisories', () => {
    const result = read('findings');
    assert.equal(result.kind, 'findings');
    assert.deepEqual(
      result.findings.map(({ name, severity }) => ({ name, severity })),
      [{ name: 'minimist', severity: 'critical' }],
    );
    assert.ok(
      result.findings[0]?.advisories.includes(
        'Prototype Pollution in minimist (https://github.com/advisories/GHSA-vh95-rmgr-6w4m)',
      ),
    );
  });

  it('reads a package reached through another, an advisory without a link and no severity', () => {
    const report = {
      auditReportVersion: 2,
      vulnerabilities: {
        parent: { name: 'parent', severity: 'high', via: ['child'] },
        child: { name: 'child', via: [{ title: 'An advisory without a link' }] },
      },
    };
    assert.deepEqual(readAudit(1, JSON.stringify(report)), {
      kind: 'findings',
      findings: [
        { name: 'parent', severity: 'high', advisories: [] },
        { name: 'child', severity: 'unknown severity', advisories: ['An advisory without a link'] },
      ],
    });
  });

  it('reads a server error with its status', () => {
    const result = read('server-error');
    assert.equal(result.kind, 'endpoint-error');
    assert.equal(result.statusCode, 503);
    assert.match(result.message, /^503 Service Unavailable - POST /);
  });

  it('reads a client error with its status', () => {
    const result = read('client-error');
    assert.equal(result.kind, 'endpoint-error');
    assert.equal(result.statusCode, 404);
  });

  it('reads a request that got no answer as an endpoint error without a status', () => {
    const result = read('no-answer');
    assert.equal(result.kind, 'endpoint-error');
    assert.equal(result.statusCode, undefined);
    assert.match(result.message, /socket hang up/);
  });

  it('tolerates CRLF and a BOM', () => {
    const { exitCode, stdout } = recorded('server-error');
    const result = readAudit(exitCode, `﻿${stdout.replaceAll('\n', '\r\n')}`);
    assert.equal(result.kind, 'endpoint-error');
  });

  it('never reads an exit 0 without a clean report as clean', () => {
    assert.equal(readAudit(0, '').kind, 'unreadable');
    assert.equal(readAudit(0, recorded('findings').stdout).kind, 'unreadable');
    assert.equal(readAudit(0, recorded('server-error').stdout).kind, 'unreadable');
  });

  it('never reads a failing exit as clean', () => {
    assert.equal(readAudit(1, recorded('clean').stdout).kind, 'unreadable');
    assert.equal(readAudit(1, 'npm error something else').kind, 'unreadable');
    assert.equal(readAudit(1, '[]').kind, 'unreadable');
    assert.equal(readAudit(1, 'null').kind, 'unreadable');
  });

  it('never reads an object without a report or an error message as an endpoint error', () => {
    assert.equal(readAudit(1, '{"error":{"summary":"","detail":""}}').kind, 'unreadable');
    assert.equal(readAudit(1, '{"message":{"text":"503"},"statusCode":503}').kind, 'unreadable');
  });
});

describe('nextStep', () => {
  it('passes a clean report', () => {
    assert.equal(nextStep({ kind: 'clean' }, 1).kind, 'pass');
  });

  it('fails on findings at once, naming each package', () => {
    const step = nextStep(read('findings'), 1);
    assert.equal(step.kind, 'fail');
    assert.ok(step.lines.some((line) => line.includes('minimist (critical)')));
  });

  it('lists each advisory under its package', () => {
    const { lines } = nextStep(read('findings'), 1);
    const minimist = lines.indexOf('minimist (critical)');
    assert.ok(minimist >= 0);
    assert.ok(
      lines
        .slice(minimist + 1)
        .includes(
          '  Prototype Pollution in minimist (https://github.com/advisories/GHSA-vh95-rmgr-6w4m)',
        ),
    );
  });

  it('retries a server error once, then fails', () => {
    const result = read('server-error');
    const first = nextStep(result, 1);
    assert.equal(first.kind, 'retry');
    assert.ok(first.lines.some((line) => line.includes('503')));
    const second = nextStep(result, 2);
    assert.equal(second.kind, 'fail');
    assert.ok(second.lines.some((line) => line.includes('503')));
  });

  it('retries a request with no answer once, then fails', () => {
    const result = read('no-answer');
    assert.equal(nextStep(result, 1).kind, 'retry');
    assert.equal(nextStep(result, 2).kind, 'fail');
  });

  it('retries from status 500 and fails below it', () => {
    const error = (statusCode: number): AuditResult => ({
      kind: 'endpoint-error',
      statusCode,
      message: `${statusCode}`,
    });
    assert.equal(nextStep(error(500), 1).kind, 'retry');
    assert.equal(nextStep(error(499), 1).kind, 'fail');
  });

  it('fails on a client error at once', () => {
    const step = nextStep(read('client-error'), 1);
    assert.equal(step.kind, 'fail');
    assert.ok(step.lines.some((line) => line.includes('404')));
  });

  it('fails on output it cannot read at once', () => {
    const step = nextStep({ kind: 'unreadable', reason: 'not JSON' }, 1);
    assert.equal(step.kind, 'fail');
    assert.ok(step.lines.some((line) => line.includes('not JSON')));
  });
});
