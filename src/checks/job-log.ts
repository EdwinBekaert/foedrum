// The part of a failed GitHub Actions job's log that goes with its batch back to a fix step
// (ADR 0228): the failing step up to its first error, read for secrets and cut to a tail. A job's
// log is printed by code the pull request changed, so it is untrusted, as a check's output is.

import { tailOf, withoutSecrets } from './gravity.ts';

// The time GitHub puts before each line of a job's log: `2026-10-26T18:49:21.7159496Z `.
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
// Terminal escape sequences: CSI (colours), OSC (titles, links), and any other escape with its
// intermediate bytes (`ESC c`, `ESC ( B`).
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it removes.
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[ -/]*[0-~])/g;
// Every control character left but the tab, C1 included: an ESC that began no sequence, or one
// the removal of another put back together, never reaches a reader (ADR 0228).
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** The excerpt of `log` a record keeps. */
export function jobLogExcerpt(log: string): string {
  const lines = log
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(TIMESTAMP, '').replace(ESCAPES, '').replace(CONTROLS, ''));
  const error = lines.findIndex((line) => line.startsWith('##[error]'));
  let kept: string[];
  if (error === -1) {
    // No error line: the end before the post-job steps, which are never the failure.
    const cleanup = lines.indexOf('Post job cleanup.');
    kept = cleanup === -1 ? lines : lines.slice(0, cleanup);
  } else {
    // The step that holds the error starts at the last `Run` group before it.
    const step = lines.findLastIndex(
      (line, index) => index < error && line.startsWith('##[group]Run '),
    );
    kept = lines.slice(Math.max(step, 0), error + 1);
  }
  // Secrets out first, so the bound never keeps half of one.
  return tailOf(withoutSecrets(kept.join('\n')));
}
