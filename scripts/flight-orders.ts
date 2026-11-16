// The Flight's orders in test/fixtures/flight/ (ADR 0404): each order's files read and checked, the
// trees its proof lays down, and what a proof run's exit means. The proof itself runs in
// test/integration/flight-orders.test.ts; the Flight's runner (#1083) builds its target from the
// same starting tree and lays the hidden tests over a brewed head with `withLayer`.

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
  /** order.md as a whole: the issue text a brewer gets, and the only file it gets. */
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

/** The order `name` read from its folder's `files`; throws with every problem, one per line. */
export const readOrder = (_name: string, _files: Files): FlightOrder => {
  throw new Error('not implemented');
};

/** `tree` with `layer`'s files added or replaced, its instruction file as `CLAUDE.md`. */
export const withLayer = (_tree: Files, _layer: Files): Files => {
  throw new Error('not implemented');
};

/** The repository a brewer starts from: the order's base, laid down. */
export const startingTree = (order: FlightOrder): Files => withLayer({}, order.base);

/** The order's two proof runs: its hidden tests fail on the base and pass with its solution. */
export const proofRuns = (_order: FlightOrder): readonly ProofRun[] => {
  throw new Error('not implemented');
};

/** What is wrong with `run` when its tests exited with `exitCode`, or undefined when nothing is. */
export const proofProblem = (_run: ProofRun, _exitCode: number | null): string | undefined => {
  throw new Error('not implemented');
};

/** The files under `folder`, by their path from it. */
export const folderFiles = (_folder: string): Files => {
  throw new Error('not implemented');
};
