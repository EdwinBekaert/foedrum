// The staleness check on the two lock files' text (ADR 0021): package-lock.json against npm's
// record of what it installed, node_modules/.package-lock.json.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staleReason } from '../../scripts/deps-sync/core.ts';

type Entry = Record<string, unknown>;

const zod = { version: '4.6.5', resolved: 'https://registry/zod-4.6.5.tgz', integrity: 'sha512-z' };
const biome = { version: '2.5.15', integrity: 'sha512-b', dev: true };
// npm ci skips optional packages for other platforms, and peers under omit=peer, so they are in
// package-lock.json but never in node_modules/.package-lock.json.
const otherPlatform = { version: '2.5.15', integrity: 'sha512-o', optional: true, os: ['darwin'] };
const peer = { version: '1.0.0', integrity: 'sha512-p', peer: true };

const lockFile = (packages: Record<string, Entry>): string =>
  JSON.stringify({
    name: 'foedrum',
    lockfileVersion: 3,
    packages: { '': { name: 'foedrum', dependencies: { zod: '4.6.5' } }, ...packages },
  });
const installedFile = (packages: Record<string, Entry>): string =>
  JSON.stringify({ name: 'foedrum', lockfileVersion: 3, packages });

const lock = lockFile({
  'node_modules/zod': zod,
  'node_modules/@biomejs/biome': biome,
  'node_modules/@biomejs/cli-darwin-arm64': otherPlatform,
  'node_modules/some-peer': peer,
});
const installed = installedFile({
  'node_modules/zod': zod,
  'node_modules/@biomejs/biome': biome,
});

// The same file as written with a byte order mark and CRLF line endings.
const withBomAndCrlf = (text: string): string =>
  `${String.fromCharCode(0xfeff)}${JSON.stringify(JSON.parse(text), null, 2).replaceAll('\n', '\r\n')}`;

describe('staleReason', () => {
  it('is up to date when every installed entry matches, skipping optional and peer packages', () => {
    assert.equal(staleReason(lock, installed), undefined);
  });

  it('ignores the root entry, which the installed record does not have', () => {
    const changedRoot = lock.replace('"dependencies":{"zod":"4.6.5"}', '"version":"1.0.0"');
    assert.notEqual(changedRoot, lock);
    assert.equal(staleReason(changedRoot, installed), undefined);
  });

  it('is stale when npm never recorded an install', () => {
    assert.equal(staleReason(lock, undefined), 'node_modules/.package-lock.json is missing');
  });

  it('is stale when the installed record cannot be parsed', () => {
    assert.equal(
      staleReason(lock, '{"packages": '),
      'node_modules/.package-lock.json cannot be parsed',
    );
  });

  it('is stale when a version changed', () => {
    const newer = lockFile({ 'node_modules/zod': { ...zod, version: '4.7.0' } });
    assert.equal(
      staleReason(newer, installedFile({ 'node_modules/zod': zod })),
      'node_modules/zod 4.6.5 is installed, package-lock.json has 4.7.0',
    );
  });

  it('is stale when the integrity changed under the same version', () => {
    const republished = lockFile({ 'node_modules/zod': { ...zod, integrity: 'sha512-other' } });
    assert.equal(
      staleReason(republished, installedFile({ 'node_modules/zod': zod })),
      'node_modules/zod 4.6.5 differs from package-lock.json (integrity)',
    );
  });

  it('is stale when a package was added', () => {
    const added = lockFile({ 'node_modules/zod': zod, 'node_modules/left-pad': zod });
    assert.equal(
      staleReason(added, installedFile({ 'node_modules/zod': zod })),
      'node_modules/left-pad 4.6.5 is not installed',
    );
  });

  it('is stale when an installed optional package changed', () => {
    const optional = { ...otherPlatform, os: ['win32'] };
    assert.equal(
      staleReason(
        lockFile({ 'node_modules/opt': { ...optional, version: '3.0.0' } }),
        installedFile({ 'node_modules/opt': optional }),
      ),
      'node_modules/opt 2.5.15 is installed, package-lock.json has 3.0.0',
    );
  });

  it('is stale when a package was removed', () => {
    assert.equal(
      staleReason(lockFile({ 'node_modules/zod': zod }), installed),
      'node_modules/@biomejs/biome is installed but no longer in package-lock.json',
    );
  });

  it('reads files with a byte order mark and CRLF line endings', () => {
    assert.equal(staleReason(withBomAndCrlf(lock), withBomAndCrlf(installed)), undefined);
  });

  it('reads a stale record with a byte order mark and CRLF line endings as stale', () => {
    const newer = lockFile({ 'node_modules/zod': { ...zod, version: '4.7.0' } });
    assert.equal(
      staleReason(
        withBomAndCrlf(newer),
        withBomAndCrlf(installedFile({ 'node_modules/zod': zod })),
      ),
      'node_modules/zod 4.6.5 is installed, package-lock.json has 4.7.0',
    );
  });

  it('gives no verdict when package-lock.json cannot be parsed, leaving that to npm', () => {
    assert.equal(staleReason('<<<<<<< HEAD', installed), undefined);
  });

  for (const text of ['{}', 'null', '{"packages": null}']) {
    it(`gives no verdict for a package-lock.json without packages: ${text}`, () => {
      assert.equal(staleReason(text, installed), undefined);
    });

    it(`is stale when the installed record has no packages: ${text}`, () => {
      assert.equal(staleReason(lock, text), 'node_modules/.package-lock.json cannot be parsed');
    });
  }
});
