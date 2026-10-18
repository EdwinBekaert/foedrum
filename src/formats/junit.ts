// JUnit XML as a test report for the red proof (ADR 0078): the `testcase` elements of a
// `testsuites` or `testsuite` root, read by a small XML reader of its own. Pure.

import type { ReadReport, ReportedTest } from './test-report.ts';

interface Element {
  name: string;
  attributes: ReadonlyMap<string, string>;
  children: (Element | string)[];
}

class NotXml extends Error {}

const ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** `text` with its character and entity references replaced. */
function decode(text: string): string {
  return text.replace(/&([^;&\s]*);?/g, (whole, entity: string) => {
    if (!whole.endsWith(';')) throw new NotXml(`a bare & in "${whole}"`);
    const named = ENTITIES[entity];
    if (named !== undefined) return named;
    const code = /^#x([0-9a-f]+)$/i.exec(entity)?.[1] ?? /^#([0-9]+)$/.exec(entity)?.[1];
    const point =
      code === undefined ? Number.NaN : Number.parseInt(code, entity.startsWith('#x') ? 16 : 10);
    if (!Number.isInteger(point) || point > 0x10ffff) throw new NotXml(`the entity ${whole}`);
    return String.fromCodePoint(point);
  });
}

const NAME = /^[A-Za-z_:][\w.:-]*/;
const ATTRIBUTE = /^\s+([A-Za-z_:][\w.:-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/;

/** The root element of `text`; throws NotXml when it is not well-formed. */
function readXml(text: string): Element {
  let at = 0;
  const stack: Element[] = [];
  let root: Element | undefined;
  const skipPast = (end: string): void => {
    const found = text.indexOf(end, at);
    if (found < 0) throw new NotXml(`no ${end}`);
    at = found + end.length;
  };
  while (at < text.length) {
    const open = text.indexOf('<', at);
    const textEnd = open < 0 ? text.length : open;
    const content = text.slice(at, textEnd);
    const parent = stack.at(-1);
    if (parent === undefined) {
      if (content.trim() !== '') throw new NotXml('text outside the root element');
    } else if (content !== '') {
      parent.children.push(decode(content));
    }
    if (open < 0) break;
    at = open;
    if (text.startsWith('<?', at)) {
      skipPast('?>');
    } else if (text.startsWith('<!--', at)) {
      skipPast('-->');
    } else if (text.startsWith('<![CDATA[', at)) {
      if (parent === undefined) throw new NotXml('CDATA outside the root element');
      const start = at + '<![CDATA['.length;
      skipPast(']]>');
      parent.children.push(text.slice(start, at - ']]>'.length));
    } else if (text.startsWith('<!', at)) {
      // A DOCTYPE: its internal subset could define entities, which this reader does not follow.
      if (text.slice(at, text.indexOf('>', at)).includes('[')) throw new NotXml('a DOCTYPE');
      skipPast('>');
    } else if (text.startsWith('</', at)) {
      const name = NAME.exec(text.slice(at + 2))?.[0];
      const closed = stack.pop();
      if (name === undefined || closed?.name !== name) throw new NotXml(`a stray </${name}>`);
      at += 2 + name.length;
      const rest = /^\s*>/.exec(text.slice(at));
      if (rest === null) throw new NotXml(`an unclosed </${name}`);
      at += rest[0].length;
    } else {
      const name = NAME.exec(text.slice(at + 1))?.[0];
      if (name === undefined) throw new NotXml('a < that starts no element');
      at += 1 + name.length;
      const attributes = new Map<string, string>();
      for (let attribute = ATTRIBUTE.exec(text.slice(at)); attribute !== null; ) {
        const [whole, key = '', , double, single] = attribute;
        attributes.set(key, decode(double ?? single ?? ''));
        at += whole.length;
        attribute = ATTRIBUTE.exec(text.slice(at));
      }
      const end = /^\s*(\/?)>/.exec(text.slice(at));
      if (end === null) throw new NotXml(`an unclosed <${name}`);
      at += end[0].length;
      const element: Element = { name, attributes, children: [] };
      if (parent === undefined) {
        if (root !== undefined) throw new NotXml('a second root element');
        root = element;
      } else {
        parent.children.push(element);
      }
      if (end[1] !== '/') stack.push(element);
    }
  }
  if (stack.length > 0) throw new NotXml(`an unclosed <${stack.at(-1)?.name}>`);
  if (root === undefined) throw new NotXml('no root element');
  return root;
}

const elements = (element: Element): Element[] =>
  element.children.filter((child): child is Element => typeof child !== 'string');

/** All the text inside `element`, its children's included. */
const textOf = (element: Element): string =>
  element.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');

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
  return { name: element.attributes.get('name') ?? '', result, leaf: true, detail };
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
