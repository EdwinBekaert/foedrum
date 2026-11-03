// Brett's mutants of a target repository's change (ADR 0034, ADR 0311): each is checked on its
// own against the lines the batch's change added, in a code area of the effective test map, and
// comes back as an exact line edit or with the reason it is invalid.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Mutant, mutantCheck, type TargetChange } from '../../src/checks/mutants.ts';
import { areaOf, type EffectiveModule } from '../../src/checks/test-map.ts';
import { parseDiff } from '../../src/formats/unified-diff.ts';
import { MutantsOutDoc, mutantsOf } from '../../src/schemas/out-doc.ts';

const calc: EffectiveModule = {
  module: {
    name: 'calc',
    code: ['calc/**', 'web/**'],
    tests: { paths: ['tests/**'] },
    testReport: { format: 'junit', path: 'reports/junit.xml' },
    coverage: { format: 'cobertura', path: 'reports/coverage.xml' },
  },
  added: false,
};

const rates = [
  'def rate(amount, limit):',
  '    if amount > limit:',
  '        return 0.2  # was: return rate',
  '    return 0.1',
  '',
].join('\n');
const total = [
  'export const total = (a: number, b: number): number => {',
  '  if (a > b) return a; // or c',
  '  return b;',
  '};',
  '',
].join('\n');

const diff = `diff --git a/calc/rates.py b/calc/rates.py
--- a/calc/rates.py
+++ b/calc/rates.py
@@ -1,2 +1,4 @@
 def rate(amount, limit):
+    if amount > limit:
+        return 0.2  # was: return rate
     return 0.1
diff --git a/tests/test_rates.py b/tests/test_rates.py
new file mode 100644
--- /dev/null
+++ b/tests/test_rates.py
@@ -0,0 +1,2 @@
+def test_rate():
+    assert rate(5, 1) == 0.2
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Calc
+Rates: 0.1 and 0.2
diff --git a/web/total.ts b/web/total.ts
new file mode 100644
--- /dev/null
+++ b/web/total.ts
@@ -0,0 +1,4 @@
+export const total = (a: number, b: number): number => {
+  if (a > b) return a; // or c
+  return b;
+};
`;

const contents: Record<string, string> = {
  'calc/rates.py': rates,
  'calc/other.py': 'def other():\n    return 1\n',
  'tests/test_rates.py': 'def test_rate():\n    assert rate(5, 1) == 0.2\n',
  'README.md': '# Calc\nRates: 0.1 and 0.2\n',
  'web/total.ts': total,
};

/** The change as the engine reads it: git's diff of the batch, and the files at its head. */
const change: TargetChange = (() => {
  const added = new Map(
    parseDiff(diff).flatMap(({ newPath, addedAt }) =>
      newPath === undefined ? [] : [[newPath, new Set(addedAt ?? [])] as const],
    ),
  );
  return {
    inCode: (path) => areaOf([calc], path, false)?.area === 'code',
    changed: (path) => {
      const lines = added.get(path);
      const content = contents[path];
      return lines === undefined || content === undefined ? undefined : { content, added: lines };
    },
  };
})();

const mutant = (fields: Partial<Mutant>): Mutant => ({
  file: 'calc/rates.py',
  line: 2,
  original: 'if amount > limit:',
  replacement: 'if amount >= limit:',
  ...fields,
});

const reasonOf = (fields: Partial<Mutant>): string | undefined => {
  const verdict = mutantCheck(mutant(fields), change);
  return verdict.ok ? undefined : verdict.reason;
};

describe('mutantCheck: a target repository (ADR 0311)', () => {
  it('a mutant on a line the change did not add is invalid, with its reason', () => {
    assert.equal(
      reasonOf({ line: 4, original: 'return 0.1', replacement: 'return 0.2' }),
      'line 4 of calc/rates.py is not a line the change added',
    );
    // Found by its text when its number is off, the line is still one the change did not add.
    assert.equal(
      reasonOf({ line: 9, original: 'return 0.1', replacement: 'return 0.2' }),
      'line 4 of calc/rates.py is not a line the change added',
    );
    assert.equal(
      reasonOf({ file: 'calc/other.py', original: 'return 1', replacement: 'return 0' }),
      '"calc/other.py" is not a file the change added a line to',
    );
    // The same line moved to the line the change added is valid, edited in place.
    const verdict = mutantCheck(mutant({}), change);
    assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason);
    assert.equal(verdict.line, 2);
    assert.equal(verdict.content, rates.replace('if amount > limit:', 'if amount >= limit:'));
  });

  it('a mutant in a file outside every code area of the test map is invalid', () => {
    assert.equal(
      reasonOf({
        file: 'tests/test_rates.py',
        line: 2,
        original: 'assert rate(5, 1) == 0.2',
        replacement: 'assert rate(5, 1) != 0.2',
      }),
      '"tests/test_rates.py" is in no code area of the test map',
    );
    assert.equal(
      reasonOf({
        file: 'README.md',
        line: 2,
        original: 'Rates: 0.1 and 0.2',
        replacement: 'Rates: 0.1 and 0.3',
      }),
      '"README.md" is in no code area of the test map',
    );
    // A path that is not plain is refused before the map reads it.
    assert.equal(
      reasonOf({ file: 'calc/../calc/rates.py' }),
      '"calc/../calc/rates.py" is not a plain relative path',
    );
  });

  it('a mutant that adds a word the original lacks is invalid in any language', () => {
    assert.equal(
      reasonOf({ replacement: 'if amount > limit or debug:' }),
      'the replacement adds or, debug',
    );
    assert.equal(
      reasonOf({
        file: 'web/total.ts',
        line: 2,
        original: 'if (a > b) return a; // or c',
        replacement: 'if (a > b || c) return a;',
      }),
      'the replacement adds c',
    );
    assert.equal(
      reasonOf({ replacement: 'if amount > limit :' }),
      'the replacement changes nothing',
    );
    assert.equal(
      reasonOf({ replacement: 'if amount >= limit:\n    pass' }),
      'the replacement is more than one line',
    );
  });

  it("a comment counts as a line's text where the language's comments are not known", () => {
    // Python's `#` is not stripped, so its words are the original's (ADR 0311).
    const verdict = mutantCheck(
      mutant({ line: 3, original: 'return 0.2  # was: return rate', replacement: 'return rate' }),
      change,
    );
    assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason);
    assert.equal(verdict.line, 3);
  });

  it('an out doc of three mutants gives one edit and two named reasons', () => {
    const doc = MutantsOutDoc.parse({
      status: 'done',
      summary: 'Three mutants of the rate change',
      mutants: [
        { ...mutant({}), description: 'The top rate starts at the limit' },
        {
          ...mutant({ line: 4, original: 'return 0.1', replacement: 'return 0.2' }),
          description: 'The base rate is the top rate',
        },
        {
          ...mutant({ replacement: 'if amount > limit or debug:' }),
          description: 'Debug takes the top rate',
        },
      ],
    });
    const verdicts = (mutantsOf(doc) ?? []).map((proposed) => mutantCheck(proposed, change));
    assert.deepEqual(
      verdicts.map((verdict) =>
        verdict.ok ? `edit ${verdict.mutant.file}:${verdict.line}` : verdict.reason,
      ),
      [
        'edit calc/rates.py:2',
        'line 4 of calc/rates.py is not a line the change added',
        'the replacement adds or, debug',
      ],
    );
  });
});
