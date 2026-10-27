// The excerpt of a failed GitHub Actions job's log that a record keeps (ADR 0228): synthetic logs in
// the shape GitHub serves them, each line with its timestamp, the commands with their colours.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { jobLogExcerpt } from '../../src/checks/job-log.ts';
import { MAX_TAIL_LENGTH } from '../../src/schemas/events.ts';

const esc = String.fromCodePoint(0x1b);
const bom = String.fromCodePoint(0xfeff);
const stamped = (lines: readonly string[]): string =>
  lines
    .map((line, i) => `2026-10-26T18:49:${String(i % 60).padStart(2, '0')}.7159496Z ${line}`)
    .join('\n');

const setup = [
  "Current runner version: '2.338.0'",
  '##[group]Run actions/checkout@v5',
  'with:',
  '##[endgroup]',
  'Syncing repository: acme/web',
];
const failingStep = [
  '##[group]Run npm test',
  `${esc}[36;1mnpm test${esc}[0m`,
  'shell: /usr/bin/bash -e {0}',
  '##[endgroup]',
  '> web@1.0.0 test',
  'not ok 1 - adds',
  '  AssertionError [ERR_ASSERTION]: 3 !== 4',
  '##[error]Process completed with exit code 1.',
];
const after = [
  '##[group]Run echo summary',
  'summary',
  '##[endgroup]',
  '##[error]Process completed with exit code 1.',
  'Post job cleanup.',
  '[command]/usr/bin/git version',
  'Cleaning up orphan processes',
];

describe('jobLogExcerpt', () => {
  it('keeps the failing step up to its first error, without timestamps or colours, and never the cleanup after it', () => {
    const excerpt = jobLogExcerpt(stamped([...setup, ...failingStep, ...after]));
    assert.equal(
      excerpt,
      [
        '##[group]Run npm test',
        'npm test',
        'shell: /usr/bin/bash -e {0}',
        '##[endgroup]',
        '> web@1.0.0 test',
        'not ok 1 - adds',
        '  AssertionError [ERR_ASSERTION]: 3 !== 4',
        '##[error]Process completed with exit code 1.',
      ].join('\n'),
    );
  });

  it('reads a log with a byte order mark and CRLF line ends', () => {
    const log = `${bom}${stamped([...setup, ...failingStep, ...after]).replaceAll('\n', '\r\n')}`;
    const excerpt = jobLogExcerpt(log);
    assert.ok(excerpt.startsWith('##[group]Run npm test\n'), excerpt);
    assert.ok(excerpt.endsWith('\n##[error]Process completed with exit code 1.'), excerpt);
    assert.doesNotMatch(excerpt, /\r/);
  });

  it('keeps the end before the post-job steps when no line is an error', () => {
    const excerpt = jobLogExcerpt(
      stamped([...setup, '##[group]Run npm test', '##[endgroup]', 'killed', ...after.slice(4)]),
    );
    assert.ok(excerpt.endsWith('##[group]Run npm test\n##[endgroup]\nkilled'), excerpt);
    assert.doesNotMatch(excerpt, /Post job cleanup|orphan/);
  });

  it('leaves out a line that looks like a secret, and a 40-character hash', () => {
    const token = ['ghp', 'A'.repeat(36)].join('_');
    const hash = 'b'.repeat(40);
    const excerpt = jobLogExcerpt(
      stamped([
        ...setup,
        '##[group]Run npm test',
        `GITHUB_TOKEN=${token}`,
        `at commit ${hash}`,
        'not ok 1 - adds',
        '##[error]Process completed with exit code 1.',
      ]),
    );
    assert.doesNotMatch(excerpt, new RegExp(`${token}|${hash}`));
    assert.match(excerpt, /\[left out: a line that looks like a secret \([^)]+\)\]/);
    assert.match(excerpt, /not ok 1 - adds/);
  });

  it(`keeps at most ${MAX_TAIL_LENGTH} characters, from the end, where the error is`, () => {
    const noise = Array.from({ length: 2000 }, (_, i) => `ok ${i} - passes`);
    const excerpt = jobLogExcerpt(
      stamped([
        ...setup,
        '##[group]Run npm test',
        ...noise,
        'not ok 2001 - adds',
        '##[error]Process completed with exit code 1.',
        ...after,
      ]),
    );
    assert.ok(excerpt.length <= MAX_TAIL_LENGTH, String(excerpt.length));
    assert.ok(excerpt.endsWith('not ok 2001 - adds\n##[error]Process completed with exit code 1.'));
  });

  it('removes a link and a title escape, and a timestamp without fractions of a second', () => {
    const bel = String.fromCodePoint(0x07);
    const excerpt = jobLogExcerpt(
      [
        '2026-10-26T18:49:21Z ##[group]Run npm test',
        `2026-10-26T18:49:21Z ${esc}]8;;https://example.test${esc}\\see${esc}]8;;${esc}\\ here`,
        `2026-10-26T18:49:21Z ${esc}]0;title${bel}not ok 1 - adds`,
        '2026-10-26T18:49:21Z ##[error]Process completed with exit code 1.',
      ].join('\n'),
    );
    assert.equal(
      excerpt,
      [
        '##[group]Run npm test',
        'see here',
        'not ok 1 - adds',
        '##[error]Process completed with exit code 1.',
      ].join('\n'),
    );
  });

  it('leaves no control character behind: a reset, a charset escape, or one an escape it removed rebuilt', () => {
    const excerpt = jobLogExcerpt(
      stamped([
        '##[group]Run npm test',
        `${esc}cnot ok 1 - adds`,
        `${esc}(Bcharset${esc}7saved${esc}8`,
        `${esc}${esc}[0m[31mred`,
        `bell${String.fromCodePoint(0x07)} c1${String.fromCodePoint(0x9b)}31m\tand a tab`,
        '##[error]Process completed with exit code 1.',
      ]),
    );
    assert.equal(
      excerpt,
      [
        '##[group]Run npm test',
        'not ok 1 - adds',
        'charsetsaved',
        '[31mred',
        'bell c131m\tand a tab',
        '##[error]Process completed with exit code 1.',
      ].join('\n'),
    );
  });

  it('keeps the log from its start when no step began before the first error', () => {
    const excerpt = jobLogExcerpt(
      stamped(['Preparing', '##[error]No runner could start', ...after]),
    );
    assert.equal(excerpt, 'Preparing\n##[error]No runner could start');
  });
});
