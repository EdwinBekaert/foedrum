// Cobertura XML as a coverage report (ADR 0274): each class's file under a `<source>`, and its
// `line` elements with their hits and `condition-coverage`. Pure.

import {
  addLine,
  type CoveredLine,
  linesOf,
  type ReadCoverage,
  reportPath,
} from './coverage-report.ts';
import { type Element, elements, NotXml, readXml, textOf } from './xml.ts';

/** Every element named `name` under `element`, in document order. */
const descendants = (element: Element, name: string): Element[] =>
  elements(element).flatMap((child) =>
    child.name === name ? [child, ...descendants(child, name)] : descendants(child, name),
  );

const COUNT = /^\d+$/;
// `50% (1/2)`: the branches taken of the line's branches.
const CONDITIONS = /\((\d+)\/(\d+)\)$/;

/**
 * A class's file relative to `root`, or undefined outside it. Its filename is relative to one of
 * the `<source>`s. With several (coverlet adds `C:\` when it also measures the test assembly), a
 * filename may land inside `root` under more than one, so the one whose file `exists` there wins.
 */
function fileOf(
  filename: string,
  sources: readonly string[],
  root: string,
  exists: (file: string) => boolean,
): string | undefined {
  if (sources.length === 0) return reportPath(filename, root);
  const inside = sources
    .map((source) => reportPath(`${source}/${filename}`, root))
    .filter((file) => file !== undefined);
  return sources.length === 1 ? inside[0] : inside.find(exists);
}

/** The lines of a Cobertura report, its paths relative to `root`, or why it is not one. */
export function parseCobertura(
  text: string,
  root: string,
  exists: (file: string) => boolean = () => true,
): ReadCoverage {
  let coverage: Element;
  try {
    coverage = readXml(text.replace(/^﻿/, ''));
  } catch (error) {
    if (!(error instanceof NotXml)) throw error;
    return { readable: false, reason: `it is not XML: ${error.message}` };
  }
  if (coverage.name !== 'coverage') {
    return {
      readable: false,
      reason: `its root element <${coverage.name}> is no Cobertura report`,
    };
  }
  const sources = descendants(coverage, 'source').map((source) => textOf(source).trim());
  const files = new Map<string, Map<number, CoveredLine>>();
  // A file in several classes (partial, nested, compiler-made) takes the most hits per line.
  for (const element of descendants(coverage, 'class')) {
    const filename = element.attributes.get('filename');
    const file = filename === undefined ? undefined : fileOf(filename, sources, root, exists);
    if (file === undefined) continue;
    const lines = linesOf(files, file);
    for (const line of descendants(element, 'line')) {
      const number = line.attributes.get('number') ?? '';
      const hits = line.attributes.get('hits') ?? '';
      if (!COUNT.test(number) || !COUNT.test(hits)) {
        return {
          readable: false,
          reason: `its <line number="${number}" hits="${hits}"> is not Cobertura`,
        };
      }
      const [, taken, total] =
        CONDITIONS.exec(line.attributes.get('condition-coverage') ?? '') ?? [];
      addLine(
        lines,
        Number(number),
        taken === undefined || total === undefined
          ? { hits: Number(hits) }
          : { hits: Number(hits), branches: { taken: Number(taken), total: Number(total) } },
      );
    }
  }
  return { readable: true, report: files };
}
