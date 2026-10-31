// A small XML reader for the reports Foedrum reads (JUnit, Cobertura): elements, attributes, text
// and CDATA, with no DOCTYPE subset and no entities beyond XML's own. Pure.

export interface Element {
  name: string;
  attributes: ReadonlyMap<string, string>;
  children: (Element | string)[];
}

export class NotXml extends Error {}

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
/** Deeper reports are refused before the readers that recurse over them can overflow the stack. */
const MAX_DEPTH = 256;
const ATTRIBUTE = /^\s+([A-Za-z_:][\w.:-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/;

/** The root element of `text`; throws NotXml when it is not well-formed. */
export function readXml(text: string): Element {
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
      if (end[1] !== '/') {
        if (stack.length >= MAX_DEPTH) throw new NotXml(`nested deeper than ${MAX_DEPTH} elements`);
        stack.push(element);
      }
    }
  }
  if (stack.length > 0) throw new NotXml(`an unclosed <${stack.at(-1)?.name}>`);
  if (root === undefined) throw new NotXml('no root element');
  return root;
}

export const elements = (element: Element): Element[] =>
  element.children.filter((child): child is Element => typeof child !== 'string');

/** All the text inside `element`, its children's included. */
export const textOf = (element: Element): string =>
  element.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
