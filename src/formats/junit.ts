// JUnit XML as a test report for the red proof (ADR 0078): the `testcase` elements of a
// `testsuites` or `testsuite` root, read by Foedrum's small XML reader. Pure.

import { type ReadReport, type ReportedTest, testLocation } from './test-report.ts';
import { type Element, elements, NotXml, readXml, textOf } from './xml.ts';

/** A failure, error or skip as a line of what it says: its type, message and text. */
const said = (element: Element): string =>
  [element.attributes.get('type'), element.attributes.get('message'), textOf(element)]
    .filter((part) => part !== undefined && part.trim() !== '')
    .join('\n');

const SYSTEM_OUTPUT = new Set(['system-out', 'system-err']);

function testcase(element: Element): ReportedTest {
  const children = elements(element);
  const failed = children.filter(({ name }) => name === 'failure' || name === 'error');
  const skipped = children.filter(({ name }) => name === 'skipped');
  const output = children.filter(({ name }) => SYSTEM_OUTPUT.has(name));
  const result = failed.length > 0 ? 'failed' : skipped.length > 0 ? 'skipped' : 'passed';
  const detail = [...failed, ...skipped, ...output].map(said).join('\n');
  const { attributes } = element;
  const name = attributes.get('name') ?? '';
  // Where the writer gives it, as node's (a file) and pytest's (a file and a line) do (ADR 0274).
  const location = testLocation(attributes.get('file'), attributes.get('line'));
  return { name, result, leaf: true, detail, ...(location === undefined ? {} : { location }) };
}

/** The tests of a JUnit XML report, or why it is not one. */
export function parseJunit(text: string): ReadReport {
  let root: Element;
  try {
    root = readXml(text.replace(/^﻿/, ''));
  } catch (error) {
    if (!(error instanceof NotXml)) throw error;
    return { readable: false, reason: `it is not XML: ${error.message}` };
  }
  if (root.name !== 'testsuites' && root.name !== 'testsuite') {
    return { readable: false, reason: `its root element <${root.name}> is no JUnit report` };
  }
  const tests: ReportedTest[] = [];
  const other: string[] = [];
  const visit = (suite: Element): void => {
    for (const child of elements(suite)) {
      if (child.name === 'testcase') tests.push(testcase(child));
      else if (child.name === 'testsuite') visit(child);
      else if (SYSTEM_OUTPUT.has(child.name)) other.push(textOf(child));
    }
  };
  visit(root);
  if (tests.length === 0) return { readable: false, reason: 'it has no testcase' };
  return { readable: true, report: { tests, other: other.join('\n') } };
}
