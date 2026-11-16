// The Flight's orders in tasting-room/ (ADR 0404): each order's files read and checked, the
// trees its proof lays down, and what a proof run's exit means. The proof itself runs in
// test/integration/flight-orders.test.ts. When #1083 comes, the Flight's runner will build its
// target from the same starting tree and lay the hidden tests over a brewed head with `withLayer`.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { withoutBom } from '../src/formats/manifest-reader.ts';
import { z } from '../src/schemas/zod.ts';

/** Files by their path from a folder, with `/` between its parts, and their text. */
export type Files = Readonly<Record<string, string>>;

export const TRAP_KINDS = ['house-rule', 'design-page', 'edge-case'] as const;
export type TrapKind = (typeof TRAP_KINDS)[number];

/** An order of the Flight, read from its folder. */
export interface FlightOrder {
  /** Its folder's name. */
  name: string;
  /** The first line of order.md. */
  title: string;
  /** order.md as a whole: the issue text, the only file a brewer is to get once #1083 brews it. */
  text: string;
  trap: { kind: TrapKind; line: string };
  /** Path prefixes the change may touch; one that ends in `/` is a folder. */
  allowedPaths: readonly string[];
  base: Files;
  solution: Files;
  hidden: Files;
}

/** One run of an order's proof: its hidden tests on a tree, and whether they must fail or pass. */
export interface ProofRun {
  expect: 'fail' | 'pass';
  tree: Files;
  /** The hidden test files, as `node --test` takes them from the tree's root. */
  tests: readonly string[];
}

/**
 * The name a base's instruction file is kept under in the fixtures, so no Foedrum session or
 * review loads a fixture's rules as its own; a laid-down tree holds it as `CLAUDE.md`.
 */
export const INSTRUCTIONS_FILE = 'INSTRUCTIONS.fixture.md';

/** Where every hidden test sits in a tree, so none replaces a test a brewer wrote. */
export const HIDDEN_FOLDER = 'test/hidden/';

const OrderJson = z.object({
  trap: z.object({ kind: z.enum(TRAP_KINDS), line: z.string().min(1) }),
  allowedPaths: z.array(z.string().min(1)).min(1),
});

/** The files of `files` under `folder`, by their path from it. */
const under = (files: Files, folder: string): Files =>
  Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => path.startsWith(folder))
      .map(([path, text]) => [path.slice(folder.length), text]),
  );

/** order.json's fields, or the problem with it. */
const orderJsonOf = (text: string | undefined): z.infer<typeof OrderJson> | string => {
  if (text === undefined) return 'no order.json';
  try {
    const read = OrderJson.safeParse(JSON.parse(withoutBom(text)));
    return read.success
      ? read.data
      : `order.json ${z.prettifyError(read.error).replaceAll('\n', ' ')}`;
  } catch (error) {
    return `order.json is not JSON: ${(error as Error).message}`;
  }
};

/** The order `name` read from its folder's `files`; throws with every problem, one per line. */
export const readOrder = (name: string, files: Files): FlightOrder => {
  const md = files['order.md'];
  const text = md === undefined ? undefined : withoutBom(md);
  const json = orderJsonOf(files['order.json']);
  const base = under(files, 'base/');
  const solution = under(files, 'solution/');
  const hidden = under(files, 'hidden/');
  const problems = [
    ...(text === undefined ? ['no order.md'] : []),
    ...(typeof json === 'string' ? [json] : []),
    ...(Object.keys(base).length === 0 ? ['no base/'] : []),
    ...(Object.keys(solution).length === 0 ? ['no solution/'] : []),
    ...(Object.keys(hidden).length === 0 ? ['no hidden/'] : []),
    ...Object.keys(hidden)
      .filter((path) => !path.startsWith(HIDDEN_FOLDER))
      .map((path) => `hidden/${path} is not under ${HIDDEN_FOLDER}`),
  ];
  if (text === undefined || typeof json === 'string' || problems.length > 0) {
    throw new Error(problems.map((problem) => `${name}: ${problem}`).join('\n'));
  }
  return {
    name,
    title: text.split(/\r?\n/, 1)[0] ?? '',
    text,
    trap: json.trap,
    allowedPaths: json.allowedPaths,
    base,
    solution,
    hidden,
  };
};

/** `tree` with `layer`'s files added or replaced, its instruction file as `CLAUDE.md`. */
export const withLayer = (tree: Files, layer: Files): Files => ({
  ...tree,
  ...Object.fromEntries(
    Object.entries(layer).map(([path, text]) => [
      path === INSTRUCTIONS_FILE ? 'CLAUDE.md' : path,
      text,
    ]),
  ),
});

/** The repository a brewer starts from: the order's base, laid down. */
export const startingTree = (order: FlightOrder): Files => withLayer({}, order.base);

/** The order's two proof runs: its hidden tests fail on the base and pass with its solution. */
export const proofRuns = (order: FlightOrder): readonly ProofRun[] => {
  const start = startingTree(order);
  const tests = Object.keys(order.hidden).sort();
  return [
    { expect: 'fail', tree: withLayer(start, order.hidden), tests },
    { expect: 'pass', tree: withLayer(withLayer(start, order.solution), order.hidden), tests },
  ];
};

/** What is wrong with `run` when its tests exited with `exitCode`, or undefined when nothing is. */
export const proofProblem = (run: ProofRun, exitCode: number | null): string | undefined => {
  if (exitCode === null) return 'the hidden tests did not finish';
  if (run.expect === 'fail' && exitCode === 0) {
    return 'the hidden tests pass on the starting repository';
  }
  if (run.expect === 'pass' && exitCode !== 0) {
    return 'the hidden tests fail with the reference solution';
  }
  return undefined;
};

/** The tasting room's folder of orders, the one place a reader of the orders finds them. */
export const TASTING_ROOM = join(import.meta.dirname, '..', 'tasting-room');

/** The files under `folder`, by their path from it. */
export const folderFiles = (folder: string): Files =>
  Object.fromEntries(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [relative(folder, file).split(sep).join('/'), readFileSync(file, 'utf8')];
      }),
  );

/** Every order of the tasting room, read from its folder in the order of their names. */
export const tastingRoomOrders = (): FlightOrder[] =>
  readdirSync(TASTING_ROOM, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => readOrder(name, folderFiles(join(TASTING_ROOM, name))));
